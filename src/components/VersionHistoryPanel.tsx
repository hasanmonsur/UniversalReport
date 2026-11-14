import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  History,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
} from 'lucide-react';
import type { UReportDefinition } from '../shared/reportTypes';

export interface RevisionSnapshot {
  revisionId: number;
  reportId: string;
  contentHash: string;
  savedAt: string;
  definition: UReportDefinition;
}

interface VersionHistoryPanelProps {
  reportId: string;
  currentTemplate: UReportDefinition;
  activeSavedHash?: string;
  revisionTick: number;
  onSaveSnapshot: () => Promise<void>;
  onRestoreSnapshot: (definition: UReportDefinition, revisionId: number) => void;
}

function summarizeDefinition(def: UReportDefinition) {
  const bands = def.bands ?? [];
  const elementCount = bands.reduce((acc, b) => acc + (b.elements?.length ?? 0), 0);
  const datasetCount = def.datasets?.length ?? 0;
  return {
    bandCount: bands.length,
    elementCount,
    datasetCount,
  };
}

function formatSnapshotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const VersionHistoryPanel: React.FC<VersionHistoryPanelProps> = ({
  reportId,
  currentTemplate,
  activeSavedHash,
  revisionTick,
  onSaveSnapshot,
  onRestoreSnapshot,
}) => {
  const [revisions, setRevisions] = useState<RevisionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [expandedRevId, setExpandedRevId] = useState<number | null>(null);
  const [showJsonForRevId, setShowJsonForRevId] = useState<number | null>(null);
  const [restoredBanner, setRestoredBanner] = useState<string | null>(null);

  const loadRevisions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/templates/${encodeURIComponent(reportId)}/revisions`);
      if (!res.ok) {
        throw new Error(`Unable to load version history (HTTP ${res.status})`);
      }
      const data = await res.json();
      setRevisions(Array.isArray(data.revisions) ? data.revisions : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch saved snapshots');
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    setExpandedRevId(null);
    setShowJsonForRevId(null);
    setRestoredBanner(null);
    setQuery('');
  }, [reportId]);

  useEffect(() => {
    void loadRevisions();
  }, [loadRevisions, revisionTick]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSaveSnapshot();
      await loadRevisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save snapshot');
    } finally {
      setSaving(false);
    }
  };

  const currentSummary = useMemo(() => summarizeDefinition(currentTemplate), [currentTemplate]);

  const filteredRevisions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return revisions;
    return revisions.filter((rev) => {
      const revStr = `rev #${rev.revisionId}`;
      const titleStr = (rev.definition.title ?? '').toLowerCase();
      return (
        revStr.includes(q) ||
        String(rev.revisionId) === q ||
        rev.contentHash.toLowerCase().includes(q) ||
        titleStr.includes(q)
      );
    });
  }, [revisions, query]);

  return (
    <div className="flex flex-col h-full">
      {/* Header & Primary Snapshot Action */}
      <div className="pb-3 border-b border-slate-200 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-slate-900 truncate">Version History</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums truncate">
              {revisions.length} {revisions.length === 1 ? 'snapshot' : 'snapshots'} stored
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadRevisions()}
              disabled={loading}
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 rounded transition-colors disabled:opacity-40"
              title="Refresh snapshots"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-white bg-blue-700 hover:bg-blue-800 rounded transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Save className="w-3 h-3 shrink-0" />
              <span>{saving ? 'Saving...' : 'Save Snapshot'}</span>
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by revision # or hash"
            className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
          />
        </div>

        {restoredBanner ? (
          <div className="text-[11px] text-blue-800 bg-blue-50 border border-blue-200 rounded px-2.5 py-1.5">
            {restoredBanner}
          </div>
        ) : null}
      </div>

      {/* Snapshot List Body */}
      <div className="flex-1 overflow-y-auto -mx-4 px-4">
        {loading ? (
          <div className="divide-y divide-slate-200" aria-busy="true">
            {[0, 1, 2].map((idx) => (
              <div key={idx} className="py-3.5 space-y-2 animate-pulse">
                <div className="h-3.5 bg-slate-200 rounded w-3/4" />
                <div className="h-3 bg-slate-100 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="py-6 space-y-3">
            <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded p-3">
              {error}
            </div>
            <button
              type="button"
              onClick={() => void loadRevisions()}
              className="w-full py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded transition-colors"
            >
              Retry Loading Snapshots
            </button>
          </div>
        ) : filteredRevisions.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <History className="w-6 h-6 text-slate-300 mx-auto" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-700">
                {revisions.length === 0 ? 'No saved snapshots yet' : 'No matching snapshots'}
              </p>
              <p className="text-[11px] text-slate-500">
                {revisions.length === 0
                  ? 'Save the current .ureport definition to create a restorable snapshot.'
                  : 'Try clearing the revision filter to see all snapshots.'}
              </p>
            </div>
            {revisions.length === 0 ? (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded transition-colors whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Initial Snapshot</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-xs font-medium text-blue-700 hover:underline"
              >
                Clear filter
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {filteredRevisions.map((rev, index) => {
              const sum = summarizeDefinition(rev.definition);
              const isExpanded = expandedRevId === rev.revisionId;
              const showingJson = showJsonForRevId === rev.revisionId;
              const isPublishedHead =
                index === 0 || (activeSavedHash ? rev.contentHash === activeSavedHash : false);
              const elDelta = sum.elementCount - currentSummary.elementCount;
              const bandDelta = sum.bandCount - currentSummary.bandCount;

              return (
                <li key={rev.revisionId} className="py-3.5 space-y-2">
                  {/* Snapshot Metadata Row (Zero Pills) */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-900">
                        <span className="font-mono tabular-nums">Rev #{rev.revisionId}</span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {rev.contentHash.slice(0, 8)}
                        </span>
                        {isPublishedHead ? (
                          <>
                            <span className="text-slate-300" aria-hidden="true">·</span>
                            <span className="text-[11px] font-medium text-emerald-700">
                              Published
                            </span>
                          </>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                        {formatSnapshotTime(rev.savedAt)}
                        <span className="text-slate-300 mx-1.5" aria-hidden="true">·</span>
                        <span>{sum.bandCount} bands</span>
                        <span className="text-slate-300 mx-1.5" aria-hidden="true">·</span>
                        <span>{sum.elementCount} elements</span>
                      </div>
                    </div>
                  </div>

                  {/* Structural Comparison vs Canvas */}
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    {bandDelta === 0 && elDelta === 0
                      ? 'Same band and element count as active canvas'
                      : `vs canvas: ${bandDelta >= 0 ? `+${bandDelta}` : bandDelta} bands, ${
                          elDelta >= 0 ? `+${elDelta}` : elDelta
                        } elements`}
                  </div>

                  {/* Snapshot Actions */}
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRevId((prev) => (prev === rev.revisionId ? null : rev.revisionId))
                      }
                      className="flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                      <span>{isExpanded ? 'Hide snapshot' : 'Inspect snapshot'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        onRestoreSnapshot(rev.definition, rev.revisionId);
                        setRestoredBanner(
                          `Restored Rev #${rev.revisionId} (${rev.contentHash.slice(0, 8)}) onto canvas. Click Save Revision to publish.`
                        );
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:text-slate-900 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="w-3 h-3 shrink-0" />
                      <span>Restore</span>
                    </button>
                  </div>

                  {/* Expandable Snapshot Structure / JSON Preview */}
                  {isExpanded ? (
                    <div className="pt-2 space-y-2 border-t border-slate-100">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-600 font-medium truncate">
                          {rev.definition.title ?? rev.reportId}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setShowJsonForRevId((prev) =>
                              prev === rev.revisionId ? null : rev.revisionId
                            )
                          }
                          className="text-blue-700 hover:underline whitespace-nowrap shrink-0 ml-2"
                        >
                          {showingJson ? 'Show summary' : 'View .ureport JSON'}
                        </button>
                      </div>

                      {showingJson ? (
                        <pre className="max-h-48 overflow-auto p-2 text-[10px] font-mono bg-slate-900 text-slate-100 rounded leading-relaxed">
                          {JSON.stringify(rev.definition, null, 2)}
                        </pre>
                      ) : (
                        <div className="space-y-1 text-[11px] text-slate-600 tabular-nums">
                          <div>
                            Page: {rev.definition.page.size} {rev.definition.page.orientation}
                            {rev.definition.page.watermark
                              ? ` · Watermark: "${rev.definition.page.watermark}"`
                              : ''}
                          </div>
                          {(rev.definition.bands ?? []).map((b, bi) => (
                            <div
                              key={`${b.type}-${bi}`}
                              className="flex items-center justify-between text-slate-500"
                            >
                              <span className="truncate">
                                {b.type}
                                {b.dataset ? ` (${b.dataset})` : ''}
                              </span>
                              <span className="font-mono shrink-0 ml-2">
                                {b.elements.length} el · {b.height ?? 16}mm
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
