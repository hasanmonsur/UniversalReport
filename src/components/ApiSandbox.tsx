import React, { useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileCode,
  Play,
  Save,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import type { UReportDefinition } from '../shared/reportTypes';

interface ApiSandboxProps {
  template: UReportDefinition;
  onImportTemplate?: (imported: UReportDefinition, publishToRegistry?: boolean) => Promise<void> | void;
}

const PRESET_EXPRESSIONS = [
  {
    label: 'Conditional Status (IIf)',
    expr: '=IIf(Fields.Balance < 0, "Overdrawn", "Normal")',
    expectValid: true,
  },
  {
    label: 'Dataset Aggregate (Sum)',
    expr: '=Format(Sum(Fields.Debit, "Transactions"), "N2")',
    expectValid: true,
  },
  {
    label: 'Closing Balance Formula',
    expr: '=Parameters.OpeningBalance + Sum(Fields.Credit, "Transactions") - Sum(Fields.Debit, "Transactions")',
    expectValid: true,
  },
  {
    label: 'Blocked Reflection Attack',
    expr: '=System.Reflection.Assembly.GetExecutingAssembly()',
    expectValid: false,
  },
  {
    label: 'Blocked Arbitrary Function',
    expr: '=ShellExec("cat /etc/passwd")',
    expectValid: false,
  },
];

const SAMPLE_RDLC = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition">
  <Code>Function CustomLegacyHelper() As String: Return "VB": End Function</Code>
  <ReportParameters>
    <ReportParameter Name="AccountNo"><DataType>String</DataType></ReportParameter>
  </ReportParameters>
  <DataSets>
    <DataSet Name="Transactions">
      <Fields>
        <Field Name="TranDate" />
        <Field Name="Reference" />
        <Field Name="Particulars" />
        <Field Name="Debit" />
        <Field Name="Credit" />
      </Fields>
    </DataSet>
  </DataSets>
  <Body>
    <ReportItems>
      <Textbox Name="TitleBox"><Value>Migrated Legacy RDLC Account Statement</Value></Textbox>
      <Tablix Name="TxnTable">
        <DataSetName>Transactions</DataSetName>
        <TablixRows>
          <TablixRow>
            <TablixCells>
              <TablixCell><Textbox><Value>Date</Value></Textbox></TablixCell>
              <TablixCell><Textbox><Value>Reference</Value></Textbox></TablixCell>
              <TablixCell><Textbox><Value>Particulars</Value></Textbox></TablixCell>
              <TablixCell><Textbox><Value>Credit</Value></Textbox></TablixCell>
            </TablixCells>
          </TablixRow>
          <TablixRow>
            <TablixCells>
              <TablixCell><Textbox><Value>=Fields!TranDate.Value</Value></Textbox></TablixCell>
              <TablixCell><Textbox><Value>=Fields!Reference.Value</Value></Textbox></TablixCell>
              <TablixCell><Textbox><Value>=Fields!Particulars.Value</Value></Textbox></TablixCell>
              <TablixCell><Textbox><Value>=Fields!Credit.Value</Value></Textbox></TablixCell>
            </TablixCells>
          </TablixRow>
        </TablixRows>
      </Tablix>
    </ReportItems>
  </Body>
</Report>`;

export const ApiSandbox: React.FC<ApiSandboxProps> = ({ template, onImportTemplate }) => {
  const [expression, setExpression] = useState(PRESET_EXPRESSIONS[0].expr);
  const [compileOut, setCompileOut] = useState<string>('');
  const [compileOk, setCompileOk] = useState<boolean | null>(null);

  const [validateOut, setValidateOut] = useState<string>('');
  const [validateOk, setValidateOk] = useState<boolean | null>(null);

  const [rdlcXml, setRdlcXml] = useState(SAMPLE_RDLC);
  const [rdlcResult, setRdlcResult] = useState<{
    definition?: UReportDefinition;
    diagnostics?: { severity: string; code: string; message: string }[];
    error?: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importJsonText, setImportJsonText] = useState<string>('');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importCheck, setImportCheck] = useState<{
    valid: boolean;
    contentHash?: string;
    definition?: UReportDefinition;
    errors?: { code?: string; message: string; path?: string }[];
    parseError?: string;
  } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [copiedExport, setCopiedExport] = useState(false);

  const exportedJson = JSON.stringify(template, null, 2);
  const totalElementCount = (template.bands ?? []).reduce(
    (acc, b) => acc + (b.elements?.length ?? 0),
    0
  );

  const handleExportDownload = () => {
    const blob = new Blob([exportedJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${template.reportId || 'report'}.ureport`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportedJson);
      setCopiedExport(true);
      setTimeout(() => setCopiedExport(false), 1800);
    } catch {
      // Fallback ignored if clipboard permissions are restricted
    }
  };

  const validateImportedJson = async (rawText = importJsonText) => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      setImportCheck({ valid: false, parseError: 'Paste a .ureport JSON definition or upload a file first.' });
      return null;
    }

    let parsedDef: UReportDefinition;
    try {
      parsedDef = JSON.parse(trimmed) as UReportDefinition;
    } catch (err) {
      setImportCheck({
        valid: false,
        parseError: err instanceof Error ? `Invalid JSON syntax: ${err.message}` : 'Invalid JSON syntax',
      });
      return null;
    }

    try {
      const res = await fetch('/api/v1/reports/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateJson: trimmed }),
      });
      const data = await res.json();
      const result = {
        valid: Boolean(data.valid),
        contentHash: data.contentHash as string | undefined,
        definition: data.valid ? parsedDef : undefined,
        errors: Array.isArray(data.errors) ? data.errors : undefined,
      };
      setImportCheck(result);
      return result.valid ? parsedDef : null;
    } catch (err) {
      setImportCheck({
        valid: false,
        parseError: err instanceof Error ? err.message : 'Validation request failed',
      });
      return null;
    }
  };

  const handleFileSelected = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportFileName(file.name);
    setImportJsonText(text);
    await validateImportedJson(text);
    ev.target.value = '';
  };

  const handleCommitImport = async (publishToRegistry: boolean) => {
    if (!onImportTemplate) return;
    setIsImporting(true);
    try {
      const validDef = importCheck?.valid && importCheck.definition
        ? importCheck.definition
        : await validateImportedJson(importJsonText);
      if (!validDef) return;
      await onImportTemplate(validDef, publishToRegistry);
    } finally {
      setIsImporting(false);
    }
  };

  const runCompile = async (targetExpr = expression) => {
    const res = await fetch('/api/v1/reports/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: targetExpr }),
    });
    const data = await res.json();
    setCompileOk(res.ok);
    setCompileOut(JSON.stringify(data, null, 2));
  };

  const runSchemaValidation = async () => {
    const res = await fetch('/api/v1/reports/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateJson: JSON.stringify(template) }),
    });
    const data = await res.json();
    setValidateOk(Boolean(data.valid));
    setValidateOut(JSON.stringify(data, null, 2));
  };

  const runRdlcImport = async () => {
    const res = await fetch('/api/v1/reports/import-rdlc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rdlcXml, reportId: 'account-statement' }),
    });
    const data = await res.json();
    if (!res.ok) {
      setRdlcResult({ error: data.error || 'RDLC import failed' });
      return;
    }
    setRdlcResult(data);
  };

  return (
    <div className="h-[calc(100vh-57px)] overflow-y-auto bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Portable .ureport JSON Project Import / Export */}
        <section className="bg-white border border-slate-200 rounded-md p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                .ureport JSON Project Import & Export
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Portable .ureport v1.0 definition interchange across Studio, .NET CLI, and ASP.NET Core environments
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopyExport}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                {copiedExport ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedExport ? 'Copied JSON' : 'Copy JSON'}</span>
              </button>
              <button
                type="button"
                onClick={handleExportDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export .ureport</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Export Column */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-900">
                  Active Project · <span className="font-mono">{template.reportId}.ureport</span>
                </span>
                <span className="text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                  v{template.schemaVersion} · {template.bands.length} bands · {totalElementCount} elements
                </span>
              </div>

              <pre className="p-3 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-auto max-h-60 leading-relaxed">
                {exportedJson}
              </pre>

              <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded p-3 space-y-1">
                <div className="font-medium text-slate-800">Load in any .NET 8 / 9 / 10 service</div>
                <pre className="font-mono text-[11px] text-slate-700 overflow-x-auto">
{`var json = await File.ReadAllTextAsync("${template.reportId}.ureport");
var report = new Report(json, pipeline);`}
                </pre>
              </div>
            </div>

            {/* Import Column */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-900">
                  Import .ureport / .json Definition
                  {importFileName ? (
                    <span className="font-normal font-mono text-[11px] text-slate-500 ml-2">
                      ({importFileName})
                    </span>
                  ) : null}
                </label>
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".ureport,.json,application/json"
                    onChange={handleFileSelected}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setImportFileName(`${template.reportId}.ureport`);
                      setImportJsonText(exportedJson);
                      void validateImportedJson(exportedJson);
                    }}
                    className="px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded transition-colors whitespace-nowrap"
                  >
                    Clone Active
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded transition-colors whitespace-nowrap"
                  >
                    <Upload className="w-3 h-3" />
                    <span>Upload File</span>
                  </button>
                </div>
              </div>

              <textarea
                rows={9}
                value={importJsonText}
                onChange={(e) => {
                  setImportJsonText(e.target.value);
                  setImportCheck(null);
                }}
                placeholder='Paste full .ureport JSON here or click "Upload File" to import a report project...'
                className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded focus:bg-white focus:outline-none focus:border-blue-600"
              />

              {importCheck ? (
                importCheck.valid && importCheck.definition ? (
                  <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded text-xs text-emerald-900 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                      <span>Valid .ureport v{importCheck.definition.schemaVersion} definition</span>
                    </div>
                    <div className="text-[11px] text-emerald-800 tabular-nums">
                      <span className="font-mono">{importCheck.definition.reportId}</span>
                      <span className="mx-1.5" aria-hidden="true">·</span>
                      <span>{(importCheck.definition.bands ?? []).length} bands</span>
                      <span className="mx-1.5" aria-hidden="true">·</span>
                      <span>{(importCheck.definition.datasets ?? []).length} datasets</span>
                      {importCheck.contentHash ? (
                        <>
                          <span className="mx-1.5" aria-hidden="true">·</span>
                          <span className="font-mono">{importCheck.contentHash.slice(0, 10)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-900 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <ShieldAlert className="w-4 h-4 text-red-700 shrink-0" />
                      <span>Import validation failed</span>
                    </div>
                    {importCheck.parseError ? (
                      <div className="text-[11px]">{importCheck.parseError}</div>
                    ) : null}
                    {importCheck.errors?.map((err, idx) => (
                      <div key={idx} className="text-[11px] font-mono">
                        {err.path ? `${err.path}: ` : ''}
                        {err.message}
                      </div>
                    ))}
                  </div>
                )
              ) : null}

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void validateImportedJson()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Validate JSON</span>
                </button>
                {onImportTemplate ? (
                  <>
                    <button
                      type="button"
                      disabled={isImporting || !importJsonText.trim()}
                      onClick={() => void handleCommitImport(false)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap disabled:opacity-40"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                      <span>Open in Designer</span>
                    </button>
                    <button
                      type="button"
                      disabled={isImporting || !importJsonText.trim()}
                      onClick={() => void handleCommitImport(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap disabled:opacity-40"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{isImporting ? 'Importing...' : 'Import & Save'}</span>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Expression AST Sandbox */}
          <section className="bg-white border border-slate-200 rounded-md p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Expression AST Compiler & Security Sandbox
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  POST /api/v1/reports/compile · Tokenizer, Typed AST, Allowlist Validator
                </p>
              </div>
              <button
                type="button"
                onClick={() => runCompile()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Compile AST</span>
              </button>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-slate-600">Test Cases</div>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_EXPRESSIONS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setExpression(p.expr);
                      runCompile(p.expr);
                    }}
                    className="px-2.5 py-1 text-xs bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded text-slate-700 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Expression Source
              </label>
              <textarea
                rows={3}
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded focus:bg-white focus:outline-none focus:border-blue-600"
              />
            </div>

            {compileOk !== null ? (
              <div
                className={`flex items-center gap-2 text-xs font-medium ${
                  compileOk ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {compileOk ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                )}
                <span>
                  {compileOk
                    ? 'Allowed by sandbox AST validator'
                    : 'Blocked by sandbox security policy'}
                </span>
              </div>
            ) : null}

            <pre className="p-3 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-auto max-h-64">
              {compileOut || '// Click "Compile AST" or choose a preset expression above'}
            </pre>
          </section>

          {/* Schema Validator & ASP.NET Core Endpoints */}
          <section className="bg-white border border-slate-200 rounded-md p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Template Schema & Resource Isolation Check
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  POST /api/v1/reports/validate · Schema v1.0, SSRF Guard, SHA-256 Plan Hash
                </p>
              </div>
              <button
                type="button"
                onClick={runSchemaValidation}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Validate Template</span>
              </button>
            </div>

            {validateOk !== null ? (
              <div
                className={`flex items-center gap-2 text-xs font-medium ${
                  validateOk ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {validateOk ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                )}
                <span>
                  {validateOk ? 'Template passes .ureport v1.0 schema and SSRF checks' : 'Validation failed'}
                </span>
              </div>
            ) : null}

            <pre className="p-3 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-auto max-h-52">
              {validateOut || '// Click "Validate Template" to verify the active .ureport JSON'}
            </pre>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="text-xs font-semibold text-slate-900 mb-2">
                ASP.NET Core v1 Endpoint Contract
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-1.5 pr-3 font-medium">Method</th>
                      <th className="py-1.5 pr-3 font-medium">Endpoint</th>
                      <th className="py-1.5 font-medium">Responsibility</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    <tr>
                      <td className="py-1.5 pr-3 font-semibold text-blue-700">POST</td>
                      <td className="py-1.5 pr-3 text-slate-800">/api/v1/reports/validate</td>
                      <td className="py-1.5 font-sans text-slate-600">Schema & SSRF validation</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-3 font-semibold text-blue-700">POST</td>
                      <td className="py-1.5 pr-3 text-slate-800">/api/v1/reports/compile</td>
                      <td className="py-1.5 font-sans text-slate-600">Typed AST compilation</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-3 font-semibold text-blue-700">POST</td>
                      <td className="py-1.5 pr-3 text-slate-800">/api/v1/reports/render</td>
                      <td className="py-1.5 font-sans text-slate-600">Synchronous PDF/XLSX/CSV/HTML</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-3 font-semibold text-blue-700">POST</td>
                      <td className="py-1.5 pr-3 text-slate-800">/api/v1/reports/import-rdlc</td>
                      <td className="py-1.5 font-sans text-slate-600">RDLC XML conversion & diagnostics</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-3 font-semibold text-blue-700">POST</td>
                      <td className="py-1.5 pr-3 text-slate-800">/api/v1/report-jobs</td>
                      <td className="py-1.5 font-sans text-slate-600">202 Accepted queued job</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        {/* RDLC Import & Compatibility Diagnostics */}
        <section className="bg-white border border-slate-200 rounded-md p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                RDLC XML Import & Compatibility Diagnostics (UniversalReport.Rdlc)
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                POST /api/v1/reports/import-rdlc · Converts Microsoft .rdlc XML into .ureport v1.0 JSON with sandbox diagnostics
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {rdlcResult?.definition && onImportTemplate ? (
                <button
                  type="button"
                  onClick={() => onImportTemplate(rdlcResult.definition!)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
                >
                  <FileCode className="w-3.5 h-3.5" />
                  <span>Open in Designer</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={runRdlcImport}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Convert RDLC</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Legacy .rdlc XML Source
              </label>
              <textarea
                rows={10}
                value={rdlcXml}
                onChange={(e) => setRdlcXml(e.target.value)}
                className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded focus:bg-white focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="space-y-3">
              {rdlcResult?.diagnostics && rdlcResult.diagnostics.length > 0 ? (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 space-y-1">
                  <div className="font-semibold">Compatibility Diagnostics</div>
                  {rdlcResult.diagnostics.map((d, idx) => (
                    <div key={idx} className="text-[11px]">
                      <span className="font-mono font-semibold">{d.code}</span> · {d.message}
                    </div>
                  ))}
                </div>
              ) : null}
              {rdlcResult?.error ? (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                  {rdlcResult.error}
                </div>
              ) : null}
              <pre className="p-3 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-auto max-h-56">
                {rdlcResult?.definition
                  ? JSON.stringify(rdlcResult.definition, null, 2)
                  : '// Click "Convert RDLC" to generate .ureport v1.0 JSON'}
              </pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
