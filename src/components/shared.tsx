import { RetrievalClientError, type RetrievalResponse } from "../lib/retrieval-client";
import type { KnowledgeDocument, KnowledgeIndex, ShelfId, ViewId } from "../types";

export interface ViewProps {
  index: KnowledgeIndex;
  documents: KnowledgeDocument[];
  onNavigate: (view: ViewId, shelf?: ShelfId, group?: string) => void;
}

export function numberedAnswer(result: RetrievalResponse): string {
  const numbers = new Map(result.citations.map((citation, index) => [citation.referenceId, index + 1]));
  return (result.answer ?? "").replace(/\[([^\[\]]+)\]/g, (mark, id: string) => {
    const number = numbers.get(id);
    return number ? `[${number}]` : mark;
  });
}

export const typeClass = (type: string) => `file-type file-type--${type.toLowerCase()}`;

export function retrievalErrorMessage(error: unknown): string {
  if (!(error instanceof RetrievalClientError)) return "AI 问答暂时不可用，请稍后重试。";
  const messages: Record<string, string> = {
    network_unavailable: "AI 服务未启动，请先运行本地 Function。",
    origin_not_allowed: "当前页面来源未获本地 AI 服务授权。",
    request_timeout: "AI 回答超时，请稍后重试。",
    rate_limited: "请求过于频繁，请稍后再试。",
    retrieval_unavailable: "知识检索服务暂时不可用。",
  };
  const message = messages[error.code] ?? "AI 问答暂时不可用，请稍后重试。";
  return error.diagnosticId ? `${message} 诊断编号：${error.diagnosticId}` : message;
}

export function ViewHeading({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: React.ReactNode;
}) {
  return (
    <header className="view-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {aside}
    </header>
  );
}

export function StatusBadge({
  children,
  tone = "green",
}: {
  children: React.ReactNode;
  tone?: "green" | "amber" | "blue" | "muted";
}) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
