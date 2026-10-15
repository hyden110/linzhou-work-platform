import { AlertTriangle, BadgeCheck, ChevronRight, Link2, Quote, Users } from "lucide-react";
import type { YunqiEvidence, YunqiForum, YunqiHighlights, YunqiTrend } from "../types";

export function EvidenceChips({ evidence, onJump }: { evidence: YunqiEvidence[]; onJump: (anchor: string) => void }) {
  if (evidence.length === 0) return null;
  return (
    <div className="evidence-chips">
      {evidence.map((item) => (
        <button
          key={item.anchor ?? item.label}
          type="button"
          onClick={() => item.anchor && onJump(item.anchor)}
          disabled={!item.anchor}
          title={item.anchor ? `跳转到发言卡 ${item.anchor}` : "该证据没有可跳转的发言卡"}
        >
          <Link2 size={11} /> {item.label}
        </button>
      ))}
    </div>
  );
}

export function TrendCard({ trend, onJump }: { trend: YunqiTrend; onJump: (anchor: string) => void }) {
  return (
    <article className="yunqi-trend">
      <header>
        <span className="yunqi-trend__index">{String(trend.index).padStart(2, "0")}</span>
        <div>
          <h4>{trend.title}</h4>
          <small>{trend.groupBadge} · {trend.groupHeading}</small>
        </div>
      </header>
      <p>{trend.body}</p>
      <EvidenceChips evidence={trend.evidence} onJump={onJump} />
    </article>
  );
}

export function SynthesisCard({ item, onJump }: { item: YunqiHighlights["synthesis"][number]; onJump: (anchor: string) => void }) {
  return (
    <article className="yunqi-synthesis">
      <header><Quote size={15} /><h4>{item.title}</h4><span>{String(item.index).padStart(2, "0")}</span></header>
      <p>{item.body}</p>
      <EvidenceChips evidence={item.evidence} onJump={onJump} />
    </article>
  );
}

function TalkRow({ talk }: { talk: YunqiForum["talks"][number] }) {
  return (
    <article className={`yunqi-talk ${talk.key ? "yunqi-talk--key" : ""}`} id={talk.id}>
      <div className="yunqi-talk__head">
        <strong>{talk.who}</strong>
        <span>{talk.role}</span>
        {talk.key && <em><BadgeCheck size={12} /> 回放核验</em>}
      </div>
      <h5>{talk.title}</h5>
      <p>{talk.headline}</p>
      {talk.tags.length > 0 && <div className="yunqi-talk__tags">{talk.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
    </article>
  );
}

export function ForumCard({ forum }: { forum: YunqiForum }) {
  return (
    <details className="yunqi-forum">
      <summary>
        <ChevronRight size={15} />
        <div>
          <h4>{forum.title}</h4>
          <span className="yunqi-forum__meta">{forum.meta.join(" · ")}</span>
        </div>
        <b><Users size={12} /> {forum.talkCount}</b>
      </summary>
      <div className="yunqi-forum__body">
        <p className="yunqi-forum__lead">{forum.lead}</p>
        {forum.sections.map((section) => (
          <section key={section.heading}>
            <h5>{section.heading}</h5>
            <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        ))}
        <div className="yunqi-forum__talks">
          {forum.talks.map((talk) => <TalkRow key={talk.id} talk={talk} />)}
        </div>
        {forum.notes.length > 0 && (
          <div className="yunqi-notes"><span>整理说明</span>{forum.notes.map((note) => <p key={note}>{note}</p>)}</div>
        )}
        {forum.gapNotes.length > 0 && (
          <div className="yunqi-gaps">
            {forum.gapNotes.map((note) => <p key={note}><AlertTriangle size={12} /> {note}</p>)}
          </div>
        )}
      </div>
    </details>
  );
}

export function MethodPanel({ method }: { method: YunqiHighlights["method"] }) {
  return (
    <div className="yunqi-method">
      {method.sections.map((section) => (
        <details key={section.heading} open={section.heading === "可信度规则"}>
          <summary><ChevronRight size={14} /> {section.heading}</summary>
          <div>
            {section.body && <p>{section.body}</p>}
            {section.rows.length > 0 && <ul>{section.rows.map((row) => <li key={row}>{row}</li>)}</ul>}
          </div>
        </details>
      ))}
    </div>
  );
}
