import React, { useEffect, useState } from 'react';
import { Check, Copy, FileCode2, Folder } from 'lucide-react';

interface SolutionFile {
  path: string;
  size: number;
}

export const DotnetSolutionBrowser: React.FC = () => {
  const [files, setFiles] = useState<SolutionFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('UniversalReport.sln');
  const [content, setContent] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/v1/dotnet/tree')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.files)) {
          setFiles(data.files);
          if (data.files.length > 0 && !data.files.some((f: SolutionFile) => f.path === selectedPath)) {
            setSelectedPath(data.files[0].path);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedPath) return;
    setLoadingFile(true);
    fetch(`/api/v1/dotnet/file?path=${encodeURIComponent(selectedPath)}`)
      .then((r) => r.json())
      .then((data) => {
        setContent(data.content ?? '');
      })
      .finally(() => setLoadingFile(false));
  }, [selectedPath]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] h-[calc(100vh-57px)] bg-slate-50 overflow-hidden">
      {/* File Tree */}
      <aside className="bg-white border-r border-slate-200 overflow-y-auto p-4">
        <div className="mb-3 pb-3 border-b border-slate-200">
          <h2 className="text-xs font-semibold text-slate-900">
            NuGet SDK Solution Explorer
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
            net8.0 · net9.0 · net10.0 · {files.length} files
          </p>
          <div className="mt-2.5 p-2 bg-slate-900 text-slate-100 rounded text-[11px] font-mono select-all">
            dotnet add package UniversalReport
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            IDEs: VS 2017–2022+ (.sln) · VS Code (.vscode) · Linux/Docker
          </div>
        </div>

        <div className="space-y-0.5">
          {files.map((f) => {
            const active = f.path === selectedPath;
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedPath(f.path)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded text-left text-xs transition-colors ${
                  active
                    ? 'bg-blue-50 text-blue-800 font-medium'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {f.path.includes('/') ? (
                    <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  )}
                  <span className="truncate font-mono text-[11px]">{f.path}</span>
                </span>
                <span className="text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
                  {f.size}B
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Code Viewer */}
      <div className="flex flex-col overflow-hidden bg-slate-950 text-slate-100">
        <div className="h-11 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between gap-4 shrink-0">
          <span className="text-xs font-mono text-slate-300 truncate">{selectedPath}</span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied' : 'Copy Source'}</span>
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {loadingFile ? (
            <div className="text-xs font-mono text-slate-400">Loading source...</div>
          ) : (
            <pre className="text-xs font-mono leading-relaxed text-slate-100 whitespace-pre">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
