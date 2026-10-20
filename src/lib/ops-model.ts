import type { OpsItem, OpsSourceStatus, OpsSourceType } from "./ops-types";

/** Per-item source badges on the 7-day board. */
export const OPS_SOURCE_BADGES: Record<OpsSourceType, string> = {
  blog: "Qoder 博客",
  changelog: "产品更新",
  announcement: "官方公告",
  qianzai: "千仔讯息",
};

export const OPS_SOURCE_ORDER: readonly OpsSourceType[] = ["blog", "changelog", "announcement", "qianzai"];

export function opsStatusTone(status: OpsSourceStatus["status"]): "green" | "amber" | "muted" {
  if (status === "ok") return "green";
  if (status === "missing") return "muted";
  return "amber";
}

export function opsStatusLabel(status: OpsSourceStatus["status"]): string {
  const labels: Record<OpsSourceStatus["status"], string> = {
    ok: "正常",
    partial: "部分数据",
    error: "读取失败",
    auth_required: "待授权",
    missing: "未同步",
  };
  return labels[status];
}

function localDayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function itemDayKey(item: OpsItem): string | null {
  if (!item.publishedAt) return null;
  const date = new Date(item.publishedAt.includes("T") ? item.publishedAt : item.publishedAt.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : localDayKey(date);
}

export interface OpsDayBoard {
  readonly key: string;
  readonly label: string;
  readonly isToday: boolean;
  readonly items: readonly OpsItem[];
  /** Honest explanation shown under the bucket heading (null for normal days). */
  readonly note: string | null;
}

function dayLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  const weekday = date.toLocaleDateString("zh-CN", { weekday: "short" });
  return `${key}（${weekday}）`;
}

/** Group the last ``days`` days of dated items into day buckets, newest day first.
 *
 * Items without a usable publishedAt (e.g. announcements whose page exposes no
 * lastModifiedTime) go into a trailing「无日期」bucket instead of vanishing.
 */
export function groupOpsItemsByDay(items: readonly OpsItem[], now: number = Date.now(), days = 7): readonly OpsDayBoard[] {
  const today = new Date(now);
  const boundaries: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    boundaries.push(localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)));
  }
  const buckets = new Map<string, OpsItem[]>(boundaries.map((key) => [key, []]));
  const undated: OpsItem[] = [];
  for (const item of items) {
    const key = itemDayKey(item);
    if (key === null) undated.push(item);
    else buckets.get(key)?.push(item);
  }
  const boards = boundaries
    .map((key) => {
      const dayItems = [...(buckets.get(key) ?? [])].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
      return { key, label: dayLabel(key), isToday: key === boundaries[0], items: dayItems, note: null as string | null };
    })
    .filter((board) => board.items.length > 0);
  if (undated.length > 0) {
    boards.push({
      key: "nodate",
      label: "无日期",
      isToday: false,
      items: [...undated].sort((a, b) => a.title.localeCompare(b.title)),
      note: "以下条目的来源页未提供发布日期，无法归入具体日期；如实单列，不做猜测。",
    });
  }
  return boards;
}

/** 批量登记（D6）的纯解析：按行/空白拆分、去重、空段忽略；非 http(s) 如实拒绝。 */
export function splitWechatLinks(raw: string): { readonly valid: readonly string[]; readonly invalid: readonly string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of raw.split(/[\s,;，；]+/)) {
    const url = piece.trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      invalid.push(url);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    valid.push(url);
  }
  return { valid, invalid };
}
