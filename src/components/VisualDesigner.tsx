import React, { useEffect, useMemo, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Grid,
  History,
  Minus,
  Plus,
  QrCode,
  Redo2,
  Square,
  Table2,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import type {
  BandDefinition,
  ElementDefinition,
  ElementType,
  UReportDefinition,
} from '../shared/reportTypes';
import { VersionHistoryPanel } from './VersionHistoryPanel';

interface VisualDesignerProps {
  template: UReportDefinition;
  parameters: Record<string, string | number>;
  canUndo: boolean;
  canRedo: boolean;
  activeSavedHash?: string;
  revisionTick?: number;
  onUndo: () => void;
  onRedo: () => void;
  onSaveRevision?: () => Promise<void>;
  onChangeTemplate: (next: UReportDefinition) => void;
  onChangeParameter: (name: string, value: string) => void;
}

const MM_TO_PX = 3.2; // 210mm * 3.2 = 672px crisp A4 workspace width

export const VisualDesigner: React.FC<VisualDesignerProps> = ({
  template,
  parameters,
  canUndo,
  canRedo,
  activeSavedHash,
  revisionTick = 0,
  onUndo,
  onRedo,
  onSaveRevision,
  onChangeTemplate,
  onChangeParameter,
}) => {
  const [selectedBandIdx, setSelectedBandIdx] = useState(0);
  const [selectedElIdx, setSelectedElIdx] = useState<number | null>(0);
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'history'>('properties');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [compileStatus, setCompileStatus] = useState<{
    valid: boolean;
    message: string;
    astType?: string;
    fields?: string[];
  } | null>(null);

  const selectedBand = template.bands[selectedBandIdx] ?? template.bands[0];
  const selectedElement =
    selectedBand && selectedElIdx !== null ? selectedBand.elements[selectedElIdx] ?? null : null;

  const activeExpression = useMemo(() => {
    if (!selectedElement) return '';
    return selectedElement.expression ?? selectedElement.value ?? '';
  }, [selectedElement]);

  useEffect(() => {
    if (!activeExpression || !activeExpression.startsWith('=')) {
      setCompileStatus(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/v1/reports/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expression: activeExpression }),
        });
        const data = await res.json();
        if (res.ok && data.valid) {
          setCompileStatus({
            valid: true,
            message: 'AST compiled and sandbox-verified',
            astType: data.compiled?.ast?.kind,
            fields: data.compiled?.referencedFields ?? [],
          });
        } else {
          setCompileStatus({ valid: false, message: data.error || 'Expression error' });
        }
      } catch {
        setCompileStatus(null);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [activeExpression]);

  const pageWidthMm = template.page.orientation === 'Landscape' ? 297 : 210;
  const margins = template.page.margins ?? { top: 14, right: 14, bottom: 14, left: 14 };
  const printableWidthMm = pageWidthMm - margins.left - margins.right;

  const snap = (val: number) => (snapToGrid ? Math.round(val / 2) * 2 : Math.round(val * 10) / 10);

  const startElementDrag = (
    ev: React.MouseEvent,
    bandIdx: number,
    elIdx: number,
    origX: number,
    origY: number
  ) => {
    ev.stopPropagation();
    setSelectedBandIdx(bandIdx);
    setSelectedElIdx(elIdx);

    const startClientX = ev.clientX;
    const startClientY = ev.clientY;
    const pxPerMm = MM_TO_PX * zoom;

    const onMove = (moveEv: MouseEvent) => {
      const dxMm = (moveEv.clientX - startClientX) / pxPerMm;
      const dyMm = (moveEv.clientY - startClientY) / pxPerMm;
      const nextX = Math.max(0, snap(origX + dxMm));
      const nextY = Math.max(0, snap(origY + dyMm));
      updateElement(bandIdx, elIdx, { x: nextX, y: nextY });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const updateElement = (bandIdx: number, elIdx: number, patch: Partial<ElementDefinition>) => {
    const nextBands = template.bands.map((b, bi) => {
      if (bi !== bandIdx) return b;
      return {
        ...b,
        elements: b.elements.map((el, ei) => (ei === elIdx ? { ...el, ...patch } : el)),
      };
    });
    onChangeTemplate({ ...template, bands: nextBands });
  };

  const addElementToBand = (type: ElementType) => {
    const targetIdx = selectedBandIdx < template.bands.length ? selectedBandIdx : 0;
    const newEl: ElementDefinition =
      type === 'Text'
        ? {
            id: `txt-${Date.now().toString(36)}`,
            type: 'Text',
            x: 0,
            y: 2,
            width: 60,
            height: 6,
            value: 'New Text Label',
            fontSizePt: 9.5,
            fontWeight: 'Normal',
            color: '#0F172A',
            align: 'Left',
          }
        : type === 'Rectangle'
          ? {
              id: `rect-${Date.now().toString(36)}`,
              type: 'Rectangle',
              x: 0,
              y: 2,
              width: 80,
              height: 10,
              backgroundColor: '#F8FAFC',
              borderColor: '#CBD5E1',
            }
          : type === 'Line'
            ? {
                id: `line-${Date.now().toString(36)}`,
                type: 'Line',
                x: 0,
                y: 4,
                width: printableWidthMm,
                height: 0.4,
                color: '#94A3B8',
              }
            : type === 'QrCode'
              ? {
                  id: `qr-${Date.now().toString(36)}`,
                  type: 'QrCode',
                  x: printableWidthMm - 24,
                  y: 2,
                  width: 22,
                  height: 22,
                  expression: `="VERIFY|" + Parameters.${template.parameters?.[0]?.name ?? 'AccountNo'}`,
                }
              : {
                  id: `tbl-${Date.now().toString(36)}`,
                  type: 'Table',
                  x: 0,
                  y: 0,
                  width: printableWidthMm,
                  repeatHeaders: true,
                  columns: [
                    { header: 'Column 1', expression: '=Fields.Reference', width: 60, align: 'Left' },
                    { header: 'Amount', expression: '=Fields.Balance', width: 40, align: 'Right', format: 'N2' },
                  ],
                };

    const nextBands = template.bands.map((b, i) =>
      i === targetIdx ? { ...b, elements: [...b.elements, newEl] } : b
    );
    onChangeTemplate({ ...template, bands: nextBands });
    setSelectedBandIdx(targetIdx);
    setSelectedElIdx(template.bands[targetIdx].elements.length);
  };

  const deleteSelectedElement = () => {
    if (selectedElIdx === null || !selectedBand) return;
    const nextBands = template.bands.map((b, bi) => {
      if (bi !== selectedBandIdx) return b;
      return { ...b, elements: b.elements.filter((_, ei) => ei !== selectedElIdx) };
    });
    onChangeTemplate({ ...template, bands: nextBands });
    setSelectedElIdx(null);
  };

  const datasetFields = useMemo(() => {
    return (template.datasets ?? []).flatMap((ds) =>
      (ds.fields ?? []).map((f) => ({ dataset: ds.name, name: f.name, type: f.type }))
    );
  }, [template.datasets]);

  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let mm = 0; mm <= printableWidthMm; mm += 10) ticks.push(mm);
    return ticks;
  }, [printableWidthMm]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[248px_1fr_320px] h-[calc(100vh-57px)] overflow-hidden bg-slate-50">
      {/* Left Toolbox & Bindings */}
      <aside className="bg-white border-r border-slate-200 overflow-y-auto p-4 space-y-6">
        <div>
          <h2 className="text-xs font-semibold text-slate-900 mb-3">Report Toolbox</h2>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { type: 'Text', label: 'Text Box', icon: Type },
                { type: 'Table', label: 'Data Table', icon: Table2 },
                { type: 'Rectangle', label: 'Rectangle', icon: Square },
                { type: 'Line', label: 'Rule Line', icon: Minus },
                { type: 'QrCode', label: 'QR Block', icon: QrCode },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => addElementToBand(item.type)}
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-md transition-colors whitespace-nowrap"
                >
                  <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-slate-200 pt-4">
          <h2 className="text-xs font-semibold text-slate-900 mb-2">Report Parameters</h2>
          <div className="space-y-2.5">
            {(template.parameters ?? []).map((param) => (
              <div key={param.name}>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {param.name} · <span className="font-mono text-slate-400">{param.type}</span>
                </label>
                <input
                  type="text"
                  value={String(parameters[param.name] ?? param.defaultValue ?? '')}
                  onChange={(e) => onChangeParameter(param.name, e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-200 pt-4">
          <h2 className="text-xs font-semibold text-slate-900 mb-2">Dataset Field Bindings</h2>
          <div className="space-y-1">
            {datasetFields.map((f) => (
              <button
                key={`${f.dataset}.${f.name}`}
                type="button"
                onClick={() => {
                  if (selectedElement && selectedElement.type === 'Text' && selectedElIdx !== null) {
                    updateElement(selectedBandIdx, selectedElIdx, {
                      expression: `=Fields.${f.name}`,
                    });
                  }
                }}
                className="w-full flex items-center justify-between px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50 rounded border border-transparent hover:border-slate-200 transition-colors"
                title="Click to bind to selected Text element"
              >
                <span className="font-mono truncate">{f.name}</span>
                <span className="text-[11px] text-slate-400 shrink-0 ml-2">{f.type}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Center Interactive Surface */}
      <div className="flex flex-col overflow-hidden">
        {/* Canvas Toolbar */}
        <div className="h-11 bg-white border-b border-slate-200 px-4 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span>{template.page.size} {template.page.orientation}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{printableWidthMm}mm printable</span>
            <span aria-hidden="true">·</span>
            <span>{template.bands.length} bands</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              className="p-1.5 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              title="Undo"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              className="p-1.5 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              title="Redo"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() =>
                setInspectorTab((t) => (t === 'history' ? 'properties' : 'history'))
              }
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
                inspectorTab === 'history'
                  ? 'bg-slate-900 border-slate-900 text-white'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
              title="Toggle Version History panel"
            >
              <History className="w-3.5 h-3.5" />
              <span>Version History</span>
            </button>
            <button
              type="button"
              onClick={() => setSnapToGrid((s) => !s)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                snapToGrid
                  ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-600'
              }`}
            >
              <Grid className="w-3.5 h-3.5" />
              <span>Snap 2mm</span>
            </button>
            <div className="flex items-center border border-slate-200 rounded bg-white">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.75, Math.round((z - 0.1) * 10) / 10))}
                className="px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                -
              </button>
              <span className="px-2 text-xs font-mono tabular-nums text-slate-700">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(1.4, Math.round((z + 0.1) * 10) / 10))}
                className="px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable Sheet Canvas */}
        <div className="flex-1 overflow-auto p-8 flex justify-center">
          <div
            className="bg-white border border-slate-300 shadow-sm relative origin-top"
            style={{
              width: printableWidthMm * MM_TO_PX * zoom,
              minHeight: 780 * zoom,
              padding: 0,
            }}
          >
            {/* Horizontal mm Ruler */}
            <div className="h-6 bg-slate-100 border-b border-slate-200 relative select-none overflow-hidden">
              {rulerTicks.map((mm) => (
                <div
                  key={mm}
                  className="absolute top-0 bottom-0 border-l border-slate-300 text-[9px] font-mono tabular-nums text-slate-500 pl-1 pt-0.5"
                  style={{ left: mm * MM_TO_PX * zoom }}
                >
                  {mm}
                </div>
              ))}
            </div>

            {/* Report Bands */}
            <div className="divide-y divide-slate-200">
              {template.bands.map((band: BandDefinition, bIdx: number) => {
                const bandH = Math.max(band.height ?? (band.type === 'Detail' ? 38 : 16), 14);
                const isSelectedBand = bIdx === selectedBandIdx;
                return (
                  <div
                    key={band.id ?? `${band.type}-${bIdx}`}
                    onClick={() => {
                      setSelectedBandIdx(bIdx);
                      if (selectedBandIdx !== bIdx) setSelectedElIdx(band.elements.length > 0 ? 0 : null);
                    }}
                    className={`relative transition-colors ${
                      isSelectedBand ? 'bg-blue-50/15' : 'bg-white'
                    }`}
                  >
                    {/* Band Header Strip */}
                    <div className="px-3 py-1 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-slate-700">
                        {band.type}
                        {band.dataset ? (
                          <span className="font-normal text-slate-500"> · {band.dataset}</span>
                        ) : null}
                        {band.groupBy ? (
                          <span className="font-normal text-blue-700"> · GroupBy: {band.groupBy}</span>
                        ) : null}
                      </span>
                      <span className="font-mono tabular-nums text-slate-400">{bandH}mm</span>
                    </div>

                    {/* Band Design Surface */}
                    <div
                      className="relative overflow-hidden"
                      style={{
                        height: bandH * MM_TO_PX * zoom,
                        backgroundImage: snapToGrid
                          ? `radial-gradient(#cbd5e1 0.8px, transparent 0.8px)`
                          : undefined,
                        backgroundSize: `${5 * MM_TO_PX * zoom}px ${5 * MM_TO_PX * zoom}px`,
                      }}
                    >
                      {band.elements.map((el, eIdx) => {
                        const isSelected = isSelectedBand && selectedElIdx === eIdx;
                        const xPx = (el.x ?? 0) * MM_TO_PX * zoom;
                        const yPx = (el.y ?? 0) * MM_TO_PX * zoom;
                        const wPx = (el.width ?? printableWidthMm) * MM_TO_PX * zoom;
                        const hPx = (el.height ?? (el.type === 'Table' ? 28 : 6)) * MM_TO_PX * zoom;

                        if (el.type === 'Table') {
                          const cols = el.columns ?? [];
                          return (
                            <div
                              key={el.id ?? eIdx}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setSelectedBandIdx(bIdx);
                                setSelectedElIdx(eIdx);
                              }}
                              className={`absolute cursor-pointer border ${
                                isSelected ? 'border-blue-600 ring-1 ring-blue-600' : 'border-slate-300'
                              }`}
                              style={{ left: xPx, top: yPx, width: wPx, minHeight: hPx }}
                            >
                              <div className="flex bg-slate-900 text-white text-[10px] font-semibold">
                                {cols.map((col, ci) => (
                                  <div
                                    key={ci}
                                    className="px-2 py-1 truncate border-r border-slate-700 last:border-r-0"
                                    style={{
                                      flex: col.width ?? 1,
                                      textAlign: (col.align?.toLowerCase() as 'left' | 'center' | 'right') ?? 'left',
                                    }}
                                  >
                                    {col.header}
                                  </div>
                                ))}
                              </div>
                              <div className="flex bg-white text-[10px] font-mono text-slate-600">
                                {cols.map((col, ci) => (
                                  <div
                                    key={ci}
                                    className="px-2 py-1.5 truncate border-r border-slate-200 last:border-r-0"
                                    style={{
                                      flex: col.width ?? 1,
                                      textAlign: (col.align?.toLowerCase() as 'left' | 'center' | 'right') ?? 'left',
                                    }}
                                  >
                                    {col.expression}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={el.id ?? eIdx}
                            onMouseDown={(ev) =>
                              startElementDrag(ev, bIdx, eIdx, el.x ?? 0, el.y ?? 0)
                            }
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setSelectedBandIdx(bIdx);
                              setSelectedElIdx(eIdx);
                            }}
                            className={`absolute cursor-move select-none flex items-center px-1 overflow-hidden ${
                              isSelected
                                ? 'outline outline-2 outline-blue-600 bg-blue-50/40'
                                : 'hover:outline hover:outline-1 hover:outline-slate-400'
                            }`}
                            style={{
                              left: xPx,
                              top: yPx,
                              width: wPx,
                              height: Math.max(4, hPx),
                              backgroundColor: el.type === 'Rectangle' ? el.backgroundColor ?? 'transparent' : undefined,
                              border:
                                el.type === 'Rectangle'
                                  ? `1px solid ${el.borderColor ?? '#CBD5E1'}`
                                  : el.type === 'Line'
                                    ? undefined
                                    : undefined,
                              borderTop: el.type === 'Line' ? `1.5px solid ${el.color ?? '#CBD5E1'}` : undefined,
                            }}
                          >
                            {el.type === 'QrCode' ? (
                              <div className="w-full h-full border border-slate-300 bg-slate-50 flex flex-col items-center justify-center text-[9px] text-slate-600">
                                <QrCode className="w-5 h-5 text-slate-800" />
                                <span className="truncate max-w-full px-1">QR</span>
                              </div>
                            ) : el.type === 'Text' ? (
                              <span
                                className="w-full truncate"
                                style={{
                                  fontSize: `${Math.max(9, (el.fontSizePt ?? 9.5) * zoom * 1.15)}px`,
                                  fontWeight: el.fontWeight === 'Bold' ? 700 : el.fontWeight === 'SemiBold' ? 600 : 400,
                                  color: el.color ?? '#0F172A',
                                  textAlign: (el.align?.toLowerCase() as 'left' | 'center' | 'right') ?? 'left',
                                }}
                              >
                                {el.expression ?? el.value ?? ''}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Right Properties & Version History Inspector */}
      <aside className="bg-white border-l border-slate-200 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-slate-200 shrink-0">
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => setInspectorTab('properties')}
              className={`py-1.5 px-2 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                inspectorTab === 'properties'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Properties
            </button>
            <button
              type="button"
              onClick={() => setInspectorTab('history')}
              className={`py-1.5 px-2 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                inspectorTab === 'history'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Version History
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {inspectorTab === 'history' ? (
            <VersionHistoryPanel
              reportId={template.reportId}
              currentTemplate={template}
              activeSavedHash={activeSavedHash}
              revisionTick={revisionTick}
              onSaveSnapshot={async () => {
                if (onSaveRevision) await onSaveRevision();
              }}
              onRestoreSnapshot={(def) => {
                onChangeTemplate(def);
                setSelectedBandIdx(0);
                setSelectedElIdx(def.bands?.[0]?.elements?.length ? 0 : null);
              }}
            />
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div>
                  <h2 className="text-xs font-semibold text-slate-900">Properties Inspector</h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {selectedElement ? `${selectedBand?.type} · ${selectedElement.type}` : 'Select an element'}
                  </p>
                </div>
                {selectedElement ? (
                  <button
                    type="button"
                    onClick={deleteSelectedElement}
                    className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                    title="Delete element"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>

              {selectedElement && selectedElIdx !== null ? (
          <div className="space-y-4">
            {/* Geometry in mm */}
            <div>
              <h3 className="text-[11px] font-semibold text-slate-700 mb-2">Geometry (mm)</h3>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { key: 'x', label: 'X', val: selectedElement.x ?? 0 },
                    { key: 'y', label: 'Y', val: selectedElement.y ?? 0 },
                    { key: 'width', label: 'Width', val: selectedElement.width ?? printableWidthMm },
                    { key: 'height', label: 'Height', val: selectedElement.height ?? 6 },
                  ] as const
                ).map((coord) => (
                  <div key={coord.key}>
                    <label className="block text-[11px] text-slate-500 mb-1">{coord.label}</label>
                    <input
                      type="number"
                      step={snapToGrid ? 2 : 0.5}
                      value={coord.val}
                      onChange={(e) =>
                        updateElement(selectedBandIdx, selectedElIdx, {
                          [coord.key]: snap(Number(e.target.value)),
                        })
                      }
                      className="w-full px-2 py-1.5 text-xs font-mono tabular-nums border border-slate-200 rounded focus:outline-none focus:border-blue-600"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Value / Expression Editor */}
            {selectedElement.type !== 'Table' && selectedElement.type !== 'Line' && selectedElement.type !== 'Rectangle' ? (
              <div className="border-t border-slate-200 pt-4">
                <label className="block text-[11px] font-semibold text-slate-700 mb-1.5">
                  Value or Sandboxed Expression
                </label>
                <textarea
                  rows={3}
                  value={selectedElement.expression ?? selectedElement.value ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v.startsWith('=')) {
                      updateElement(selectedBandIdx, selectedElIdx, { expression: v, value: undefined });
                    } else {
                      updateElement(selectedBandIdx, selectedElIdx, { value: v, expression: undefined });
                    }
                  }}
                  className="w-full px-2.5 py-2 text-xs font-mono border border-slate-200 rounded bg-slate-50 focus:bg-white focus:outline-none focus:border-blue-600"
                  placeholder="=Fields.Balance or static text"
                />
                {compileStatus ? (
                  <div
                    className={`mt-2 p-2.5 rounded border text-[11px] ${
                      compileStatus.valid
                        ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
                        : 'bg-red-50 border-red-200 text-red-900'
                    }`}
                  >
                    <div className="font-semibold">
                      {compileStatus.valid ? 'AST Valid' : 'Compile Rejected'}
                    </div>
                    <div className="mt-0.5 text-[11px]">{compileStatus.message}</div>
                    {compileStatus.astType ? (
                      <div className="mt-1 font-mono text-[10px] text-emerald-700">
                        Root Node: {compileStatus.astType}
                        {compileStatus.fields && compileStatus.fields.length > 0
                          ? ` · Fields: ${compileStatus.fields.join(', ')}`
                          : ''}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Typography & Alignment */}
            {selectedElement.type === 'Text' ? (
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <h3 className="text-[11px] font-semibold text-slate-700">Typography & Format</h3>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Size (pt)</label>
                    <input
                      type="number"
                      step={0.5}
                      value={selectedElement.fontSizePt ?? 9.5}
                      onChange={(e) =>
                        updateElement(selectedBandIdx, selectedElIdx, {
                          fontSizePt: Number(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1.5 text-xs font-mono tabular-nums border border-slate-200 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Weight</label>
                    <select
                      value={selectedElement.fontWeight ?? 'Normal'}
                      onChange={(e) =>
                        updateElement(selectedBandIdx, selectedElIdx, {
                          fontWeight: e.target.value as ElementDefinition['fontWeight'],
                        })
                      }
                      className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded bg-white"
                    >
                      <option value="Normal">Normal</option>
                      <option value="SemiBold">SemiBold</option>
                      <option value="Bold">Bold</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Alignment</label>
                  <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-md">
                    {(['Left', 'Center', 'Right'] as const).map((al) => {
                      const Icon = al === 'Left' ? AlignLeft : al === 'Center' ? AlignCenter : AlignRight;
                      const active = (selectedElement.align ?? 'Left') === al;
                      return (
                        <button
                          key={al}
                          type="button"
                          onClick={() => updateElement(selectedBandIdx, selectedElIdx, { align: al })}
                          className={`flex items-center justify-center py-1 rounded text-xs ${
                            active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Format Mask</label>
                  <input
                    type="text"
                    value={selectedElement.format ?? ''}
                    placeholder="e.g. N2 or dd-MM-yyyy"
                    onChange={(e) =>
                      updateElement(selectedBandIdx, selectedElIdx, {
                        format: e.target.value || undefined,
                      })
                    }
                    className="w-full px-2 py-1.5 text-xs font-mono border border-slate-200 rounded"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">
                    Conditional Color Expression
                  </label>
                  <input
                    type="text"
                    value={selectedElement.colorExpression ?? ''}
                    placeholder='=IIf(Fields.Balance < 0, "#B91C1C", "#0F172A")'
                    onChange={(e) =>
                      updateElement(selectedBandIdx, selectedElIdx, {
                        colorExpression: e.target.value || undefined,
                      })
                    }
                    className="w-full px-2 py-1.5 text-xs font-mono border border-slate-200 rounded"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedElement.canGrow)}
                    onChange={(e) =>
                      updateElement(selectedBandIdx, selectedElIdx, {
                        canGrow: e.target.checked,
                      })
                    }
                    className="rounded border-slate-300"
                  />
                  <span>CanGrow (Word-wrap & expand height)</span>
                </label>
              </div>
            ) : null}

            {/* Table Columns Editor */}
            {selectedElement.type === 'Table' ? (
              <div className="border-t border-slate-200 pt-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold text-slate-700">Table Columns</h3>
                  <button
                    type="button"
                    onClick={() => {
                      const nextCols = [
                        ...(selectedElement.columns ?? []),
                        { header: 'New Col', expression: '=Fields.Reference', width: 25, align: 'Left' as const },
                      ];
                      updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                    }}
                    className="flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:underline"
                  >
                    <Plus className="w-3 h-3" /> Add Column
                  </button>
                </div>
                <div className="space-y-2">
                  {(selectedElement.columns ?? []).map((col, ci) => (
                    <div key={ci} className="p-2.5 border border-slate-200 rounded bg-slate-50 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <input
                          type="text"
                          value={col.header}
                          onChange={(e) => {
                            const nextCols = (selectedElement.columns ?? []).map((c, idx) =>
                              idx === ci ? { ...c, header: e.target.value } : c
                            );
                            updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                          }}
                          className="w-full px-2 py-1 text-xs font-medium border border-slate-200 rounded bg-white"
                        />
                        <input
                          type="number"
                          value={col.width ?? 25}
                          onChange={(e) => {
                            const nextCols = (selectedElement.columns ?? []).map((c, idx) =>
                              idx === ci ? { ...c, width: Number(e.target.value) } : c
                            );
                            updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                          }}
                          className="w-14 px-1.5 py-1 text-xs font-mono tabular-nums border border-slate-200 rounded bg-white"
                          title="Column width (mm)"
                        />
                      </div>
                      <input
                        type="text"
                        value={col.expression}
                        onChange={(e) => {
                          const nextCols = (selectedElement.columns ?? []).map((c, idx) =>
                            idx === ci ? { ...c, expression: e.target.value } : c
                          );
                          updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                        }}
                        className="w-full px-2 py-1 text-[11px] font-mono border border-slate-200 rounded bg-white"
                      />
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <select
                          value={col.summary ?? 'None'}
                          onChange={(e) => {
                            const val = e.target.value as 'None' | 'Sum' | 'Count' | 'Avg' | 'Last';
                            const nextCols = (selectedElement.columns ?? []).map((c, idx) =>
                              idx === ci ? { ...c, summary: val === 'None' ? undefined : val } : c
                            );
                            updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                          }}
                          className="px-2 py-1 text-[11px] border border-slate-200 rounded bg-white"
                          title="Footer summary aggregation"
                        >
                          <option value="None">Summary: None</option>
                          <option value="Sum">Summary: Sum</option>
                          <option value="Count">Summary: Count</option>
                          <option value="Avg">Summary: Avg</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(col.canGrow)}
                            onChange={(e) => {
                              const nextCols = (selectedElement.columns ?? []).map((c, idx) =>
                                idx === ci ? { ...c, canGrow: e.target.checked } : c
                              );
                              updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                            }}
                          />
                          <span>CanGrow</span>
                        </label>
                      </div>
                      <input
                        type="text"
                        value={col.colorExpression ?? ''}
                        placeholder='Color expr e.g. =IIf(Fields.Balance < 0, "#B91C1C", "#0F172A")'
                        onChange={(e) => {
                          const nextCols = (selectedElement.columns ?? []).map((c, idx) =>
                            idx === ci ? { ...c, colorExpression: e.target.value || undefined } : c
                          );
                          updateElement(selectedBandIdx, selectedElIdx, { columns: nextCols });
                        }}
                        className="w-full px-2 py-1 text-[11px] font-mono border border-slate-200 rounded bg-white"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
              ) : (
                <div className="text-xs text-slate-500 py-8 text-center">
                  Select an element on the report canvas to inspect geometry, bindings, and AST expression rules.
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
};
