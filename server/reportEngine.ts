import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';
import type {
  BandDefinition,
  ElementDefinition,
  PositionedDrawNode,
  RenderDocument,
  RenderPage,
  ReportError,
  SemanticTable,
  UReportDefinition,
  ValidationResult,
} from '../src/shared/reportTypes.ts';
import {
  compileExpression,
  evaluateExpression,
  formatTypedValue,
  roundDecimal,
  type EvaluationContext,
} from './expressionEngine.ts';
import type { DataRow } from './bankingDatasets.ts';

const ALLOWED_BANDS = new Set([
  'ReportHeader',
  'PageHeader',
  'GroupHeader',
  'Detail',
  'GroupFooter',
  'ReportFooter',
  'PageFooter',
]);

const ALLOWED_ELEMENTS = new Set(['Text', 'Table', 'Line', 'Rectangle', 'Image', 'QrCode']);

export function validateUReportTemplate(rawJson: string): {
  definition: UReportDefinition | null;
  result: ValidationResult;
} {
  const errors: ReportError[] = [];
  const contentHash = crypto.createHash('sha256').update(rawJson || '').digest('hex');

  if (!rawJson || !rawJson.trim()) {
    errors.push({ code: 'UREPORT_EMPTY', message: 'Template payload must not be empty.' });
    return { definition: null, result: { valid: false, contentHash, errors } };
  }

  let def: UReportDefinition;
  try {
    def = JSON.parse(rawJson) as UReportDefinition;
  } catch (err) {
    errors.push({
      code: 'UREPORT_JSON_INVALID',
      message: err instanceof Error ? err.message : 'Invalid JSON.',
    });
    return { definition: null, result: { valid: false, contentHash, errors } };
  }

  if (def.schemaVersion !== '1.0') {
    errors.push({
      code: 'UREPORT_SCHEMA_VERSION',
      message: `Unsupported schemaVersion '${String(def.schemaVersion)}'. Expected '1.0'.`,
      path: 'schemaVersion',
    });
  }

  if (!def.reportId || typeof def.reportId !== 'string') {
    errors.push({ code: 'UREPORT_ID_REQUIRED', message: 'reportId is required.', path: 'reportId' });
  }

  if (!Array.isArray(def.bands) || def.bands.length === 0) {
    errors.push({ code: 'UREPORT_BANDS_EMPTY', message: 'At least one band is required.', path: 'bands' });
  } else {
    def.bands.forEach((band, bi) => {
      if (!ALLOWED_BANDS.has(band.type)) {
        errors.push({ code: 'UREPORT_BAND_TYPE', message: `Unsupported band type '${band.type}'.`, path: `bands[${bi}].type` });
      }
      if (!Array.isArray(band.elements)) return;
      band.elements.forEach((el, ei) => {
        if (!ALLOWED_ELEMENTS.has(el.type)) {
          errors.push({ code: 'UREPORT_ELEMENT_TYPE', message: `Unsupported element type '${el.type}'.`, path: `bands[${bi}].elements[${ei}].type` });
        }
        if (
          el.type === 'Image' &&
          el.value &&
          /^(https?:\/\/|file:\/\/)/i.test(el.value)
        ) {
          errors.push({
            code: 'UREPORT_RESOURCE_ISOLATION',
            message: 'External URLs and local file:// paths are blocked in sandboxed templates.',
            path: `bands[${bi}].elements[${ei}].value`,
          });
        }

        const exprs = [el.expression, ...(el.columns?.map((c) => c.expression) ?? [])].filter(Boolean) as string[];
        for (const expr of exprs) {
          if (expr.startsWith('=')) {
            try {
              compileExpression(expr);
            } catch (e) {
              errors.push({
                code: 'UREPORT_EXPR_INVALID',
                message: e instanceof Error ? e.message : 'Invalid expression',
                path: `bands[${bi}].elements[${ei}]`,
              });
            }
          }
        }
      });
    });
  }

  return {
    definition: errors.length === 0 ? def : null,
    result: { valid: errors.length === 0, contentHash, reportId: def.reportId, errors },
  };
}

function resolvePageDimensionsMm(def: UReportDefinition): { widthMm: number; heightMm: number } {
  const size = (def.page?.size ?? 'A4').toUpperCase();
  let baseW = 210;
  let baseH = 297;
  if (size === 'LETTER') {
    baseW = 215.9;
    baseH = 279.4;
  } else if (size === 'LEGAL') {
    baseW = 215.9;
    baseH = 355.6;
  } else if (size === 'CUSTOM') {
    baseW = def.page?.width ?? 210;
    baseH = def.page?.height ?? 297;
  }
  return def.page?.orientation === 'Landscape'
    ? { widthMm: baseH, heightMm: baseW }
    : { widthMm: baseW, heightMm: baseH };
}

function createEvalContext(
  datasets: Record<string, DataRow[]>,
  parameters: Record<string, unknown>
) {
  let currentDataset = '';
  let currentRow: DataRow | null = null;
  let currentIndex = -1;
  let activeGroupRows: DataRow[] | null = null;
  let pageNumber = 1;
  let totalPages = 1;

  const ctx: EvaluationContext & {
    setRow: (ds: string, row: DataRow, idx: number, groupRows?: DataRow[] | null) => void;
    setGroupScope: (ds: string, groupRows: DataRow[] | null) => void;
    setPageInfo: (p: number, tot: number) => void;
  } = {
    setRow(ds, row, idx, groupRows = null) {
      currentDataset = ds;
      currentRow = row;
      currentIndex = idx;
      activeGroupRows = groupRows;
    },
    setGroupScope(ds, groupRows) {
      currentDataset = ds;
      activeGroupRows = groupRows;
      currentRow = groupRows && groupRows.length > 0 ? groupRows[0] : null;
      currentIndex = 0;
    },
    setPageInfo(p, tot) {
      pageNumber = p;
      totalPages = tot;
    },
    getField(name) {
      if (!currentRow) return null;
      if (name in currentRow) return currentRow[name];
      const matchKey = Object.keys(currentRow).find((k) => k.toLowerCase() === name.toLowerCase());
      return matchKey ? currentRow[matchKey] : null;
    },
    getParameter(name) {
      if (name in parameters) return parameters[name];
      const matchKey = Object.keys(parameters).find((k) => k.toLowerCase() === name.toLowerCase());
      return matchKey ? parameters[matchKey] : null;
    },
    getGlobal(name) {
      const lower = name.toLowerCase();
      if (lower === 'pagenumber') return pageNumber;
      if (lower === 'totalpages') return totalPages;
      if (lower === 'executiontime') return new Date().toISOString();
      return null;
    },
    computeSum(field, scope) {
      const useGroup = scope?.toLowerCase() === 'group' || (!scope && activeGroupRows !== null);
      const rows = useGroup ? (activeGroupRows ?? []) : (datasets[scope || currentDataset] ?? []);
      let sum = 0;
      for (const r of rows) sum = roundDecimal(sum + Number(r[field] ?? 0), 4);
      return roundDecimal(sum, 2);
    },
    computeCount(scope) {
      const useGroup = scope?.toLowerCase() === 'group' || (!scope && activeGroupRows !== null);
      const rows = useGroup ? (activeGroupRows ?? []) : (datasets[scope || currentDataset] ?? []);
      return rows.length;
    },
    computeRunningValue(field) {
      const rows = activeGroupRows ?? (datasets[currentDataset] ?? []);
      if (currentIndex < 0) return 0;
      let sum = 0;
      for (let i = 0; i <= Math.min(currentIndex, rows.length - 1); i++) {
        sum = roundDecimal(sum + Number(rows[i][field] ?? 0), 4);
      }
      return roundDecimal(sum, 2);
    },
  };

  return ctx;
}

export async function buildRenderDocument(
  def: UReportDefinition,
  contentHash: string,
  datasets: Record<string, DataRow[]>,
  parameters: Record<string, unknown>
): Promise<RenderDocument> {
  const start = performance.now();
  const resolvedParams: Record<string, unknown> = {};
  for (const p of def.parameters ?? []) {
    resolvedParams[p.name] = p.defaultValue ?? '';
  }
  Object.assign(resolvedParams, parameters);

  const { widthMm, heightMm } = resolvePageDimensionsMm(def);
  const margins = def.page.margins ?? { top: 14, right: 14, bottom: 14, left: 14 };
  const printableW = widthMm - margins.left - margins.right;
  const ctx = createEvalContext(datasets, resolvedParams);

  const pageHeaderBand = def.bands.find((b) => b.type === 'PageHeader');
  const pageFooterBand = def.bands.find((b) => b.type === 'PageFooter');
  const pageHeaderH = pageHeaderBand ? (pageHeaderBand.height ?? 12) : 0;
  const pageFooterH = pageFooterBand ? (pageFooterBand.height ?? 10) : 0;

  const contentTopMm = margins.top + pageHeaderH;
  const contentBottomMm = heightMm - margins.bottom - pageFooterH;

  const draftPages: PositionedDrawNode[][] = [[]];
  let currentNodes = draftPages[0];
  let cursorY = contentTopMm;
  const semanticTables: SemanticTable[] = [];

  function newPage() {
    currentNodes = [];
    draftPages.push(currentNodes);
    cursorY = contentTopMm;
  }

  async function renderElementToNodes(
    el: ElementDefinition,
    originX: number,
    originY: number,
    availW: number,
    target: PositionedDrawNode[]
  ) {
    const x = originX + (el.x ?? 0);
    const y = originY + (el.y ?? 0);
    const w = el.width ?? availW;
    const h = el.height ?? 6;

    if (el.type === 'Line') {
      target.push({
        kind: 'Line',
        x1: x,
        y1: y,
        x2: x + w,
        y2: y,
        color: el.color ?? '#CBD5E1',
        thicknessMm: Math.max(0.2, el.height ?? 0.3),
      });
      return;
    }

    if (el.type === 'Rectangle') {
      target.push({
        kind: 'Rectangle',
        x,
        y,
        width: w,
        height: h,
        fillColor: el.backgroundColor,
        strokeColor: el.borderColor ?? '#CBD5E1',
        strokeWidthMm: 0.25,
      });
      return;
    }

    if (el.type === 'Image') {
      const src = el.value ?? '';
      if (src.startsWith('data:image/')) {
        target.push({ kind: 'Image', x, y, width: w, height: h, dataUrl: src });
      }
      return;
    }

    if (el.type === 'QrCode') {
      const rawExpr = el.expression ?? el.value ?? '';
      const payload = rawExpr.startsWith('=')
        ? String(evaluateExpression(compileExpression(rawExpr), ctx) ?? '')
        : rawExpr;
      const dataUrl = await QRCode.toDataURL(payload || 'UniversalReport.NET', {
        margin: 1,
        width: 140,
        color: { dark: '#0F172A', light: '#FFFFFF' },
      });
      target.push({ kind: 'QrCode', x, y, width: w, height: h, payload, dataUrl });
      return;
    }

    const rawExpr = el.expression ?? el.value ?? '';
    const evaluated = rawExpr.startsWith('=')
      ? evaluateExpression(compileExpression(rawExpr), ctx)
      : rawExpr;
    let text = formatTypedValue(evaluated, el.format);
    const fontPt = el.fontSizePt ?? 9.5;
    let finalH = h;
    if (el.canGrow) {
      const lines = wrapText(text, Math.max(4, w), fontPt);
      text = lines.join('\n');
      finalH = Math.max(h, lines.length * (fontPt * 0.45) + 1.2);
    }

    const evalOptColor = (expr?: string): string | undefined => {
      if (!expr || !expr.trim()) return undefined;
      if (!expr.startsWith('=')) return expr;
      const res = evaluateExpression(compileExpression(expr), ctx);
      return res === null || res === undefined ? undefined : String(res);
    };

    const resolvedColor = evalOptColor(el.colorExpression) ?? el.color ?? '#0F172A';
    const resolvedBg = evalOptColor(el.backgroundColorExpression) ?? el.backgroundColor;
    if (resolvedBg) {
      target.push({
        kind: 'Rectangle',
        x,
        y,
        width: w,
        height: finalH,
        fillColor: resolvedBg,
        strokeColor: undefined,
        strokeWidthMm: 0,
      });
    }

    target.push({
      kind: 'Text',
      x,
      y,
      width: w,
      height: finalH,
      text,
      fontSizePt: fontPt,
      fontWeight: el.fontWeight ?? 'Normal',
      color: resolvedColor,
      align: el.align ?? 'Left',
      wrap: Boolean(el.canGrow),
    });
  }

  function wrapText(text: string, maxWidthMm: number, fontSizePt: number): string[] {
    if (!text) return [''];
    const approxCharMm = Math.max(0.8, fontSizePt * 0.21);
    const maxChars = Math.max(4, Math.floor(maxWidthMm / approxCharMm));
    const lines: string[] = [];
    for (const para of text.split('\n')) {
      const words = para.split(' ');
      let current = '';
      for (const word of words) {
        if (!current) current = word;
        else if (current.length + 1 + word.length <= maxChars) current += ' ' + word;
        else {
          lines.push(current);
          current = word;
        }
        while (current.length > maxChars) {
          lines.push(current.slice(0, maxChars));
          current = current.slice(maxChars);
        }
      }
      lines.push(current);
    }
    return lines;
  }

  async function renderStaticBand(band: BandDefinition, ox: number, oy: number, target: PositionedDrawNode[]) {
    for (const el of band.elements) {
      await renderElementToNodes(el, ox, oy, printableW, target);
    }
  }

  const groupHeaderBand = def.bands.find((b) => b.type === 'GroupHeader');
  const groupFooterBand = def.bands.find((b) => b.type === 'GroupFooter');

  for (const band of def.bands) {
    if (
      band.type === 'PageHeader' ||
      band.type === 'PageFooter' ||
      band.type === 'GroupHeader' ||
      band.type === 'GroupFooter'
    ) {
      continue;
    }

    if (band.type !== 'Detail') {
      ctx.setGroupScope('', null);
      const bandH = band.height ?? 18;
      if (cursorY + bandH > contentBottomMm) newPage();
      await renderStaticBand(band, margins.left, cursorY, currentNodes);
      cursorY += bandH;
      continue;
    }

    const allRows = band.dataset ? (datasets[band.dataset] ?? []) : [];
    const groupField = band.groupBy ?? groupHeaderBand?.groupBy;

    const groups: { key: string; rows: DataRow[] }[] = [];
    if (!groupField) {
      groups.push({ key: '__all__', rows: allRows });
    } else {
      const map = new Map<string, DataRow[]>();
      for (const row of allRows) {
        const gKey = String(row[groupField] ?? '(Empty)');
        const arr = map.get(gKey);
        if (arr) arr.push(row);
        else map.set(gKey, [row]);
      }
      for (const [key, rows] of map.entries()) groups.push({ key, rows });
    }

    const allSemanticRows: (string | number | boolean | null)[][] = [];
    let tableColumnsMeta: { header: string; align: string; format?: string }[] | null = null;

    for (const grp of groups) {
      const rows = grp.rows;
      ctx.setGroupScope(band.dataset ?? '', rows);

      if (groupHeaderBand) {
        const ghH = groupHeaderBand.height ?? 9;
        if (cursorY + ghH > contentBottomMm) newPage();
        await renderStaticBand(groupHeaderBand, margins.left, cursorY, currentNodes);
        cursorY += ghH;
      }

      for (const el of band.elements) {
        if (el.type !== 'Table') {
          for (let r = 0; r < rows.length; r++) {
            ctx.setRow(band.dataset ?? '', rows[r], r, rows);
            const elH = el.height ?? 7;
            if (cursorY + elH > contentBottomMm) newPage();
            await renderElementToNodes(el, margins.left, cursorY, printableW, currentNodes);
            cursorY += elH;
          }
          continue;
        }

        const cols = el.columns ?? [];
        if (cols.length === 0) continue;

        if (!tableColumnsMeta) {
          tableColumnsMeta = cols.map((c) => ({
            header: c.header,
            align: c.align ?? 'Left',
            format: c.format,
          }));
        }

        const totalSpecW = cols.reduce((acc, c) => acc + (c.width ?? printableW / cols.length), 0);
        const scale = totalSpecW > 0 ? printableW / totalSpecW : 1;
        const colWidths = cols.map((c) => (c.width ?? printableW / cols.length) * scale);
        const headerH = 7.5;
        const rowH = 6.5;

        const drawHeader = () => {
          let cx = margins.left;
          currentNodes.push({
            kind: 'Rectangle',
            x: cx,
            y: cursorY,
            width: printableW,
            height: headerH,
            fillColor: '#0F172A',
            strokeColor: '#0F172A',
            strokeWidthMm: 0.2,
          });
          for (let c = 0; c < cols.length; c++) {
            currentNodes.push({
              kind: 'Text',
              x: cx + 1.5,
              y: cursorY + 1.7,
              width: colWidths[c] - 3,
              height: headerH - 3,
              text: cols[c].header,
              fontSizePt: 8.2,
              fontWeight: 'Bold',
              color: '#FFFFFF',
              align: cols[c].align ?? 'Left',
            });
            cx += colWidths[c];
          }
          cursorY += headerH;
        };

        if (cursorY + headerH + rowH > contentBottomMm) newPage();
        drawHeader();

        const compiledCols = cols.map((c) => compileExpression(c.expression));
        const compiledColorExprs = cols.map((c) =>
          c.colorExpression && c.colorExpression.startsWith('=') ? compileExpression(c.colorExpression) : null
        );
        const compiledBgExprs = cols.map((c) =>
          c.backgroundColorExpression && c.backgroundColorExpression.startsWith('=')
            ? compileExpression(c.backgroundColorExpression)
            : null
        );

        for (let r = 0; r < rows.length; r++) {
          ctx.setRow(band.dataset ?? '', rows[r], r, rows);
          const semRow: (string | number | boolean | null)[] = [];
          const cellTexts: string[] = [];
          const cellColors: string[] = [];
          const cellBgs: (string | undefined)[] = [];
          let maxLines = 1;

          for (let c = 0; c < cols.length; c++) {
            const val = evaluateExpression(compiledCols[c], ctx);
            semRow.push(
              typeof val === 'number' || typeof val === 'boolean' || val === null ? val : String(val)
            );
            const formatted = formatTypedValue(val, cols[c].format);
            if (cols[c].canGrow) {
              const lines = wrapText(formatted, Math.max(4, colWidths[c] - 3), 8.2);
              cellTexts.push(lines.join('\n'));
              if (lines.length > maxLines) maxLines = lines.length;
            } else {
              cellTexts.push(formatted);
            }
            const ce = compiledColorExprs[c];
            const be = compiledBgExprs[c];
            cellColors.push(
              ce ? String(evaluateExpression(ce, ctx) ?? '#0F172A') : (cols[c].colorExpression ?? '#0F172A')
            );
            cellBgs.push(
              be
                ? (evaluateExpression(be, ctx) as string | undefined)
                : cols[c].backgroundColorExpression
            );
          }

          const dynamicRowH = Math.max(rowH, maxLines * 3.8 + 2.4);
          if (cursorY + dynamicRowH > contentBottomMm) {
            newPage();
            if (el.repeatHeaders !== false) drawHeader();
          }

          let cx = margins.left;
          if (r % 2 === 1) {
            currentNodes.push({
              kind: 'Rectangle',
              x: cx,
              y: cursorY,
              width: printableW,
              height: dynamicRowH,
              fillColor: '#F8FAFC',
              strokeColor: '#E2E8F0',
              strokeWidthMm: 0.1,
            });
          } else {
            currentNodes.push({
              kind: 'Line',
              x1: cx,
              y1: cursorY + dynamicRowH,
              x2: cx + printableW,
              y2: cursorY + dynamicRowH,
              color: '#F1F5F9',
              thicknessMm: 0.15,
            });
          }

          for (let c = 0; c < cols.length; c++) {
            if (cellBgs[c]) {
              currentNodes.push({
                kind: 'Rectangle',
                x: cx,
                y: cursorY,
                width: colWidths[c],
                height: dynamicRowH,
                fillColor: cellBgs[c],
                strokeWidthMm: 0,
              });
            }
            currentNodes.push({
              kind: 'Text',
              x: cx + 1.5,
              y: cursorY + 1.4,
              width: colWidths[c] - 3,
              height: dynamicRowH - 2.4,
              text: cellTexts[c],
              fontSizePt: 8.2,
              fontWeight: 'Normal',
              color: cellColors[c],
              align: cols[c].align ?? 'Left',
              wrap: Boolean(cols[c].canGrow),
            });
            cx += colWidths[c];
          }
          allSemanticRows.push(semRow);
          cursorY += dynamicRowH;
        }
      }

      if (groupFooterBand) {
        ctx.setGroupScope(band.dataset ?? '', rows);
        const gfH = groupFooterBand.height ?? 9;
        if (cursorY + gfH > contentBottomMm) newPage();
        await renderStaticBand(groupFooterBand, margins.left, cursorY, currentNodes);
        cursorY += gfH;
      }
    }

    if (tableColumnsMeta) {
      let summaryRow: (string | number | boolean | null)[] | undefined;
      const tableEl = band.elements.find((e) => e.type === 'Table' && (e.columns?.length ?? 0) > 0);
      const tCols = tableEl?.columns ?? [];
      if (tCols.some((c) => c.summary && c.summary !== 'None')) {
        summaryRow = tCols.map((c, idx) => {
          if (!c.summary || c.summary === 'None') return idx === 0 ? 'Total' : null;
          if (c.summary === 'Count') return allSemanticRows.length;
          if (c.summary === 'Last') {
            const last = allSemanticRows[allSemanticRows.length - 1];
            return last ? last[idx] : null;
          }
          const sum = allSemanticRows.reduce((acc, r) => acc + Number(r[idx] ?? 0), 0);
          return c.summary === 'Avg' && allSemanticRows.length > 0
            ? roundDecimal(sum / allSemanticRows.length, 2)
            : roundDecimal(sum, 2);
        });

        const totalSpecW = tCols.reduce((acc, c) => acc + (c.width ?? printableW / tCols.length), 0);
        const scale = totalSpecW > 0 ? printableW / totalSpecW : 1;
        const summaryH = 7;
        if (cursorY + summaryH > contentBottomMm) newPage();
        let sx = margins.left;
        currentNodes.push({
          kind: 'Rectangle',
          x: sx,
          y: cursorY,
          width: printableW,
          height: summaryH,
          fillColor: '#F1F5F9',
          strokeColor: '#CBD5E1',
          strokeWidthMm: 0.2,
        });
        for (let c = 0; c < tCols.length; c++) {
          const cw = (tCols[c].width ?? printableW / tCols.length) * scale;
          const formatted = summaryRow[c] === null ? '' : formatTypedValue(summaryRow[c], tCols[c].format);
          currentNodes.push({
            kind: 'Text',
            x: sx + 1.5,
            y: cursorY + 1.5,
            width: cw - 3,
            height: summaryH - 3,
            text: formatted,
            fontSizePt: 8.2,
            fontWeight: 'Bold',
            color: '#0F172A',
            align: tCols[c].align ?? 'Left',
          });
          sx += cw;
        }
        cursorY += summaryH;
      }

      semanticTables.push({
        datasetName: band.dataset ?? 'Table',
        columns: tableColumnsMeta,
        rows: allSemanticRows,
        summaryRow,
      });
    }
  }

  const totalPages = draftPages.length;
  const pages: RenderPage[] = [];
  for (let p = 0; p < totalPages; p++) {
    ctx.setPageInfo(p + 1, totalPages);
    const nodes: PositionedDrawNode[] = [];
    if (def.page.watermark) {
      nodes.push({
        kind: 'Text',
        x: margins.left,
        y: heightMm * 0.45,
        width: printableW,
        height: 18,
        text: def.page.watermark,
        fontSizePt: 32,
        fontWeight: 'Bold',
        color: '#E2E8F0',
        align: 'Center',
      });
    }
    nodes.push(...draftPages[p]);
    if (pageHeaderBand) await renderStaticBand(pageHeaderBand, margins.left, margins.top, nodes);
    if (pageFooterBand) {
      await renderStaticBand(pageFooterBand, margins.left, heightMm - margins.bottom - pageFooterH, nodes);
    }
    pages.push({ pageNumber: p + 1, widthMm, heightMm, nodes });
  }

  return {
    reportId: def.reportId,
    title: def.title ?? def.reportId,
    contentHash,
    pageWidthMm: widthMm,
    pageHeightMm: heightMm,
    pages,
    semanticTables,
    renderDurationMs: Math.round((performance.now() - start) * 100) / 100,
  };
}

export function sanitizeSpreadsheetCell(value: string): string {
  if (!value) return value;
  const first = value[0];
  return first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r'
    ? `'${value}`
    : value;
}

export async function exportToPdfBuffer(doc: RenderDocument): Promise<Buffer> {
  const mmToPt = 72 / 25.4;
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      autoFirstPage: false,
      info: {
        Title: doc.title,
        Creator: 'UniversalReport.NET 1.0',
        Producer: 'UniversalReport.Export.Pdf',
      },
    });

    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    for (const page of doc.pages) {
      pdf.addPage({
        size: [page.widthMm * mmToPt, page.heightMm * mmToPt],
        margin: 0,
      });

      for (const node of page.nodes) {
        if (node.kind === 'Rectangle') {
          if (node.fillColor && node.fillColor !== 'transparent') {
            pdf
              .rect(node.x * mmToPt, node.y * mmToPt, node.width * mmToPt, node.height * mmToPt)
              .fillColor(node.fillColor)
              .fill();
          }
          if (node.strokeColor && node.strokeColor !== 'transparent') {
            pdf
              .rect(node.x * mmToPt, node.y * mmToPt, node.width * mmToPt, node.height * mmToPt)
              .lineWidth(node.strokeWidthMm * mmToPt)
              .strokeColor(node.strokeColor)
              .stroke();
          }
        } else if (node.kind === 'Line') {
          pdf
            .moveTo(node.x1 * mmToPt, node.y1 * mmToPt)
            .lineTo(node.x2 * mmToPt, node.y2 * mmToPt)
            .lineWidth(node.thicknessMm * mmToPt)
            .strokeColor(node.color)
            .stroke();
        } else if (node.kind === 'QrCode' && node.dataUrl) {
          const base64 = node.dataUrl.split(',')[1];
          if (base64) {
            pdf.image(Buffer.from(base64, 'base64'), node.x * mmToPt, node.y * mmToPt, {
              width: node.width * mmToPt,
              height: node.height * mmToPt,
            });
          }
        } else if (node.kind === 'Image' && node.dataUrl) {
          const base64 = node.dataUrl.split(',')[1];
          if (base64) {
            pdf.image(Buffer.from(base64, 'base64'), node.x * mmToPt, node.y * mmToPt, {
              width: node.width * mmToPt,
              height: node.height * mmToPt,
            });
          }
        } else if (node.kind === 'Text') {
          const fontName =
            node.fontWeight === 'Bold' || node.fontWeight === 'SemiBold' ? 'Helvetica-Bold' : 'Helvetica';
          const align = node.align.toLowerCase() as 'left' | 'center' | 'right';
          pdf
            .font(fontName)
            .fontSize(node.fontSizePt)
            .fillColor(node.color)
            .text(node.text, node.x * mmToPt, node.y * mmToPt, {
              width: node.width * mmToPt,
              align,
              lineBreak: Boolean(node.wrap || node.text.includes('\n')),
            });
        }
      }
    }

    pdf.end();
  });
}

export async function exportToXlsxBuffer(doc: RenderDocument): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UniversalReport.NET';
  wb.created = new Date();

  if (doc.semanticTables.length === 0) {
    const ws = wb.addWorksheet('Report');
    ws.addRow([sanitizeSpreadsheetCell(doc.title)]);
  }

  for (const table of doc.semanticTables) {
    const ws = wb.addWorksheet((table.datasetName || 'Report').slice(0, 31));
    const headerRow = ws.addRow(table.columns.map((c) => sanitizeSpreadsheetCell(c.header)));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    });

    for (const r of table.rows) {
      const safeRow = r.map((v) =>
        typeof v === 'number' || typeof v === 'boolean' ? v : sanitizeSpreadsheetCell(String(v ?? ''))
      );
      const added = ws.addRow(safeRow);
      r.forEach((v, idx) => {
        if (typeof v === 'number' && table.columns[idx]?.format === 'N2') {
          added.getCell(idx + 1).numFmt = '#,##0.00';
        }
      });
    }

    if (table.summaryRow) {
      const safeSum = table.summaryRow.map((v) =>
        typeof v === 'number' || typeof v === 'boolean' ? v : sanitizeSpreadsheetCell(String(v ?? ''))
      );
      const sumRow = ws.addRow(safeSum);
      sumRow.font = { bold: true };
      table.summaryRow.forEach((v, idx) => {
        if (typeof v === 'number' && table.columns[idx]?.format === 'N2') {
          sumRow.getCell(idx + 1).numFmt = '#,##0.00';
        }
      });
    }

    table.columns.forEach((col, i) => {
      ws.getColumn(i + 1).width = Math.max(14, col.header.length + 6);
    });
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

export function exportToCsvString(doc: RenderDocument): string {
  const table = doc.semanticTables[0];
  if (!table) return '\uFEFF';
  const esc = (v: unknown) => {
    const raw = sanitizeSpreadsheetCell(String(v ?? ''));
    return `"${raw.replace(/"/g, '""')}"`;
  };
  const lines = [
    table.columns.map((c) => esc(c.header)).join(','),
    ...table.rows.map((row) => row.map((v) => esc(v)).join(',')),
  ];
  return '\uFEFF' + lines.join('\r\n');
}

export function exportToHtmlString(doc: RenderDocument): string {
  const escHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const pagesHtml = doc.pages
    .map((p) => {
      const nodesHtml = p.nodes
        .map((n) => {
          if (n.kind === 'Rectangle') {
            return `<div style="position:absolute;left:${n.x}mm;top:${n.y}mm;width:${n.width}mm;height:${n.height}mm;background:${n.fillColor ?? 'transparent'};border:${n.strokeWidthMm}mm solid ${n.strokeColor ?? 'transparent'};box-sizing:border-box;"></div>`;
          }
          if (n.kind === 'Line') {
            return `<div style="position:absolute;left:${n.x1}mm;top:${n.y1}mm;width:${Math.max(0.2, n.x2 - n.x1)}mm;height:${n.thicknessMm}mm;background:${n.color};"></div>`;
          }
          if (n.kind === 'Image' && n.dataUrl) {
            return `<img src="${n.dataUrl}" alt="Embedded Report Image" style="position:absolute;left:${n.x}mm;top:${n.y}mm;width:${n.width}mm;height:${n.height}mm;object-fit:contain;" />`;
          }
          if (n.kind === 'QrCode' && n.dataUrl) {
            return `<img src="${n.dataUrl}" alt="QR Verification" style="position:absolute;left:${n.x}mm;top:${n.y}mm;width:${n.width}mm;height:${n.height}mm;" />`;
          }
          if (n.kind === 'Text') {
            const fw = n.fontWeight === 'Bold' ? 700 : n.fontWeight === 'SemiBold' ? 600 : 400;
            const ws = n.wrap || n.text.includes('\n') ? 'pre-wrap' : 'nowrap';
            return `<div style="position:absolute;left:${n.x}mm;top:${n.y}mm;width:${n.width}mm;height:${n.height}mm;font-size:${n.fontSizePt}pt;font-weight:${fw};color:${n.color};text-align:${n.align.toLowerCase()};overflow:hidden;white-space:${ws};line-height:1.25;">${escHtml(n.text)}</div>`;
          }
          return '';
        })
        .join('\n');
      return `<section style="position:relative;width:${p.widthMm}mm;height:${p.heightMm}mm;background:#fff;margin:0 auto 24px;border:1px solid #cbd5e1;box-shadow:0 2px 10px rgba(15,23,42,.06);">${nodesHtml}</section>`;
    })
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escHtml(doc.title)}</title><style>body{font-family:'Noto Sans','Noto Sans Bengali',system-ui,sans-serif;background:#f8fafc;padding:24px;margin:0;}</style></head><body>${pagesHtml}</body></html>`;
}
