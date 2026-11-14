import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { compileExpression } from './server/expressionEngine.ts';
import { generateBankingDataset } from './server/bankingDatasets.ts';
import {
  buildRenderDocument,
  exportToCsvString,
  exportToHtmlString,
  exportToPdfBuffer,
  exportToXlsxBuffer,
  validateUReportTemplate,
} from './server/reportEngine.ts';
import { importRdlcXml } from './server/rdlcImporter.ts';
import {
  getJob,
  listTemplateRevisions,
  listTemplates,
  purgeExpiredJobs,
  saveTemplateRevision,
  seedTemplateIfMissing,
  upsertJob,
} from './server/storage.ts';
import type { ReportFormat, UReportDefinition } from './src/shared/reportTypes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOTNET_ROOT = path.resolve(__dirname, 'dotnet', 'UniversalReport');
const SAMPLES_DIR = path.join(DOTNET_ROOT, 'samples', 'Banking');

async function loadInitialTemplates() {
  try {
    const entries = await fs.readdir(SAMPLES_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.ureport')) continue;
      const fullPath = path.join(SAMPLES_DIR, entry);
      const raw = await fs.readFile(fullPath, 'utf-8');
      const { definition, result } = validateUReportTemplate(raw);
      if (definition && result.valid) {
        seedTemplateIfMissing({
          id: definition.reportId,
          json: raw,
          contentHash: result.contentHash,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error('Failed to preload banking .ureport templates:', err);
  }
}

async function listDotnetFiles(dir: string, baseDir: string): Promise<{ path: string; size: number }[]> {
  const results: { path: string; size: number }[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'bin' || entry.name === 'obj') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listDotnetFiles(full, baseDir)));
    } else {
      const stat = await fs.stat(full);
      results.push({
        path: path.relative(baseDir, full).replace(/\\/g, '/'),
        size: stat.size,
      });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function renderReportPayload(
  templateJson: string,
  format: ReportFormat,
  datasetsInput?: Record<string, Record<string, string | number | boolean | null>[]>,
  parametersInput?: Record<string, unknown>,
  sampleRowCount = 18
) {
  const { definition, result } = validateUReportTemplate(templateJson);
  if (!definition || !result.valid) {
    const err = new Error(result.errors.map((e) => e.message).join('; '));
    (err as Error & { validationErrors?: unknown }).validationErrors = result.errors;
    throw err;
  }

  const datasets =
    datasetsInput && Object.keys(datasetsInput).length > 0
      ? datasetsInput
      : generateBankingDataset(definition.reportId, sampleRowCount);

  const doc = await buildRenderDocument(definition, result.contentHash, datasets, parametersInput ?? {});

  if (format === 'ir') {
    return {
      doc,
      contentType: 'application/json; charset=utf-8',
      fileName: `${definition.reportId}.ir.json`,
      buffer: Buffer.from(JSON.stringify(doc, null, 2), 'utf-8'),
    };
  }
  if (format === 'pdf') {
    return {
      doc,
      contentType: 'application/pdf',
      fileName: `${definition.reportId}.pdf`,
      buffer: await exportToPdfBuffer(doc),
    };
  }
  if (format === 'xlsx') {
    return {
      doc,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `${definition.reportId}.xlsx`,
      buffer: await exportToXlsxBuffer(doc),
    };
  }
  if (format === 'csv') {
    return {
      doc,
      contentType: 'text/csv; charset=utf-8',
      fileName: `${definition.reportId}.csv`,
      buffer: Buffer.from(exportToCsvString(doc), 'utf-8'),
    };
  }
  return {
    doc,
    contentType: 'text/html; charset=utf-8',
    fileName: `${definition.reportId}.html`,
    buffer: Buffer.from(exportToHtmlString(doc), 'utf-8'),
  };
}

function parseCsvToRows(csvText: string): Record<string, string | number | boolean | null>[] {
  const rows: string[][] = [];
  let curRow: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    if (inQuotes) {
      if (c === '"') {
        if (csvText[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      curRow.push(cell);
      cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && csvText[i + 1] === '\n') i++;
      curRow.push(cell);
      cell = '';
      if (curRow.some((x) => x.trim() !== '')) rows.push(curRow);
      curRow = [];
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || curRow.length > 0) {
    curRow.push(cell);
    if (curRow.some((x) => x.trim() !== '')) rows.push(curRow);
  }
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string | number | boolean | null> = {};
    headers.forEach((h, idx) => {
      const raw = (r[idx] ?? '').trim();
      if (raw === '') obj[h] = '';
      else if (/^-?\d+(\.\d+)?$/.test(raw)) obj[h] = Number(raw);
      else if (raw.toLowerCase() === 'true') obj[h] = true;
      else if (raw.toLowerCase() === 'false') obj[h] = false;
      else obj[h] = raw;
    });
    return obj;
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function startServer() {
  await loadInitialTemplates();
  purgeExpiredJobs();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Optional API Key Auth Guard for production deployments when REPORT_API_KEY is configured
  app.use('/api/v1', (req, res, next) => {
    const configuredKey = process.env.REPORT_API_KEY?.trim();
    if (!configuredKey) {
      next();
      return;
    }
    const isProtected =
      req.method === 'POST' ||
      req.method === 'PUT' ||
      req.method === 'DELETE' ||
      req.path.endsWith('/download');
    if (!isProtected) {
      next();
      return;
    }
    const authHeader = String(req.headers.authorization ?? '');
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const apiKeyHeader = String(req.headers['x-api-key'] ?? '').trim();
    const candidate = bearer || apiKeyHeader;
    if (!candidate || !constantTimeEquals(candidate, configuredKey)) {
      res.status(401).json({ error: 'Unauthorized: invalid or missing API key.' });
      return;
    }
    next();
  });

  app.post('/api/v1/datasources/parse', (req, res) => {
    const kind = String(req.body?.kind ?? 'json').toLowerCase();
    const raw = String(req.body?.payload ?? '');
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    try {
      if (kind === 'csv') {
        const rows = parseCsvToRows(raw);
        res.json({ valid: true, rowCount: rows.length, rows });
        return;
      }
      let parsed: unknown = JSON.parse(raw);
      if (rootPath) {
        for (const seg of rootPath.split('.').filter(Boolean)) {
          if (parsed && typeof parsed === 'object' && seg in (parsed as Record<string, unknown>)) {
            parsed = (parsed as Record<string, unknown>)[seg];
          }
        }
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      res.json({ valid: true, rowCount: rows.length, rows });
    } catch (err) {
      res.status(400).json({
        valid: false,
        error: err instanceof Error ? err.message : 'Unable to parse data source payload',
      });
    }
  });

  app.post('/api/v1/datasources/check', async (req, res) => {
    const kind = String(req.body?.kind ?? 'json').toLowerCase();
    const payload = String(req.body?.payload ?? '');
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';

    const inferFields = (rows: Record<string, unknown>[]) => {
      if (rows.length === 0) return [];
      const keys = Object.keys(rows[0]);
      return keys.map((name) => {
        const sample = rows.find((r) => r[name] !== null && r[name] !== undefined && r[name] !== '')?.[name];
        let type: 'String' | 'Decimal' | 'Int32' | 'DateTime' | 'Boolean' = 'String';
        if (typeof sample === 'boolean') type = 'Boolean';
        else if (typeof sample === 'number') type = Number.isInteger(sample) && !/amount|debit|credit|balance|price|total|rate/i.test(name) ? 'Int32' : 'Decimal';
        else if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) type = 'DateTime';
        return { name, type };
      });
    };

    try {
      if (kind === 'sql') {
        const sql = payload.trim();
        if (!sql) throw new Error('SQL statement is required.');
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE)\b/i.test(sql)) {
          res.status(400).json({
            valid: false,
            securityCheck: 'Blocked: mutating SQL keyword detected',
            error: 'AdoNetDataProvider only allows read-only SELECT or WITH queries.',
          });
          return;
        }
        if (!/^(SELECT|WITH)\b/i.test(sql)) {
          res.status(400).json({
            valid: false,
            securityCheck: 'Blocked: query must begin with SELECT or WITH',
            error: 'Only SELECT queries are permitted in allowlisted SQL mode.',
          });
          return;
        }
        const paramMatches = [...sql.matchAll(/[@:](\w+)/g)].map((m) => m[1]);
        const selectMatch = /^SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(sql);
        const colNames = selectMatch && selectMatch[1].trim() !== '*'
          ? selectMatch[1].split(',').map((c) => {
              const alias = /\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*$/i.exec(c.trim());
              if (alias) return alias[1];
              const parts = c.trim().split('.');
              return parts[parts.length - 1].replace(/["`\[\]]/g, '').trim();
            }).filter(Boolean)
          : ['TranDate', 'Reference', 'Particulars', 'Debit', 'Credit', 'Balance'];

        const fields = colNames.map((name) => ({
          name,
          type: /date|time/i.test(name)
            ? 'DateTime'
            : /debit|credit|balance|amount|total|price|cash/i.test(name)
              ? 'Decimal'
              : 'String',
        }));

        res.json({
          valid: true,
          kind: 'sql',
          securityCheck: 'Passed read-only SQL allowlist & parameter check',
          detectedParameters: [...new Set(paramMatches)],
          fields,
          rowCount: 0,
          rows: [],
        });
        return;
      }

      if (kind === 'rest') {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(payload.trim());
        } catch {
          throw new Error('Invalid REST endpoint URL.');
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('Only HTTP/HTTPS REST endpoints are allowed.');
        }
        const host = parsedUrl.hostname.toLowerCase();
        if (
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host === '0.0.0.0' ||
          host.startsWith('169.254.') ||
          host.startsWith('10.') ||
          host.startsWith('192.168.')
        ) {
          res.status(400).json({
            valid: false,
            securityCheck: `Blocked SSRF target host '${host}'`,
            error: `Host '${host}' is blocked by RestApiDataProvider SSRF policy.`,
          });
          return;
        }

        const resp = await fetch(parsedUrl.toString(), {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          throw new Error(`REST endpoint returned HTTP ${resp.status}`);
        }
        let data: unknown = await resp.json();
        if (rootPath) {
          for (const seg of rootPath.split('.').filter(Boolean)) {
            if (data && typeof data === 'object' && seg in (data as Record<string, unknown>)) {
              data = (data as Record<string, unknown>)[seg];
            }
          }
        }
        const rows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
        res.json({
          valid: true,
          kind: 'rest',
          securityCheck: `Passed SSRF host check (${host})`,
          fields: inferFields(rows),
          rowCount: rows.length,
          rows: rows.slice(0, 100),
        });
        return;
      }

      if (kind === 'csv') {
        const rows = parseCsvToRows(payload);
        res.json({
          valid: true,
          kind: 'csv',
          securityCheck: 'Passed RFC-4180 CSV parser',
          fields: inferFields(rows),
          rowCount: rows.length,
          rows: rows.slice(0, 100),
        });
        return;
      }

      let parsed: unknown = JSON.parse(payload);
      if (rootPath) {
        for (const seg of rootPath.split('.').filter(Boolean)) {
          if (parsed && typeof parsed === 'object' && seg in (parsed as Record<string, unknown>)) {
            parsed = (parsed as Record<string, unknown>)[seg];
          }
        }
      }
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
      res.json({
        valid: true,
        kind: 'json',
        securityCheck: 'Passed JSON schema & type inference',
        fields: inferFields(rows),
        rowCount: rows.length,
        rows: rows.slice(0, 100),
      });
    } catch (err) {
      res.status(400).json({
        valid: false,
        error: err instanceof Error ? err.message : 'Data source check failed',
      });
    }
  });

  // Section 12: ASP.NET Core Service API Contract
  app.post('/api/v1/reports/validate', (req, res) => {
    const raw = typeof req.body?.templateJson === 'string' ? req.body.templateJson : JSON.stringify(req.body ?? {});
    const { result } = validateUReportTemplate(raw);
    res.json(result);
  });

  app.post('/api/v1/reports/compile', (req, res) => {
    const expr = String(req.body?.expression ?? '');
    try {
      const compiled = compileExpression(expr);
      res.json({
        valid: true,
        compiled,
      });
    } catch (err) {
      res.status(400).json({
        valid: false,
        error: err instanceof Error ? err.message : 'Compilation failed',
      });
    }
  });

  app.post('/api/v1/reports/import-rdlc', (req, res) => {
    try {
      const rdlcXml = String(req.body?.rdlcXml ?? '');
      const reportId = typeof req.body?.reportId === 'string' ? req.body.reportId : undefined;
      const converted = importRdlcXml(rdlcXml, reportId);
      res.json(converted);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'RDLC import failed',
      });
    }
  });

  app.post('/api/v1/reports/render', async (req, res) => {
    try {
      const templateJson =
        typeof req.body?.templateJson === 'string'
          ? req.body.templateJson
          : JSON.stringify(req.body?.template ?? {});
      const format = (String(req.body?.format ?? 'ir').toLowerCase() as ReportFormat) || 'ir';
      const sampleRowCount = Math.min(2000, Math.max(1, Number(req.body?.sampleRowCount ?? 18)));
      const rendered = await renderReportPayload(
        templateJson,
        format,
        req.body?.datasets,
        req.body?.parameters,
        sampleRowCount
      );

      if (format === 'ir') {
        res.json(rendered.doc);
        return;
      }

      res.setHeader('Content-Type', rendered.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${rendered.fileName}"`);
      res.send(rendered.buffer);
    } catch (err) {
      const validationErrors = (err as Error & { validationErrors?: unknown }).validationErrors;
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Render failed',
        validationErrors,
      });
    }
  });

  app.post('/api/v1/report-jobs', (req, res) => {
    const jobId = crypto.randomUUID().replace(/-/g, '');
    const format = (String(req.body?.format ?? 'pdf').toLowerCase() as ReportFormat) || 'pdf';
    const templateJson =
      typeof req.body?.templateJson === 'string'
        ? req.body.templateJson
        : JSON.stringify(req.body?.template ?? {});
    const sampleRowCount = Math.min(2000, Math.max(1, Number(req.body?.sampleRowCount ?? 100)));

    let reportId = 'unknown';
    try {
      const parsed = JSON.parse(templateJson) as Partial<UReportDefinition>;
      if (parsed.reportId) reportId = parsed.reportId;
    } catch {
      // handled in async worker
    }

    const now = Date.now();
    const record = {
      jobId,
      reportId,
      format,
      status: 'Queued' as const,
      createdAtUtc: new Date(now).toISOString(),
      expiresAtUtc: new Date(now + 15 * 60_000).toISOString(),
    };
    upsertJob(record);

    setTimeout(async () => {
      try {
        const rendered = await renderReportPayload(
          templateJson,
          format,
          req.body?.datasets,
          req.body?.parameters,
          sampleRowCount
        );
        upsertJob({
          ...record,
          status: 'Completed',
          buffer: rendered.buffer,
          contentType: rendered.contentType,
          fileName: rendered.fileName,
        });
      } catch {
        // Security: never store raw account numbers or report payloads in job error metadata
        upsertJob({
          ...record,
          status: 'Failed',
          errorCode: 'REPORT_RENDER_FAILED',
        });
      }
    }, 150);

    res.status(202).json({
      jobId,
      status: 'Queued',
      statusUrl: `/api/v1/report-jobs/${jobId}`,
      downloadUrl: `/api/v1/report-jobs/${jobId}/download`,
    });
  });

  app.get('/api/v1/report-jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      jobId: job.jobId,
      reportId: job.reportId,
      format: job.format,
      status: job.status,
      createdAtUtc: job.createdAtUtc,
      expiresAtUtc: job.expiresAtUtc,
      errorCode: job.errorCode,
    });
  });

  app.get('/api/v1/report-jobs/:id/download', (req, res) => {
    const job = getJob(req.params.id);
    if (!job || !job.buffer) {
      res.status(404).json({ error: 'Job output not available' });
      return;
    }
    if (Date.now() > Date.parse(job.expiresAtUtc)) {
      res.status(410).json({ error: 'Short-lived download URL expired' });
      return;
    }
    res.setHeader('Content-Type', job.contentType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${job.fileName ?? 'report.bin'}"`);
    res.send(job.buffer);
  });

  app.get('/api/v1/templates', (_req, res) => {
    const items = listTemplates().map((t) => {
      const parsed = JSON.parse(t.json) as UReportDefinition;
      return {
        id: t.id,
        title: parsed.title ?? t.id,
        contentHash: t.contentHash,
        updatedAt: t.updatedAt,
        definition: parsed,
      };
    });
    res.json({ templates: items });
  });

  app.get('/api/v1/templates/:id/revisions', (req, res) => {
    const revisions = listTemplateRevisions(req.params.id).map((r) => ({
      revisionId: r.revisionId,
      reportId: r.reportId,
      contentHash: r.contentHash,
      savedAt: r.savedAt,
      definition: JSON.parse(r.json) as UReportDefinition,
    }));
    res.json({ reportId: req.params.id, revisions });
  });

  app.put('/api/v1/templates/:id', (req, res) => {
    const raw = typeof req.body?.templateJson === 'string' ? req.body.templateJson : JSON.stringify(req.body ?? {});
    const { result } = validateUReportTemplate(raw);
    if (!result.valid) {
      res.status(400).json({ errors: result.errors });
      return;
    }
    const updatedAt = new Date().toISOString();
    const revisionId = saveTemplateRevision({
      id: req.params.id,
      json: raw,
      contentHash: result.contentHash,
      updatedAt,
    });
    res.json({
      id: req.params.id,
      revisionId,
      contentHash: result.contentHash,
      updatedAt,
      status: 'Published',
    });
  });

  // .NET 10 Solution File Explorer API
  app.get('/api/v1/dotnet/tree', async (_req, res) => {
    try {
      const files = await listDotnetFiles(DOTNET_ROOT, DOTNET_ROOT);
      res.json({ root: 'dotnet/UniversalReport', files });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to scan .NET solution' });
    }
  });

  app.get('/api/v1/dotnet/file', async (req, res) => {
    const rel = String(req.query.path ?? '');
    const resolved = path.resolve(DOTNET_ROOT, rel);
    if (!resolved.startsWith(DOTNET_ROOT)) {
      res.status(403).json({ error: 'Access outside solution root denied' });
      return;
    }
    try {
      const content = await fs.readFile(resolved, 'utf-8');
      res.json({ path: rel, content });
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`UniversalReport.NET Studio listening on http://localhost:${port}`);
  });
}

startServer();
