import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, FileText, X } from "lucide-react";
import {
  fetchLocalPreview,
  fetchLocalStatus,
  localErrorMessage,
  openLocalDocument,
  type LocalPreview,
} from "../lib/local-client";
import type { LocalRuntimeStatus } from "../types";

const PREVIEWABLE = new Set(["PDF", "MD"]);
const TOAST_TIMEOUT_MS = 4_200;

interface LocalRuntime {
  status: LocalRuntimeStatus;
  busyId: string;
  canPreview(extension: string): boolean;
  open(id: string, title: string): void;
  preview(id: string, title: string, extension: string): void;
}

const OFFLINE: LocalRuntimeStatus = { available: false, open: false, preview: false };

interface Toast {
  tone: "success" | "error";
  text: string;
}

interface PreviewState {
  title: string;
  extension: string;
  content: LocalPreview;
}

const LocalRuntimeContext = createContext<LocalRuntime>({
  status: OFFLINE,
  busyId: "",
  canPreview: () => false,
  open: () => undefined,
  preview: () => undefined,
});

export function useLocalRuntime(): LocalRuntime {
  return useContext(LocalRuntimeContext);
}

export function LocalRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LocalRuntimeStatus>(OFFLINE);
  const [busyId, setBusyId] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const previewUrl = useRef<string | undefined>(undefined);
  const closePreviewRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const controller = new AbortController();
    fetchLocalStatus().then((next) => {
      if (!controller.signal.aborted) setStatus(next);
    });
    return () => controller.abort();
  }, []);

  const releasePreviewUrl = useCallback(() => {
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = undefined;
    }
  }, []);

  const closePreview = useCallback(() => {
    setPreviewState(null);
    releasePreviewUrl();
  }, [releasePreviewUrl]);

  closePreviewRef.current = closePreview;

  useEffect(() => () => closePreviewRef.current(), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!previewState) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewState, closePreview]);

  const open = useCallback((id: string, title: string) => {
    if (!status.open || busyId) return;
    setBusyId(id);
    openLocalDocument(id)
      .then((opened) => setToast({ tone: "success", text: `已调用本机默认应用打开《${title}》（${opened.extension}）` }))
      .catch((error: unknown) => setToast({ tone: "error", text: localErrorMessage(error) }))
      .finally(() => setBusyId(""));
  }, [busyId, status.open]);

  const preview = useCallback((id: string, title: string, extension: string) => {
    if (!status.preview || busyId) return;
    setBusyId(id);
    fetchLocalPreview(id)
      .then((content) => {
        releasePreviewUrl();
        previewUrl.current = content.url;
        setPreviewState({ title, extension, content });
      })
      .catch((error: unknown) => setToast({ tone: "error", text: localErrorMessage(error) }))
      .finally(() => setBusyId(""));
  }, [busyId, releasePreviewUrl, status.preview]);

  const value = useMemo<LocalRuntime>(() => ({
    status,
    busyId,
    canPreview: (extension: string) => status.preview && PREVIEWABLE.has(extension.toUpperCase()),
    open,
    preview,
  }), [busyId, open, preview, status]);

  return (
    <LocalRuntimeContext.Provider value={value}>
      {children}

      {previewState && (
        <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={`预览 ${previewState.title}`}>
          <div className="preview-panel">
            <header className="preview-panel__header">
              <span className={previewState.extension === "PDF" ? "file-type file-type--pdf" : "file-type file-type--md"}>
                {previewState.extension}
              </span>
              <div>
                <strong title={previewState.title}>{previewState.title}</strong>
                <small>本机文件 · 未上传 · 仅在这台电脑上渲染</small>
              </div>
              <button className="icon-button" onClick={closePreview} aria-label="关闭预览" autoFocus><X size={18} /></button>
            </header>
            <div className="preview-panel__body">
              {previewState.content.kind === "pdf"
                ? <iframe src={previewState.content.url} title={previewState.title} />
                : <pre>{previewState.content.text}</pre>}
            </div>
            <footer className="preview-panel__footer">
              <span><FileText size={13} /> 浏览器内预览仅支持 PDF 与 Markdown；PPT、Word、Excel 请用本机应用打开。</span>
              <button className="secondary-button" onClick={closePreview}>关闭</button>
            </footer>
          </div>
        </div>
      )}

      {toast && (
        <div className={`local-toast local-toast--${toast.tone}`} role="status">
          {toast.tone === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="关闭提示"><X size={14} /></button>
        </div>
      )}
    </LocalRuntimeContext.Provider>
  );
}

export function LocalOpenButton({
  id,
  title,
  extension,
  compact = false,
}: {
  id: string;
  title: string;
  extension: string;
  compact?: boolean;
}) {
  const runtime = useLocalRuntime();
  const busy = runtime.busyId === id;

  if (!runtime.status.available) {
    return (
      <button
        className="icon-button"
        disabled
        title="本机打开能力仅在工作台运行于这台电脑时可用"
        aria-label={`${title} 无法打开：当前不是本机运行环境`}
      >
        <ExternalLink size={compact ? 15 : 17} />
      </button>
    );
  }

  return (
    <span className="document-actions">
      {runtime.canPreview(extension) && (
        <button
          className="icon-button"
          onClick={() => runtime.preview(id, title, extension)}
          disabled={busy}
          title="在浏览器内预览"
          aria-label={`预览 ${title}`}
        >
          <FileText size={compact ? 15 : 17} />
        </button>
      )}
      <button
        className="icon-button icon-button--accent"
        onClick={() => runtime.open(id, title)}
        disabled={busy || !runtime.status.open}
        title={busy ? "正在打开…" : "用本机默认应用打开"}
        aria-label={`在本机打开 ${title}`}
      >
        {busy ? <span className="spin-dot" /> : <ExternalLink size={compact ? 15 : 17} />}
      </button>
    </span>
  );
}
