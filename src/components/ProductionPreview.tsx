import React, { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  Globe,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { RenderDocument, ReportFormat, UReportDefinition } from '../shared/reportTypes';

interface ProductionPreviewProps {
  template: UReportDefinition;
  parameters: Record<string, string | number>;
  externalDatasets?: Record<string, Record<string, string | number | boolean | null>[]>;
}

const MM_TO_PX = 3.35;

export const ProductionPreview: React.FC<ProductionPreviewProps> = ({
  template,
  parameters,
  externalDatasets,
}) => {
  const hasExternal = Boolean(externalDatasets && Object.keys(externalDatasets).length > 0);
  const [doc, setDoc] = useState<RenderDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const [rowCount, setRowCount] = useState(18);
  const [sourceMode, setSourceMode] = useState<'synthetic' | 'bound' | 'json' | 'csv'>(
    hasExternal ? 'bound' : 'synthetic'
  );
  const [showDataDrawer, setShowDataDrawer] = useState(false);
  const [customPayload, setCustomPayload] = useState(
    '[\n  { "TranDate": "2026-11-12", "Reference": "EXT-9001", "Particulars": "External JSON Settlement", "Debit": 0, "Credit": 42500.00, "Balance": 167500.00 }\n]'
  );
  const [parsedDatasets, setParsedDatasets] = useState<
    Record<string, Record<string, string | number | boolean | null>[]> | undefined
  >(hasExternal ? externalDatasets : undefined);
  const [jobState, setJobState] = useState<{
    jobId: string;
    status: string;
    downloadUrl?: string;
  } | null>(null);

  const primaryDatasetName = template.datasets?.[0]?.name ?? 'Transactions';

  const resolveActiveDatasets = async (
    mode: 'synthetic' | 'bound' | 'json' | 'csv' = sourceMode,
    raw = customPayload
  ) => {
    if (mode === 'synthetic') return undefined;
    if (mode === 'bound') return externalDatasets;
    const res = await fetch('/api/v1/datasources/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: mode, payload: raw }),
    });
    const parsed = await res.json();
    if (!res.ok || !parsed.valid) {
      throw new Error(parsed.error || 'Failed to parse custom data source');
    }
    return { [primaryDatasetName]: parsed.rows };
  };

  const fetchCanonicalPreview = async (
    rows = rowCount,
    customDs: Record<string, Record<string, string | number | boolean | null>[]> | undefined = parsedDatasets
  ) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/reports/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateJson: JSON.stringify(template),
          format: 'ir',
          parameters,
          datasets: customDs,
          sampleRowCount: rows,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview render failed');
      setDoc(data);
      setCurrentPageIdx(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview render failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (externalDatasets && Object.keys(externalDatasets).length > 0) {
      setSourceMode('bound');
      setParsedDatasets(externalDatasets);
      fetchCanonicalPreview(rowCount, externalDatasets);
    } else {
      setParsedDatasets(undefined);
      setSourceMode('synthetic');
      fetchCanonicalPreview(rowCount, undefined);
    }
  }, [template.reportId, externalDatasets]);

  useEffect(() => {
    if (sourceMode === 'synthetic') {
      fetchCanonicalPreview(rowCount, undefined);
    }
  }, [rowCount]);

  const downloadExport = async (format: Exclude<ReportFormat, 'ir'>) => {
    const res = await fetch('/api/v1/reports/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateJson: JSON.stringify(template),
        format,
        parameters,
        datasets: sourceMode === 'synthetic' ? undefined : parsedDatasets,
        sampleRowCount: rowCount,
      }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${template.reportId}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const enqueueAsyncJob = async () => {
    setJobState({ jobId: 'pending', status: 'Queuing...' });
    const res = await fetch('/api/v1/report-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateJson: JSON.stringify(template),
        format: 'pdf',
        parameters,
        datasets: sourceMode === 'synthetic' ? undefined : parsedDatasets,
        sampleRowCount: Math.max(rowCount, 120),
      }),
    });
    const accepted = await res.json();
    setJobState({ jobId: accepted.jobId, status: accepted.status, downloadUrl: accepted.downloadUrl });

    const poll = setInterval(async () => {
      const stRes = await fetch(`/api/v1/report-jobs/${accepted.jobId}`);
      if (!stRes.ok) {
        clearInterval(poll);
        return;
      }
      const st = await stRes.json();
      setJobState({
        jobId: accepted.jobId,
        status: st.status,
        downloadUrl: st.status === 'Completed' ? accepted.downloadUrl : undefined,
      });
      if (st.status === 'Completed' || st.status === 'Failed') {
        clearInterval(poll);
      }
    }, 250);
  };

  const page = doc?.pages[currentPageIdx] ?? null;

  return (
    <div className="flex flex-col h-[calc(100vh-57px)] bg-slate-50 overflow-hidden">
      {/* Control Strip */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {[18, 80, 250].map((cnt) => (
              <button
                key={cnt}
                type="button"
                onClick={() => {
                  const wasAlreadySyntheticSameCount = sourceMode === 'synthetic' && rowCount === cnt;
                  setSourceMode('synthetic');
                  setParsedDatasets(undefined);
                  setRowCount(cnt);
                  if (!wasAlreadySyntheticSameCount && cnt === rowCount) {
                    fetchCanonicalPreview(cnt, undefined);
                  }
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  sourceMode === 'synthetic' && rowCount === cnt
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {cnt} rows
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowDataDrawer((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md transition-colors whitespace-nowrap ${
              showDataDrawer || sourceMode !== 'synthetic'
                ? 'bg-blue-50 border-blue-200 text-blue-800'
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>
              {sourceMode === 'synthetic'
                ? 'Bind Custom Data'
                : sourceMode === 'bound'
                  ? 'Source: Attached'
                  : `Source: ${sourceMode.toUpperCase()}`}
            </span>
          </button>

          <button
            type="button"
            onClick={() => fetchCanonicalPreview(rowCount, sourceMode === 'synthetic' ? undefined : parsedDatasets)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Re-run Layout</span>
          </button>

          {doc ? (
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {doc.pages.length} page(s) · {doc.renderDurationMs} ms · SHA {doc.contentHash.slice(0, 8)}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => downloadExport('pdf')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>PDF</span>
          </button>
          <button
            type="button"
            onClick={() => downloadExport('xlsx')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>XLSX</span>
          </button>
          <button
            type="button"
            onClick={() => downloadExport('csv')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>CSV</span>
          </button>
          <button
            type="button"
            onClick={() => downloadExport('html')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>HTML</span>
          </button>
          <button
            type="button"
            onClick={enqueueAsyncJob}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Queue Job</span>
          </button>
        </div>
      </div>

      {showDataDrawer ? (
        <div className="bg-white border-b border-slate-200 px-6 py-4 space-y-3 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900">
                Dataset Adapter · {primaryDatasetName}
              </span>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
                {(['json', 'csv'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setSourceMode(m);
                      if (m === 'csv' && customPayload.trim().startsWith('[')) {
                        setCustomPayload(
                          'TranDate,Reference,Particulars,Debit,Credit,Balance\n2026-11-12,CSV-1001,Imported CSV Credit,0,32000.00,157000.00\n2026-11-13,CSV-1002,Vendor Payout,4500.00,0,152500.00'
                        );
                      } else if (m === 'json' && !customPayload.trim().startsWith('[')) {
                        setCustomPayload(
                          '[\n  { "TranDate": "2026-11-12", "Reference": "EXT-9001", "Particulars": "External JSON Settlement", "Debit": 0, "Credit": 42500.00, "Balance": 167500.00 }\n]'
                        );
                      }
                    }}
                    className={`px-2.5 py-1 text-xs font-medium rounded uppercase transition-colors ${
                      sourceMode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSourceMode('synthetic');
                  setParsedDatasets(undefined);
                  setShowDataDrawer(false);
                  fetchCanonicalPreview(rowCount, undefined);
                }}
                className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md"
              >
                Use Synthetic Data
              </button>
              <button
                type="button"
                onClick={() => {
                  const activeMode =
                    sourceMode === 'synthetic' || sourceMode === 'bound' ? 'json' : sourceMode;
                  if (sourceMode === 'synthetic' || sourceMode === 'bound') setSourceMode('json');
                  resolveActiveDatasets(activeMode, customPayload)
                    .then((ds) => {
                      setParsedDatasets(ds);
                      return fetchCanonicalPreview(rowCount, ds);
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : 'Parse error'));
                }}
                className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md"
              >
                Bind & Render
              </button>
            </div>
          </div>

          <textarea
            rows={4}
            value={customPayload}
            onChange={(e) => setCustomPayload(e.target.value)}
            className="w-full p-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:bg-white focus:outline-none focus:border-blue-600"
          />
        </div>
      ) : null}

      {/* Async Job Banner when active */}
      {jobState ? (
        <div className="bg-white border-b border-slate-200 px-6 py-2 flex items-center justify-between text-xs">
          <div className="text-slate-700">
            Async Render Job <span className="font-mono">{jobState.jobId}</span> · Status:{' '}
            <span className="font-semibold text-slate-900">{jobState.status}</span>
          </div>
          {jobState.downloadUrl ? (
            <a
              href={jobState.downloadUrl}
              className="text-blue-700 font-medium hover:underline"
            >
              Download Signed Output
            </a>
          ) : null}
        </div>
      ) : null}

      {/* Page Navigation + Canonical A4 Sheet */}
      <div className="flex-1 overflow-auto p-8 flex flex-col items-center">
        {error ? (
          <div className="max-w-xl w-full bg-red-50 border border-red-200 rounded-md p-4 text-xs text-red-800">
            {error}
          </div>
        ) : null}

        {doc && doc.pages.length > 0 ? (
          <div className="mb-4 flex items-center gap-3 bg-white border border-slate-200 rounded-md px-3 py-1.5">
            <button
              type="button"
              disabled={currentPageIdx === 0}
              onClick={() => setCurrentPageIdx((i) => Math.max(0, i - 1))}
              className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-700">
              Page {currentPageIdx + 1} of {doc.pages.length}
            </span>
            <button
              type="button"
              disabled={currentPageIdx >= doc.pages.length - 1}
              onClick={() => setCurrentPageIdx((i) => Math.min(doc.pages.length - 1, i + 1))}
              className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : null}

        {loading && !page ? (
          <div
            className="bg-white border border-slate-200 animate-pulse"
            style={{ width: 210 * MM_TO_PX, height: 297 * MM_TO_PX }}
          />
        ) : page ? (
          <div
            className="bg-white border border-slate-300 shadow-sm relative shrink-0"
            style={{
              width: page.widthMm * MM_TO_PX,
              height: page.heightMm * MM_TO_PX,
            }}
          >
            {page.nodes.map((node, idx) => {
              if (node.kind === 'Rectangle') {
                return (
                  <div
                    key={idx}
                    className="absolute box-border"
                    style={{
                      left: node.x * MM_TO_PX,
                      top: node.y * MM_TO_PX,
                      width: node.width * MM_TO_PX,
                      height: node.height * MM_TO_PX,
                      backgroundColor: node.fillColor ?? 'transparent',
                      border: `${Math.max(0.5, node.strokeWidthMm * MM_TO_PX)}px solid ${
                        node.strokeColor ?? 'transparent'
                      }`,
                    }}
                  />
                );
              }
              if (node.kind === 'Line') {
                return (
                  <div
                    key={idx}
                    className="absolute"
                    style={{
                      left: node.x1 * MM_TO_PX,
                      top: node.y1 * MM_TO_PX,
                      width: Math.max(1, (node.x2 - node.x1) * MM_TO_PX),
                      height: Math.max(1, node.thicknessMm * MM_TO_PX),
                      backgroundColor: node.color,
                    }}
                  />
                );
              }
              if (node.kind === 'QrCode' && node.dataUrl) {
                return (
                  <img
                    key={idx}
                    src={node.dataUrl}
                    alt="Verification QR Code"
                    referrerPolicy="no-referrer"
                    className="absolute"
                    style={{
                      left: node.x * MM_TO_PX,
                      top: node.y * MM_TO_PX,
                      width: node.width * MM_TO_PX,
                      height: node.height * MM_TO_PX,
                    }}
                  />
                );
              }
              if (node.kind === 'Image' && node.dataUrl) {
                return (
                  <img
                    key={idx}
                    src={node.dataUrl}
                    alt="Embedded Report Image"
                    referrerPolicy="no-referrer"
                    className="absolute object-contain"
                    style={{
                      left: node.x * MM_TO_PX,
                      top: node.y * MM_TO_PX,
                      width: node.width * MM_TO_PX,
                      height: node.height * MM_TO_PX,
                    }}
                  />
                );
              }
              if (node.kind === 'Text') {
                const isMultiline = Boolean(node.wrap || node.text.includes('\n'));
                return (
                  <div
                    key={idx}
                    className={`absolute overflow-hidden tabular-nums ${
                      isMultiline ? 'whitespace-pre-wrap' : 'whitespace-nowrap'
                    }`}
                    style={{
                      left: node.x * MM_TO_PX,
                      top: node.y * MM_TO_PX,
                      width: node.width * MM_TO_PX,
                      height: Math.max(12, node.height * MM_TO_PX),
                      fontSize: `${node.fontSizePt * 1.18}px`,
                      fontWeight:
                        node.fontWeight === 'Bold' ? 700 : node.fontWeight === 'SemiBold' ? 600 : 400,
                      color: node.color,
                      textAlign: node.align.toLowerCase() as 'left' | 'center' | 'right',
                      lineHeight: 1.25,
                    }}
                  >
                    {node.text}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};
