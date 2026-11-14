import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Check,
  Database,
  Play,
  Plus,
  ShieldAlert,
  Table2,
} from 'lucide-react';
import type { FieldDefinition, UReportDefinition } from '../shared/reportTypes';

type DataSourceKind = 'json' | 'csv' | 'rest' | 'sql';

interface CheckResponse {
  valid: boolean;
  kind?: string;
  securityCheck?: string;
  detectedParameters?: string[];
  fields?: FieldDefinition[];
  rowCount?: number;
  rows?: Record<string, string | number | boolean | null>[];
  error?: string;
}

interface DataSourcesWorkspaceProps {
  template: UReportDefinition;
  boundDatasets: Record<string, Record<string, string | number | boolean | null>[]>;
  onAttachDataSource: (
    datasetName: string,
    fields: FieldDefinition[],
    rows?: Record<string, string | number | boolean | null>[]
  ) => void;
  onGoToPreview: () => void;
}

const SAMPLE_PAYLOADS: Record<DataSourceKind, string> = {
  json: `[
  {
    "TranDate": "2026-11-10",
    "Reference": "TXN-50101",
    "Particulars": "Opening Balance Brought Forward",
    "Debit": 0,
    "Credit": 125000.00,
    "Balance": 125000.00
  },
  {
    "TranDate": "2026-11-11",
    "Reference": "NPSB-50102",
    "Particulars": "Dhaka Electric Utility Settlement",
    "Debit": 4250.50,
    "Credit": 0,
    "Balance": 120749.50
  },
  {
    "TranDate": "2026-11-12",
    "Reference": "EFTN-50103",
    "Particulars": "Corporate Payroll Credit (মেঘনা)",
    "Debit": 0,
    "Credit": 85000.00,
    "Balance": 205749.50
  }
]`,
  csv: `TranDate,Reference,Particulars,Debit,Credit,Balance
2026-11-10,CSV-9001,Opening Balance Brought Forward,0,125000.00,125000.00
2026-11-11,CSV-9002,Vendor Payout - Gulshan Branch,12400.00,0,112600.00
2026-11-12,CSV-9003,Export Proceeds Realized,0,64200.00,176800.00`,
  rest: 'https://jsonplaceholder.typicode.com/users',
  sql: `SELECT TranDate, Reference, Particulars, Debit, Credit, Balance
FROM LedgerTransactions
WHERE AccountNo = @AccountNo
ORDER BY TranDate ASC`,
};

export const DataSourcesWorkspace: React.FC<DataSourcesWorkspaceProps> = ({
  template,
  boundDatasets,
  onAttachDataSource,
  onGoToPreview,
}) => {
  const defaultDatasetName = template.datasets?.[0]?.name ?? 'Transactions';
  const [datasetName, setDatasetName] = useState(defaultDatasetName);
  const [kind, setKind] = useState<DataSourceKind>('json');
  const [payload, setPayload] = useState(SAMPLE_PAYLOADS.json);
  const [rootPath, setRootPath] = useState('');
  const [dbVendor, setDbVendor] = useState<'SqlServer' | 'PostgreSQL' | 'MySQL' | 'Oracle' | 'Sqlite'>('SqlServer');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [attachedNotice, setAttachedNotice] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const handleKindChange = (next: DataSourceKind) => {
    setKind(next);
    setPayload(SAMPLE_PAYLOADS[next]);
    setResult(null);
    setAttachedNotice(null);
  };

  const runCheck = async () => {
    setChecking(true);
    setAttachedNotice(null);
    try {
      const res = await fetch('/api/v1/datasources/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, payload, rootPath }),
      });
      const data: CheckResponse = await res.json();
      setResult(data);
    } catch (err) {
      setResult({
        valid: false,
        error: err instanceof Error ? err.message : 'Request failed',
      });
    } finally {
      setChecking(false);
    }
  };

  const handleAttach = () => {
    if (!result?.valid) return;
    onAttachDataSource(
      datasetName.trim() || 'Transactions',
      result.fields ?? [],
      result.rows && result.rows.length > 0 ? result.rows : undefined
    );
    setAttachedNotice(
      `Attached '${datasetName}' (${result.fields?.length ?? 0} fields${
        result.rows && result.rows.length > 0 ? `, ${result.rows.length} live rows` : ''
      }) to report`
    );
  };

  const csharpSnippet = useMemo(() => {
    const ds = datasetName.trim() || 'Transactions';
    if (kind === 'json') {
      return `using UniversalReport;\nusing UniversalReport.Core;\nusing UniversalReport.Data.Adapters;\n\nvar report = await UniversalReportEngine.LoadFileAsync("${template.reportId}.ureport");\nreport.SetJsonDataSource("${ds}", jsonString${rootPath ? `, "${rootPath}"` : ''});\nbyte[] pdf = await report.RenderAsync(ReportFormat.Pdf);`;
    }
    if (kind === 'csv') {
      return `using UniversalReport;\nusing UniversalReport.Core;\nusing UniversalReport.Data.Adapters;\n\nvar report = await UniversalReportEngine.LoadFileAsync("${template.reportId}.ureport");\nreport.SetCsvDataSource("${ds}", csvString, hasHeader: true);\nbyte[] pdf = await report.RenderAsync(ReportFormat.Pdf);`;
    }
    if (kind === 'rest') {
      const host = (() => {
        try {
          return new URL(payload).hostname;
        } catch {
          return 'api.example.com';
        }
      })();
      return `using UniversalReport;\nusing UniversalReport.Core;\nusing UniversalReport.Data.Adapters;\n\nvar restProvider = new RestApiDataProvider(\n    httpClient,\n    new Uri("${payload}"),\n    allowedHosts: ["${host}"]${rootPath ? `,\n    rootPropertyPath: "${rootPath}"` : ''});\n\nvar report = await UniversalReportEngine.LoadFileAsync("${template.reportId}.ureport");\nawait report.SetDataSourceAsync("${ds}", restProvider);\nbyte[] pdf = await report.RenderAsync(ReportFormat.Pdf);`;
    }

    const connType =
      dbVendor === 'SqlServer'
        ? 'new SqlConnection(connString)'
        : dbVendor === 'PostgreSQL'
          ? 'new NpgsqlConnection(connString)'
          : dbVendor === 'MySQL'
            ? 'new MySqlConnection(connString)'
            : dbVendor === 'Oracle'
              ? 'new OracleConnection(connString)'
              : 'new SqliteConnection(connString)';

    return `using UniversalReport;\nusing UniversalReport.Core;\nusing UniversalReport.Data.Adapters;\n\nvar sqlProvider = new AdoNetDataProvider("${dbVendor}", () => ${connType})\n    .RegisterAllowlistedQuery(new AllowlistedSqlQuery(\n        QueryId: "Get${ds}",\n        SqlText: """\n${payload}\n"""));\n\nvar report = await UniversalReportEngine.LoadFileAsync("${template.reportId}.ureport");\nreport.SetParameter("AccountNo", "1040-883920-001");\nawait report.SetDataSourceAsync("${ds}", sqlProvider, new ReportDataQuery("${ds}", "Get${ds}"));\nbyte[] pdf = await report.RenderAsync(ReportFormat.Pdf);`;
  }, [kind, datasetName, payload, rootPath, dbVendor, template.reportId]);

  const copySnippet = async () => {
    await navigator.clipboard.writeText(csharpSnippet);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1500);
  };

  const activeRows = result?.rows ?? boundDatasets[datasetName] ?? [];
  const activeColumns =
    activeRows.length > 0
      ? Object.keys(activeRows[0])
      : (result?.fields ?? []).map((f) => f.name);

  return (
    <div className="h-[calc(100vh-57px)] overflow-y-auto bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[440px_1fr] gap-6">
        {/* Left: Add & Check Data Source */}
        <section className="bg-white border border-slate-200 rounded-md p-5 space-y-4 h-fit">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Add & Check Data Source
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Test JSON, CSV, REST APIs, or read-only SQL queries, inspect inferred schema, and bind rows to your report.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Target Dataset Name
            </label>
            <input
              type="text"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              className="w-full px-3 py-1.5 text-xs font-mono border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              placeholder="Transactions"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1.5">
              Source Adapter Type
            </label>
            <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-md">
              {(
                [
                  { id: 'json', label: 'JSON' },
                  { id: 'csv', label: 'CSV' },
                  { id: 'rest', label: 'REST' },
                  { id: 'sql', label: 'SQL' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleKindChange(opt.id)}
                  className={`py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    kind === opt.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {kind === 'sql' ? (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                ADO.NET Database Provider
              </label>
              <select
                value={dbVendor}
                onChange={(e) => setDbVendor(e.target.value as typeof dbVendor)}
                className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
              >
                <option value="SqlServer">SQL Server (Microsoft.Data.SqlClient)</option>
                <option value="PostgreSQL">PostgreSQL (Npgsql)</option>
                <option value="MySQL">MySQL (MySqlConnector)</option>
                <option value="Oracle">Oracle (Oracle.ManagedDataAccess.Core)</option>
                <option value="Sqlite">SQLite (Microsoft.Data.Sqlite)</option>
              </select>
            </div>
          ) : null}

          {kind === 'json' || kind === 'rest' ? (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Optional Nested Root Property (e.g. data.items)
              </label>
              <input
                type="text"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="Leave blank if root is array"
                className="w-full px-3 py-1.5 text-xs font-mono border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
          ) : null}

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              {kind === 'rest'
                ? 'REST Endpoint URL'
                : kind === 'sql'
                  ? 'Allowlisted Read-Only SQL Query'
                  : kind === 'csv'
                    ? 'CSV Payload'
                    : 'JSON Array / Object Payload'}
            </label>
            <textarea
              rows={kind === 'rest' ? 2 : 9}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              className="w-full p-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:bg-white focus:outline-none focus:border-blue-600"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={runCheck}
              disabled={checking}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap disabled:opacity-60"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{checking ? 'Checking...' : 'Check Data Source'}</span>
            </button>
            <button
              type="button"
              disabled={!result?.valid}
              onClick={handleAttach}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Attach to Report</span>
            </button>
          </div>

          {attachedNotice ? (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-900 flex items-center justify-between gap-2">
              <span>{attachedNotice}</span>
              <button
                type="button"
                onClick={onGoToPreview}
                className="font-semibold text-emerald-800 underline whitespace-nowrap"
              >
                Open Preview
              </button>
            </div>
          ) : null}
        </section>

        {/* Right: Check Results, Live Row Preview, & C# NuGet Code */}
        <div className="space-y-6">
          {/* Check Diagnostics & Schema */}
          <section className="bg-white border border-slate-200 rounded-md p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-slate-600" />
                <h2 className="text-sm font-semibold text-slate-900">
                  Data Source Check & Schema Inspector
                </h2>
              </div>
              {result ? (
                <div
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    result.valid ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {result.valid ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <ShieldAlert className="w-4 h-4" />
                  )}
                  <span>{result.valid ? 'Check Passed' : 'Check Failed'}</span>
                </div>
              ) : null}
            </div>

            {!result ? (
              <div className="text-xs text-slate-500 py-4 border-t border-slate-100">
                Click <span className="font-semibold text-slate-700">Check Data Source</span> to validate security rules, infer column types, and preview rows.
              </div>
            ) : !result.valid ? (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800 space-y-1">
                {result.securityCheck ? <div className="font-semibold">{result.securityCheck}</div> : null}
                <div>{result.error}</div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 border-t border-slate-100 pt-3">
                  <span>{result.securityCheck}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {result.fields?.length ?? 0} field(s)
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {result.rowCount ?? 0} row(s) loaded
                  </span>
                </div>

                {result.fields && result.fields.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {result.fields.map((f) => (
                      <div
                        key={f.name}
                        className="px-3 py-2 bg-slate-50 border border-slate-200 rounded flex items-center justify-between text-xs"
                      >
                        <span className="font-mono font-medium text-slate-800 truncate">
                          {f.name}
                        </span>
                        <span className="text-[11px] text-slate-500 ml-2 shrink-0">{f.type}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          {/* Live Data Rows Grid */}
          <section className="bg-white border border-slate-200 rounded-md p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Table2 className="w-4 h-4 text-slate-600" />
                <h2 className="text-sm font-semibold text-slate-900">
                  Data Source Rows Preview
                </h2>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {activeRows.length} row(s)
              </span>
            </div>

            {activeRows.length === 0 ? (
              <div className="text-xs text-slate-500 py-6 text-center border border-dashed border-slate-200 rounded">
                {kind === 'sql' && result?.valid
                  ? 'SQL query syntax & allowlist passed. Execute against your ADO.NET database in .NET Core using the snippet below.'
                  : 'No rows loaded yet. Run "Check Data Source" to inspect live records.'}
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="bg-slate-900 text-white">
                      {activeColumns.map((col) => (
                        <th key={col} className="px-3 py-2 font-semibold whitespace-nowrap">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {activeRows.slice(0, 15).map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        {activeColumns.map((col) => {
                          const v = row[col];
                          const display =
                            typeof v === 'object' && v !== null
                              ? JSON.stringify(v)
                              : String(v ?? '');
                          const isNum = typeof v === 'number';
                          return (
                            <td
                              key={col}
                              className={`px-3 py-2 whitespace-nowrap max-w-[240px] truncate ${
                                isNum ? 'font-mono text-right text-slate-900' : 'text-slate-700'
                              }`}
                            >
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* C# NuGet Code Generator */}
          <section className="bg-slate-950 text-slate-100 rounded-md overflow-hidden border border-slate-800">
            <div className="h-10 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between">
              <span className="text-xs font-mono text-slate-300">
                .NET Core C# Usage · dotnet add package UniversalReport
              </span>
              <button
                type="button"
                onClick={copySnippet}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors"
              >
                {copiedCode ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedCode ? 'Copied' : 'Copy C#'}</span>
              </button>
            </div>
            <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto">
              {csharpSnippet}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
};
