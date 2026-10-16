import { useMemo, useState } from "react";
import { AtSign, Bell, Link2, Unlink, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { dingtalkBoard } from "../../lib/crm-model";
import type { GroupItem } from "../../lib/crm-types";
import { ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CrmGate, MetricCard, RefreshControl, SourceBanner, formatDateTime, formatGaap } from "./crm-shared";

const PANEL_LIMIT = 30;

function GroupLine({ group, icon: Icon, note }: { group: GroupItem; icon: LucideIcon; note: string }) {
  return (
    <li className="crm-dt-pair">
      <Icon size={14} />
      <div>
        <strong>{group.name}</strong>
        <span>{note}</span>
      </div>
      <small>{group.memberCount} 人</small>
    </li>
  );
}

function LinkPanel({
  eyebrow,
  title,
  note,
  total,
  expanded,
  onToggle,
  children,
}: {
  eyebrow: string;
  title: string;
  note: string;
  total: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="panel crm-dt-panel">
      <header className="panel__header">
        <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
        <span>{note}</span>
      </header>
      {children}
      {total > PANEL_LIMIT && (
        <button className="text-button crm-more" onClick={onToggle}>
          {expanded ? "收起" : `展开全部 ${total}`}
        </button>
      )}
    </section>
  );
}

export function DingtalkView() {
  const { snapshot } = useCrm();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));
  const slice = <T,>(key: string, items: T[]): T[] => (expanded[key] ? items : items.slice(0, PANEL_LIMIT));

  const view = useMemo(() => {
    if (!snapshot) return null;
    const board = dingtalkBoard(snapshot);
    const linked = board.links.filter((link) => link.status === "linked");
    const unconfirmed = board.links.filter((link) => link.status === "unconfirmed");
    return { board, linked, unconfirmed, coveredCount: snapshot.customers.length - board.missingCustomers.length };
  }, [snapshot]);

  const groupsPartial = snapshot !== null && snapshot.sources.groups?.status !== "ok";

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / DINGTALK"
        title="钉群盘面"
        description="钉钉群与客户的名称匹配、近 14 天 @我 与未读会话；匹配结果仅供人工核对，不写回任何外部系统。"
        aside={<RefreshControl />}
      />
      <CrmGate>
        {snapshot && view && (
          <>
            <SourceBanner keys={["groups", "mentions", "unread", "customers"]} />

            <section className="metric-grid crm-metrics crm-metrics--four" aria-label="钉群概况">
              <MetricCard
                label="钉钉群"
                value={String(snapshot.groups.length)}
                note={groupsPartial ? "群列表分页不完整，匹配可能漏群" : "全部已抓取群"}
                warning={groupsPartial && snapshot.groups.length > 0}
              />
              <MetricCard
                label="已关联客户群"
                value={String(view.linked.length)}
                note={`覆盖 ${view.coveredCount} / ${snapshot.customers.length} 个客户`}
                primary
              />
              <MetricCard
                label="待确认匹配"
                value={String(view.unconfirmed.length)}
                note="疑似命名匹配，需人工确认"
              />
              <MetricCard
                label="@我 · 14 天"
                value={String(view.board.mentions.length)}
                note={`另有 ${snapshot.unread.length} 个未读会话`}
              />
            </section>

            <div className="crm-dt-grid">
              <LinkPanel
                eyebrow="LINKED"
                title="已关联客户群"
                note={`${view.linked.length} 个群`}
                total={view.linked.length}
                expanded={expanded.linked ?? false}
                onToggle={() => toggle("linked")}
              >
                {view.linked.length === 0
                  ? <p className="crm-muted">暂无已关联的群。</p>
                  : (
                    <ul>
                      {slice("linked", view.linked).map((link) => (
                        <GroupLine key={link.group.id} group={link.group} icon={Link2} note={`→ ${link.customer.name}`} />
                      ))}
                    </ul>
                  )}
              </LinkPanel>

              <LinkPanel
                eyebrow="REVIEW"
                title="待确认匹配"
                note={`${view.unconfirmed.length} 个群`}
                total={view.unconfirmed.length}
                expanded={expanded.unconfirmed ?? false}
                onToggle={() => toggle("unconfirmed")}
              >
                {view.unconfirmed.length === 0
                  ? <p className="crm-muted">没有疑似匹配的群。</p>
                  : (
                    <ul>
                      {slice("unconfirmed", view.unconfirmed).map((link) => (
                        <GroupLine key={link.group.id} group={link.group} icon={Users} note={`疑似「${link.customer.name}」，请人工确认`} />
                      ))}
                    </ul>
                  )}
              </LinkPanel>

              <LinkPanel
                eyebrow="UNMATCHED GROUPS"
                title="未匹配群组"
                note={`${view.board.unlinked.length} 个群`}
                total={view.board.unlinked.length}
                expanded={expanded.unlinked ?? false}
                onToggle={() => toggle("unlinked")}
              >
                {view.board.unlinked.length === 0
                  ? <p className="crm-muted">所有群都匹配到了客户。</p>
                  : (
                    <ul>
                      {slice("unlinked", view.board.unlinked).map((group) => (
                        <GroupLine key={group.id} group={group} icon={Unlink} note="未匹配到客户" />
                      ))}
                    </ul>
                  )}
              </LinkPanel>

              <LinkPanel
                eyebrow="CUSTOMERS WITHOUT GROUPS"
                title="无群组客户"
                note={`${view.board.missingCustomers.length} 个客户`}
                total={view.board.missingCustomers.length}
                expanded={expanded.missing ?? false}
                onToggle={() => toggle("missing")}
              >
                {view.board.missingCustomers.length === 0
                  ? <p className="crm-muted">所有客户都有已识别的群。</p>
                  : (
                    <ul>
                      {slice("missing", view.board.missingCustomers).map((customer) => (
                        <li key={customer.cid} className="crm-dt-pair">
                          <Users size={14} />
                          <div>
                            <strong>{customer.name}</strong>
                            <span>
                              {[customer.industry, customer.level].filter(Boolean).join(" · ") || "—"}
                            </span>
                          </div>
                          <small>{formatGaap(customer.lastMonthGaap)}</small>
                        </li>
                      ))}
                    </ul>
                  )}
              </LinkPanel>

              <LinkPanel
                eyebrow="AT ME · 14 DAYS"
                title="@我 的消息"
                note={`${view.board.mentions.length} 条`}
                total={view.board.mentions.length}
                expanded={expanded.mentions ?? false}
                onToggle={() => toggle("mentions")}
              >
                {view.board.mentions.length === 0
                  ? <p className="crm-muted">近 14 天没有 @我 的消息。</p>
                  : (
                    <ul>
                      {slice("mentions", view.board.mentions).map((mention) => (
                        <li key={mention.id} className="crm-dt-mention">
                          <AtSign size={14} />
                          <div>
                            <strong>{mention.text || "（无内容）"}</strong>
                            <span>
                              {[mention.conversationName, mention.sender].filter(Boolean).join(" · ") || "钉钉 @我"}
                            </span>
                          </div>
                          <time>{formatDateTime(mention.time)}</time>
                        </li>
                      ))}
                    </ul>
                  )}
              </LinkPanel>

              <LinkPanel
                eyebrow="UNREAD"
                title="未读会话"
                note={`${snapshot.unread.length} 个会话`}
                total={snapshot.unread.length}
                expanded={expanded.unread ?? false}
                onToggle={() => toggle("unread")}
              >
                {snapshot.unread.length === 0
                  ? <p className="crm-muted">没有未读会话。</p>
                  : (
                    <ul>
                      {slice("unread", snapshot.unread).map((item) => (
                        <li key={item.id} className="crm-dt-pair">
                          <Bell size={14} />
                          <div>
                            <strong>{item.name ?? "未命名会话"}</strong>
                            {item.name === null && <span>{item.id.slice(0, 16)}…</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
              </LinkPanel>
            </div>
          </>
        )}
      </CrmGate>
    </div>
  );
}
