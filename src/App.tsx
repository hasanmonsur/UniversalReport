import { useEffect, useState } from 'react';
import {
  Code2,
  Database,
  Eye,
  FileDown,
  FolderGit2,
  LayoutTemplate,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { VisualDesigner } from './components/VisualDesigner';
import { DataSourcesWorkspace } from './components/DataSourcesWorkspace';
import { ProductionPreview } from './components/ProductionPreview';
import { ApiSandbox } from './components/ApiSandbox';
import { DotnetSolutionBrowser } from './components/DotnetSolutionBrowser';
import type { UReportDefinition } from './shared/reportTypes';

type WorkspaceMode = 'designer' | 'datasources' | 'preview' | 'sandbox' | 'dotnet';

interface TemplateItem {
  id: string;
  title: string;
  contentHash: string;
  updatedAt: string;
  definition: UReportDefinition;
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceMode>('designer');
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [activeId, setActiveId] = useState<string>('account-statement');
  const [history, setHistory] = useState<UReportDefinition[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [parameters, setParameters] = useState<Record<string, string | number>>({});
  const [boundDatasets, setBoundDatasets] = useState<
    Record<string, Record<string, string | number | boolean | null>[]>
  >({});
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [revisionTick, setRevisionTick] = useState(0);

  useEffect(() => {
    fetch('/api/v1/templates')
      .then((r) => r.json())
      .then((data) => {
        const list: TemplateItem[] = data.templates ?? [];
        setTemplates(list);
        const initial = list.find((t) => t.id === 'account-statement') ?? list[0];
        if (initial) {
          setActiveId(initial.id);
          setHistory([initial.definition]);
          setHistoryIdx(0);
          initParams(initial.definition);
        }
      });
  }, []);

  const initParams = (def: UReportDefinition) => {
    const next: Record<string, string | number> = {};
    for (const p of def.parameters ?? []) {
      next[p.name] =
        typeof p.defaultValue === 'string' || typeof p.defaultValue === 'number'
          ? p.defaultValue
          : '';
    }
    setParameters(next);
  };

  const selectTemplate = (id: string) => {
    const found = templates.find((t) => t.id === id);
    if (!found) return;
    setActiveId(found.id);
    setHistory([found.definition]);
    setHistoryIdx(0);
    setBoundDatasets({});
    initParams(found.definition);
  };

  const activeTemplate = historyIdx >= 0 ? history[historyIdx] : null;

  const updateTemplate = (next: UReportDefinition) => {
    const truncated = history.slice(0, historyIdx + 1);
    const updated = [...truncated, next].slice(-30);
    setHistory(updated);
    setHistoryIdx(updated.length - 1);
  };

  const handleSaveRevision = async () => {
    if (!activeTemplate) return;
    const rawJson = JSON.stringify(activeTemplate, null, 2);
    const res = await fetch(`/api/v1/templates/${encodeURIComponent(activeTemplate.reportId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateJson: rawJson }),
    });
    if (res.ok) {
      const data = await res.json();
      setTemplates((prev) => {
        const exists = prev.some((t) => t.id === activeTemplate.reportId);
        const entry: TemplateItem = {
          id: activeTemplate.reportId,
          title: activeTemplate.title ?? activeTemplate.reportId,
          contentHash: data.contentHash,
          updatedAt: data.updatedAt,
          definition: activeTemplate,
        };
        return exists
          ? prev.map((t) => (t.id === activeTemplate.reportId ? entry : t))
          : [...prev, entry];
      });
      setActiveId(activeTemplate.reportId);
      setSaveFeedback(
        data.revisionId
          ? `Rev #${data.revisionId} · ${String(data.contentHash).slice(0, 8)}`
          : `Saved · ${String(data.contentHash).slice(0, 8)}`
      );
      setRevisionTick((t) => t + 1);
      setTimeout(() => setSaveFeedback(null), 2400);
    }
  };

  const handleImportTemplate = async (imported: UReportDefinition, publishToRegistry = false) => {
    const rawJson = JSON.stringify(imported, null, 2);
    if (publishToRegistry) {
      const res = await fetch(`/api/v1/templates/${encodeURIComponent(imported.reportId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateJson: rawJson }),
      });
      if (res.ok) {
        const data = await res.json();
        const entry: TemplateItem = {
          id: imported.reportId,
          title: imported.title ?? imported.reportId,
          contentHash: data.contentHash,
          updatedAt: data.updatedAt,
          definition: imported,
        };
        setTemplates((prev) =>
          prev.some((t) => t.id === imported.reportId)
            ? prev.map((t) => (t.id === imported.reportId ? entry : t))
            : [...prev, entry]
        );
        setSaveFeedback(
          data.revisionId
            ? `Rev #${data.revisionId} · ${String(data.contentHash).slice(0, 8)}`
            : `Saved · ${String(data.contentHash).slice(0, 8)}`
        );
        setRevisionTick((t) => t + 1);
        setTimeout(() => setSaveFeedback(null), 2400);
      }
    } else {
      setTemplates((prev) =>
        prev.some((t) => t.id === imported.reportId)
          ? prev
          : [
              ...prev,
              {
                id: imported.reportId,
                title: imported.title ?? imported.reportId,
                contentHash: 'unsaved-draft',
                updatedAt: new Date().toISOString(),
                definition: imported,
              },
            ]
      );
    }

    if (imported.reportId === activeId) {
      updateTemplate(imported);
    } else {
      setActiveId(imported.reportId);
      setHistory([imported]);
      setHistoryIdx(0);
      setBoundDatasets({});
      initParams(imported);
    }
    setWorkspace('designer');
  };

  const handleQuickPdf = async () => {
    if (!activeTemplate) return;
    const res = await fetch('/api/v1/reports/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateJson: JSON.stringify(activeTemplate),
        format: 'pdf',
        parameters,
        datasets: Object.keys(boundDatasets).length > 0 ? boundDatasets : undefined,
        sampleRowCount: 18,
      }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTemplate.reportId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const workspaceLabels: Record<WorkspaceMode, string> = {
    designer: 'Visual Designer',
    datasources: 'Data Sources',
    preview: 'Production Preview',
    sandbox: 'API & Sandbox',
    dotnet: '.NET 10 Solution',
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: Breadcrumb left, 2 primary actions right */}
      <header className="h-[57px] bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="font-display font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            UniversalReport.NET
          </span>
          <span className="text-slate-300" aria-hidden="true">/</span>
          <span className="text-slate-600 truncate">
            {activeTemplate?.title ?? activeId}
          </span>
          <span className="text-slate-300 hidden sm:inline" aria-hidden="true">/</span>
          <span className="text-slate-900 font-medium hidden sm:inline whitespace-nowrap shrink-0">
            {workspaceLabels[workspace]}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {saveFeedback ? (
            <span className="text-xs font-mono text-emerald-700 mr-2 whitespace-nowrap">
              {saveFeedback}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleSaveRevision}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save Revision</span>
          </button>
          <button
            type="button"
            onClick={handleQuickPdf}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span>Render PDF</span>
          </button>
        </div>
      </header>

      {/* Main Sidebar + Workspace Viewport */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Navigation Sidebar (248px) */}
        <nav className="w-[248px] bg-white border-r border-slate-200 flex flex-col justify-between shrink-0 overflow-y-auto">
          <div className="p-4 space-y-6">
            <div>
              <div className="text-[11px] font-semibold text-slate-500 mb-2 px-2">
                Studio Workspaces
              </div>
              <div className="space-y-1">
                {(
                  [
                    { id: 'designer', label: 'Visual Designer', icon: LayoutTemplate },
                    { id: 'datasources', label: 'Data Sources', icon: Database },
                    { id: 'preview', label: 'Production Preview', icon: Eye },
                    { id: 'sandbox', label: 'API & Sandbox', icon: ShieldCheck },
                    { id: 'dotnet', label: '.NET 10 Solution', icon: FolderGit2 },
                  ] as const
                ).map((item) => {
                  const Icon = item.icon;
                  const active = workspace === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setWorkspace(item.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className="text-[11px] font-semibold text-slate-500 mb-2 px-2">
                Banking Pilot Templates
              </div>
              <div className="space-y-1">
                {templates.map((tpl) => {
                  const active = tpl.id === activeId;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => selectTemplate(tpl.id)}
                      className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                        active
                          ? 'bg-blue-50 text-blue-800 font-medium'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="text-xs truncate">{tpl.title}</div>
                      <div className="text-[11px] font-mono text-slate-400 truncate">
                        {tpl.id}.ureport
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="p-4 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-slate-700">
              <Code2 className="w-3.5 h-3.5 text-slate-500" />
              <span>NuGet: net8.0 · net9.0 · net10.0</span>
            </div>
            <div>C# · SkiaSharp · OpenXML · Any Data Source</div>
          </div>
        </nav>

        {/* Active Workspace Panel */}
        <main className="flex-1 min-w-0 overflow-hidden">
          {!activeTemplate ? (
            <div className="p-8 text-xs text-slate-500">Loading .ureport template workspace...</div>
          ) : workspace === 'designer' ? (
            <VisualDesigner
              template={activeTemplate}
              parameters={parameters}
              canUndo={historyIdx > 0}
              canRedo={historyIdx < history.length - 1}
              activeSavedHash={templates.find((t) => t.id === activeId)?.contentHash}
              revisionTick={revisionTick}
              onUndo={() => setHistoryIdx((i) => Math.max(0, i - 1))}
              onRedo={() => setHistoryIdx((i) => Math.min(history.length - 1, i + 1))}
              onSaveRevision={handleSaveRevision}
              onChangeTemplate={updateTemplate}
              onChangeParameter={(name, value) =>
                setParameters((prev) => ({ ...prev, [name]: value }))
              }
            />
          ) : workspace === 'datasources' ? (
            <DataSourcesWorkspace
              template={activeTemplate}
              boundDatasets={boundDatasets}
              onAttachDataSource={(datasetName, fields, rows) => {
                const existing = activeTemplate.datasets ?? [];
                const nextDatasets = existing.some((d) => d.name === datasetName)
                  ? existing.map((d) => (d.name === datasetName ? { ...d, fields } : d))
                  : [...existing, { name: datasetName, source: 'External' as const, fields }];
                updateTemplate({ ...activeTemplate, datasets: nextDatasets });
                if (rows && rows.length > 0) {
                  setBoundDatasets((prev) => ({ ...prev, [datasetName]: rows }));
                }
              }}
              onGoToPreview={() => setWorkspace('preview')}
            />
          ) : workspace === 'preview' ? (
            <ProductionPreview
              template={activeTemplate}
              parameters={parameters}
              externalDatasets={boundDatasets}
            />
          ) : workspace === 'sandbox' ? (
            <ApiSandbox
              template={activeTemplate}
              onImportTemplate={handleImportTemplate}
            />
          ) : (
            <DotnetSolutionBrowser />
          )}
        </main>
      </div>
    </div>
  );
}
