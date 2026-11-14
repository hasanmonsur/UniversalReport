export type ReportFormat = 'pdf' | 'xlsx' | 'html' | 'csv' | 'ir';

export type BandType =
  | 'ReportHeader'
  | 'PageHeader'
  | 'GroupHeader'
  | 'Detail'
  | 'GroupFooter'
  | 'ReportFooter'
  | 'PageFooter';

export type ElementType = 'Text' | 'Table' | 'Line' | 'Rectangle' | 'Image' | 'QrCode';

export interface MarginsDefinition {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageDefinition {
  size: 'A4' | 'Letter' | 'Legal' | 'Custom';
  unit: 'mm' | 'pt' | 'in';
  orientation: 'Portrait' | 'Landscape';
  width?: number;
  height?: number;
  margins?: MarginsDefinition;
  watermark?: string;
}

export interface ParameterDefinition {
  name: string;
  type: 'String' | 'Decimal' | 'Int32' | 'DateTime' | 'Boolean';
  required?: boolean;
  defaultValue?: string | number | boolean | null;
}

export interface FieldDefinition {
  name: string;
  type: 'String' | 'Decimal' | 'Int32' | 'DateTime' | 'Boolean';
}

export interface DatasetDefinition {
  name: string;
  source: 'External' | 'Query' | 'Json' | 'Rest';
  queryId?: string;
  fields?: FieldDefinition[];
}

export interface TableColumnDefinition {
  header: string;
  expression: string;
  width?: number;
  align?: 'Left' | 'Center' | 'Right';
  format?: string;
  summary?: 'None' | 'Sum' | 'Count' | 'Avg' | 'Last';
  canGrow?: boolean;
  colorExpression?: string;
  backgroundColorExpression?: string;
}

export interface ElementDefinition {
  id?: string;
  type: ElementType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  value?: string;
  expression?: string;
  format?: string;
  align?: 'Left' | 'Center' | 'Right';
  fontSizePt?: number;
  fontWeight?: 'Normal' | 'Medium' | 'SemiBold' | 'Bold';
  color?: string;
  colorExpression?: string;
  backgroundColor?: string;
  backgroundColorExpression?: string;
  borderColor?: string;
  canGrow?: boolean;
  repeatHeaders?: boolean;
  columns?: TableColumnDefinition[];
}

export interface BandDefinition {
  id?: string;
  type: BandType;
  dataset?: string;
  groupBy?: string;
  height?: number;
  keepTogether?: boolean;
  repeatOnEveryPage?: boolean;
  elements: ElementDefinition[];
}

export interface UReportDefinition {
  schemaVersion: '1.0';
  reportId: string;
  title?: string;
  page: PageDefinition;
  parameters?: ParameterDefinition[];
  datasets?: DatasetDefinition[];
  bands: BandDefinition[];
}

export interface ReportError {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  contentHash: string;
  reportId?: string;
  errors: ReportError[];
}

export type PositionedDrawNode =
  | {
      kind: 'Text';
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      fontSizePt: number;
      fontWeight: string;
      color: string;
      align: string;
      wrap?: boolean;
    }
  | {
      kind: 'Rectangle';
      x: number;
      y: number;
      width: number;
      height: number;
      fillColor?: string;
      strokeColor?: string;
      strokeWidthMm: number;
    }
  | {
      kind: 'Line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      thicknessMm: number;
    }
  | {
      kind: 'QrCode';
      x: number;
      y: number;
      width: number;
      height: number;
      payload: string;
      dataUrl?: string;
    }
  | {
      kind: 'Image';
      x: number;
      y: number;
      width: number;
      height: number;
      dataUrl: string;
    };

export interface RenderPage {
  pageNumber: number;
  widthMm: number;
  heightMm: number;
  nodes: PositionedDrawNode[];
}

export interface SemanticTable {
  datasetName: string;
  columns: { header: string; align: string; format?: string }[];
  rows: (string | number | boolean | null)[][];
  summaryRow?: (string | number | boolean | null)[];
}

export interface RenderDocument {
  reportId: string;
  title: string;
  contentHash: string;
  pageWidthMm: number;
  pageHeightMm: number;
  pages: RenderPage[];
  semanticTables: SemanticTable[];
  renderDurationMs: number;
}
