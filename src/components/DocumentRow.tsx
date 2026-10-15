import { FolderOpen } from "lucide-react";
import { formatRelativeDate } from "../data/format";
import type { KnowledgeDocument } from "../types";
import { LocalOpenButton } from "./LocalRuntimeProvider";
import { typeClass } from "./shared";

export function FacetChips({ document, limit = 2 }: { document: KnowledgeDocument; limit?: number }) {
  const chips = [
    ...document.solutionTracks.slice(0, limit),
    ...document.customers.slice(0, 1).map((customer) => `客户 · ${customer}`),
    ...document.events.slice(0, 1),
  ].slice(0, limit + 1);
  if (chips.length === 0) return <div className="document-row__topics"><span className="facet-chip facet-chip--muted">待整理</span></div>;
  return (
    <div className="document-row__topics">
      {chips.map((chip) => <span key={chip} className="facet-chip">{chip}</span>)}
    </div>
  );
}

export function DocumentRow({
  document,
  compact = false,
}: {
  document: KnowledgeDocument;
  compact?: boolean;
}) {
  return (
    <article className={`document-row ${compact ? "document-row--compact" : ""}`}>
      <span className={typeClass(document.type)}>{document.type}</span>
      <div className="document-row__main">
        <strong title={document.title}>{document.title}</strong>
        <span><FolderOpen size={12} /> {document.relativePath}</span>
      </div>
      {!compact && <FacetChips document={document} />}
      <div className="document-row__meta">
        <span>{document.sourceLabel}</span>
        <time dateTime={document.modifiedAt}>{formatRelativeDate(document.modifiedAt)}</time>
      </div>
      <LocalOpenButton id={document.id} title={document.title} extension={document.type} compact={compact} />
    </article>
  );
}
