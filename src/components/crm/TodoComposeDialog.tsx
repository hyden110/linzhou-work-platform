import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, LoaderCircle, X } from "lucide-react";
import { createTodo, dingtalkErrorMessage } from "../../lib/dingtalk-client";
import type { TodoPriority, TodoWriteRecord } from "../../lib/dingtalk-types";
import { useCrm } from "./CrmProvider";
import { formatDateTime } from "./crm-shared";

const PRIORITY_LABELS: Record<TodoPriority, string> = {
  10: "低",
  20: "普通",
  30: "较高",
  40: "紧急",
};

const PRIORITIES: TodoPriority[] = [10, 20, 30, 40];

function defaultDueInput(): string {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}T18:00`;
}

function newRequestId(): string {
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `todo-${uuid}`;
}

type Step = "form" | "confirm" | "done";

export function TodoComposeDialog({
  open,
  onClose,
  prefillTitle,
}: {
  open: boolean;
  onClose: () => void;
  prefillTitle?: string;
}) {
  const { refreshNow } = useCrm();
  const [step, setStep] = useState<Step>("form");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState(defaultDueInput);
  const [priority, setPriority] = useState<TodoPriority>(20);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<TodoWriteRecord | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setTitle((prefillTitle ?? "").slice(0, 200));
    setDueAt(defaultDueInput());
    setPriority(20);
    setRequestId("");
    setBusy(false);
    setError("");
    setCreated(null);
    const timer = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open, prefillTitle]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const next = () => {
    const clean = title.trim();
    if (!clean) {
      setError("请填写待办标题。");
      return;
    }
    if (!dueAt || Number.isNaN(new Date(dueAt).getTime())) {
      setError("请选择有效的截止时间。");
      return;
    }
    setTitle(clean);
    setError("");
    setRequestId(newRequestId());
    setStep("confirm");
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await createTodo({
        requestId,
        title,
        dueAt: new Date(dueAt).toISOString(),
        priority,
        executor: "self",
      });
      setCreated(outcome.record);
      setStep("done");
      refreshNow();
    } catch (caught) {
      setError(dingtalkErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="crm-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="crm-modal__panel" role="dialog" aria-modal="true" aria-labelledby="todo-dialog-title">
        <header className="crm-modal__header">
          <div>
            <span className="eyebrow">NEW TODO</span>
            <h2 id="todo-dialog-title">新建待办</h2>
          </div>
          <button className="crm-modal__close" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        {step === "form" && (
          <>
            <div className="crm-modal__body">
              <label className="crm-field">
                <span>标题</span>
                <input
                  ref={titleRef}
                  value={title}
                  maxLength={200}
                  placeholder="例如：示例客户-部署问题-跟进"
                  onChange={(event) => setTitle(event.target.value)}
                />
                <small>{title.length} / 200</small>
              </label>
              <label className="crm-field">
                <span>截止时间</span>
                <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
              </label>
              <label className="crm-field">
                <span>优先级</span>
                <select value={priority} onChange={(event) => setPriority(Number(event.target.value) as TodoPriority)}>
                  {PRIORITIES.map((value) => (
                    <option key={value} value={value}>{value} · {PRIORITY_LABELS[value]}</option>
                  ))}
                </select>
              </label>
              <div className="crm-field crm-field--readonly">
                <span>执行人</span>
                <strong>本人（钉钉当前登录账号）</strong>
              </div>
              {error && <p className="crm-modal__error" role="alert">{error}</p>}
            </div>
            <footer className="crm-modal__footer">
              <button className="text-button" onClick={onClose}>取消</button>
              <button className="primary-button" onClick={next}>下一步：逐项确认</button>
            </footer>
          </>
        )}

        {step === "confirm" && (
          <>
            <div className="crm-modal__body">
              <p className="crm-modal__note">请核对以下字段。确认后先在钉钉做只读预演，预演通过才创建，创建后读回校验。</p>
              <dl className="crm-confirm">
                <div><dt>标题</dt><dd>{title}</dd></div>
                <div><dt>截止</dt><dd>{formatDateTime(dueAt)}</dd></div>
                <div><dt>优先级</dt><dd>{priority} · {PRIORITY_LABELS[priority]}</dd></div>
                <div><dt>执行人</dt><dd>本人（钉钉当前登录账号）</dd></div>
              </dl>
              {error && <p className="crm-modal__error" role="alert">{error}</p>}
            </div>
            <footer className="crm-modal__footer">
              <button className="text-button" onClick={() => { setStep("form"); setError(""); }} disabled={busy}>
                返回修改
              </button>
              <button className="primary-button" onClick={() => void submit()} disabled={busy || !requestId}>
                {busy ? <LoaderCircle className="spin" size={14} /> : null}
                {busy ? "创建中…" : "确认创建"}
              </button>
            </footer>
          </>
        )}

        {step === "done" && created && (
          <>
            <div className="crm-modal__body crm-modal__done">
              <CheckCircle2 size={28} />
              <p><strong>待办已创建</strong></p>
              <dl className="crm-confirm">
                <div><dt>标题</dt><dd>{created.title}</dd></div>
                <div><dt>截止</dt><dd>{formatDateTime(created.dueAt)}</dd></div>
                <div><dt>任务 ID</dt><dd className="crm-mono">{created.taskId}</dd></div>
              </dl>
              <p className="crm-modal__note">已触发客户快照刷新，刷新完成后会出现在待办列表。</p>
            </div>
            <footer className="crm-modal__footer">
              <button className="primary-button" onClick={onClose}>完成</button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
