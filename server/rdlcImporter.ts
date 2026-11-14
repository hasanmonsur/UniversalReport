import type {
  BandDefinition,
  DatasetDefinition,
  ElementDefinition,
  ParameterDefinition,
  TableColumnDefinition,
  UReportDefinition,
} from '../src/shared/reportTypes.ts';

export interface RdlcDiagnostic {
  severity: 'Info' | 'Warning' | 'Error';
  code: string;
  message: string;
  sourceElement?: string;
}

export interface RdlcImportResponse {
  reportId: string;
  definition: UReportDefinition;
  diagnostics: RdlcDiagnostic[];
}

function translateRdlcExpression(raw: string, diagnostics: RdlcDiagnostic[]): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('=')) return trimmed;

  const fieldMatch = /^=Fields!([a-zA-Z0-9_]+)\.Value$/i.exec(trimmed);
  if (fieldMatch) return `=Fields.${fieldMatch[1]}`;

  const paramMatch = /^=Parameters!([a-zA-Z0-9_]+)\.Value$/i.exec(trimmed);
  if (paramMatch) return `=Parameters.${paramMatch[1]}`;

  const converted = trimmed
    .replace(/Fields!([a-zA-Z0-9_]+)\.Value/gi, 'Fields.$1')
    .replace(/Parameters!([a-zA-Z0-9_]+)\.Value/gi, 'Parameters.$1')
    .replace(/Globals!PageNumber/gi, 'Globals.PageNumber')
    .replace(/Globals!TotalPages/gi, 'Globals.TotalPages');

  if (converted === trimmed) {
    diagnostics.push({
      severity: 'Warning',
      code: 'RDLC_EXPR_REVIEW',
      message: `Review migrated expression '${trimmed}' against UniversalReport AST allowlist.`,
    });
  }

  return converted;
}

function extractBlocks(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

function getAttr(xml: string, attr: string): string | undefined {
  const m = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return m?.[1];
}

function getFirstTagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim();
}

export function importRdlcXml(rdlcXml: string, reportIdOverride?: string): RdlcImportResponse {
  if (!rdlcXml || !rdlcXml.includes('<Report')) {
    throw new Error('Invalid RDLC XML: missing <Report> root element.');
  }

  const diagnostics: RdlcDiagnostic[] = [];
  const reportId = reportIdOverride?.trim() || 'imported-rdlc-report';

  if (/<Code\b[^>]*>/i.test(rdlcXml)) {
    diagnostics.push({
      severity: 'Warning',
      code: 'RDLC_CUSTOM_CODE_DROPPED',
      message: 'Embedded VB <Code> blocks are excluded from UniversalReport sandbox. Replace with built-in AST functions.',
      sourceElement: 'Code',
    });
  }

  const parameters: ParameterDefinition[] = [];
  for (const pBlock of extractBlocks(rdlcXml, 'ReportParameter')) {
    const name = getAttr(pBlock, 'Name');
    if (!name) continue;
    const dt = (getFirstTagText(pBlock, 'DataType') ?? 'String').toLowerCase();
    const type: ParameterDefinition['type'] =
      dt === 'integer'
        ? 'Int32'
        : dt === 'float'
          ? 'Decimal'
          : dt === 'datetime'
            ? 'DateTime'
            : dt === 'boolean'
              ? 'Boolean'
              : 'String';
    parameters.push({ name, type });
  }

  const datasets: DatasetDefinition[] = [];
  for (const dsBlock of extractBlocks(rdlcXml, 'DataSet')) {
    const name = getAttr(dsBlock, 'Name') ?? 'DataSet1';
    const fields = extractBlocks(dsBlock, 'Field')
      .map((fb) => getAttr(fb, 'Name'))
      .filter((n): n is string => Boolean(n))
      .map((n) => ({ name: n, type: 'String' as const }));
    datasets.push({ name, source: 'External', fields });
  }

  const bands: BandDefinition[] = [];
  const headerElements: ElementDefinition[] = [];
  let yCursor = 0;

  // Top-level Textboxes outside Tablix
  const bodyBlock = getFirstTagText(rdlcXml, 'Body') ?? rdlcXml;
  const bodyWithoutTablix = bodyBlock.replace(/<Tablix\b[\s\S]*?<\/Tablix>/gi, '');
  for (const tb of extractBlocks(bodyWithoutTablix, 'Textbox')) {
    const rawVal = getFirstTagText(tb, 'Value') ?? '';
    const translated = translateRdlcExpression(rawVal, diagnostics);
    const isExpr = translated.startsWith('=');
    headerElements.push({
      id: getAttr(tb, 'Name') ?? `tb-${headerElements.length + 1}`,
      type: 'Text',
      x: 0,
      y: yCursor,
      width: 140,
      height: 6,
      ...(isExpr ? { expression: translated } : { value: translated }),
      fontSizePt: headerElements.length === 0 ? 13 : 9.5,
      fontWeight: headerElements.length === 0 ? 'Bold' : 'Normal',
    });
    yCursor += 7;
  }

  if (headerElements.length > 0) {
    bands.push({
      id: 'report-header',
      type: 'ReportHeader',
      height: Math.max(18, yCursor + 6),
      elements: headerElements,
    });
  }

  for (const tablix of extractBlocks(rdlcXml, 'Tablix')) {
    const dsName = getFirstTagText(tablix, 'DataSetName') ?? datasets[0]?.name ?? 'DataSet1';
    const rows = extractBlocks(tablix, 'TablixRow');
    const cols: TableColumnDefinition[] = [];

    if (rows.length >= 2) {
      const hdrBoxes = extractBlocks(rows[0], 'Textbox');
      const detBoxes = extractBlocks(rows[1], 'Textbox');
      const colCount = Math.max(hdrBoxes.length, detBoxes.length);
      for (let i = 0; i < colCount; i++) {
        const hdr = hdrBoxes[i] ? getFirstTagText(hdrBoxes[i], 'Value') ?? `Column ${i + 1}` : `Column ${i + 1}`;
        const rawExpr = detBoxes[i] ? getFirstTagText(detBoxes[i], 'Value') ?? '' : '';
        cols.push({
          header: hdr,
          expression: translateRdlcExpression(rawExpr, diagnostics),
          width: Math.floor(182 / Math.max(1, colCount)),
          align: 'Left',
        });
      }
    }

    bands.push({
      id: `detail-${bands.length + 1}`,
      type: 'Detail',
      dataset: dsName,
      elements: [
        {
          id: getAttr(tablix, 'Name') ?? 'imported-table',
          type: 'Table',
          x: 0,
          y: 0,
          width: 182,
          repeatHeaders: true,
          columns: cols,
        },
      ],
    });
  }

  if (bands.length === 0) {
    bands.push({
      id: 'report-header',
      type: 'ReportHeader',
      height: 20,
      elements: [{ id: 'fallback', type: 'Text', x: 0, y: 0, width: 140, height: 6, value: 'Imported RDLC Report', fontSizePt: 12, fontWeight: 'Bold' }],
    });
    diagnostics.push({
      severity: 'Info',
      code: 'RDLC_DEFAULT_BAND',
      message: 'No Tablix or Textbox controls detected; inserted fallback ReportHeader.',
    });
  }

  const definition: UReportDefinition = {
    schemaVersion: '1.0',
    reportId,
    title: `Imported RDLC (${reportId})`,
    page: { size: 'A4', unit: 'mm', orientation: 'Portrait', margins: { top: 14, right: 14, bottom: 14, left: 14 } },
    parameters,
    datasets,
    bands,
  };

  return { reportId, definition, diagnostics };
}
