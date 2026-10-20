/**
 * Reply model (F9) — 待回复候选的纯函数派生层（消息中心 + AI 回复建议 + 钉钉人工确认发送）。
 * donor: base/sa-workbench assets/pages/msgcenter.js「待回复」块 + scripts/lib/reply/index.js
 * （搬语义不搬代码）。零依赖、零 I/O、零时钟：输入是收件箱条目（NotifyItem 的结构子集），
 * 输出是候选投影；dev/reply/ 桥与浏览器端共用同一份派生口径（配 dev/reply-model_test.ts）。
 *
 * 口径：
 * - 候选 = 钉钉源（source/kind 命中 dingtalk 白名单）且「未读或未回复」的收件箱条目；
 *   已读且已成功发送过（审计在案）的条目退出候选，其余一律保留（宁可多show不可漏回）。
 * - 渠道判定只认白名单字面量，判不出来就是 ""（未知源没有发送通道，send 侧如实 no_channel）。
 * - openConversationId（cid…）只从 link / id 里按严格正则提取，提取不到就是 ""——绝不猜。
 * - 隐私与 donor 一致：候选投影不带消息正文（summary 不进候选），正文只在桥内按需进 prompt。
 */

/** 候选渠道：钉钉可发送（人工确认后）、微信只可复制、""=未知源（无通道）。 */
export type ReplyChannel = "dingtalk" | "wechat" | "";

/** 派生输入：收件箱条目的结构子集（与 notify-client NotifyItem 结构兼容）。 */
export interface ReplySourceItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly link: string;
  readonly createdAt: string;
  readonly read: boolean;
}

/** 候选投影（不含消息正文；group 为发送所需的 openConversationId，可能为 ""）。 */
export interface ReplyCandidate {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly read: boolean;
  readonly channel: ReplyChannel;
  readonly group: string;
  readonly replied: boolean;
}

/** 渠道白名单字面量（小写比对；donor RP_CH 的 wechat/dingtalk 两渠道口径）。 */
export const REPLY_DINGTALK_SOURCES = ["dingtalk", "钉钉"] as const;
export const REPLY_WECHAT_SOURCES = ["wechat", "weixin", "微信"] as const;

/**
 * openConversationId 形态：cid 前缀 + base64 风格主体（donor send.js --group 入参口径）。
 * 严格正则整段提取，提取不到即 ""（发送侧如实 no_group），绝不做宽容解析。
 * (?!=) 防止把查询键名 "cid=" 吞进值（?cid=cidXxx 必须提取出 cidXxx）。
 */
export const REPLY_GROUP_PATTERN = /\bcid(?!=)[0-9A-Za-z_+/=-]{4,120}/;

/** 候选上限：收件箱本身 cap 200，候选再截 50（首屏是「要人动手」的清单，不是台账）。 */
export const REPLY_CANDIDATE_LIMIT = 50;

/** 渠道判定：source（小写去空白）命中白名单，或 kind === "dingtalk"；判不出为 ""。 */
export function replyChannelOf(item: Pick<ReplySourceItem, "kind" | "source">): ReplyChannel {
  const source = String(item.source ?? "").trim().toLowerCase();
  if ((REPLY_DINGTALK_SOURCES as readonly string[]).includes(source) || item.kind === "dingtalk") return "dingtalk";
  if ((REPLY_WECHAT_SOURCES as readonly string[]).includes(source)) return "wechat";
  return "";
}

/** 从 link（优先）或 id 中按 REPLY_GROUP_PATTERN 提取 openConversationId；提取不到为 ""。 */
export function extractDingtalkGroup(item: Pick<ReplySourceItem, "id" | "link">): string {
  for (const haystack of [item.link, item.id]) {
    const matched = REPLY_GROUP_PATTERN.exec(String(haystack ?? ""));
    if (matched) return matched[0].slice(0, 128);
  }
  return "";
}

function createdAtMs(item: ReplySourceItem): number {
  const parsed = Date.parse(String(item.createdAt ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 待回复候选派生（纯函数）：钉钉源 + 未读或未回复（repliedIds = 发送审计里 exitCode 0 的 id）。
 * 时间倒序（坏时间按 0 排最后）、截 REPLY_CANDIDATE_LIMIT；输入数组与条目一律不改动。
 * 「已读且已成功回复」才退出清单；未读即使发过也保留（要人看一眼），replied 位如实回填。
 */
export function deriveReplyCandidates(
  items: readonly ReplySourceItem[],
  repliedIds: ReadonlySet<string>,
): ReplyCandidate[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is ReplySourceItem => Boolean(item) && typeof item === "object" && typeof item.id === "string")
    .map((item) => ({ item, channel: replyChannelOf(item), replied: repliedIds.has(item.id) }))
    .filter(({ item, channel, replied }) => channel === "dingtalk" && !(item.read && replied))
    .sort((a, b) => createdAtMs(b.item) - createdAtMs(a.item))
    .slice(0, REPLY_CANDIDATE_LIMIT)
    .map(({ item, channel, replied }) => ({
      id: item.id,
      title: String(item.title ?? ""),
      createdAt: String(item.createdAt ?? ""),
      read: item.read === true,
      channel: channel as ReplyChannel,
      group: extractDingtalkGroup(item),
      replied,
    }));
}
