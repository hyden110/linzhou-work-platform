import type { LeadNews, LeadRow, LeadTier } from "./leads-types.ts";

/**
 * Pure model for the leads radar (F5) — ported semantics from base/sa-workbench
 * tools/sync/aitable_leads_sync.js (搬语义不搬代码，口径逐项对齐):
 * - FIELD_MAP 按字段名映射白名单：雷达按名 upsert，字段 ID 随表而变；
 *   电话 / 邮箱 / 法定代表人等联系人字段不在白名单，物理不入快照。
 * - PLACEHOLDER_RE 占位值清洗、SECRET_RE 自由文本脱敏（只用于 replace，避免 /g 的
 *   lastIndex 状态问题）。
 * - TIER_ORDER 与 lead-radar crm.py TIERS 同口径；TRACKS 11 条正则归类；
 *   CITY_PROV 城市→省份映射 + 直辖市。
 * 全部纯函数：无 I/O、无时钟，可直接单测。
 */

/** 字段名 → 快照键（白名单：电话 / 邮箱 / 法定代表人等联系人字段不入快照）。 */
export const FIELD_MAP: Readonly<Record<string, keyof LeadRowWhitelist>> = {
  "企业名称": "name", "法律实体": "legal", "CRM客户名": "crmName", "Name判定": "tierLabel", "CRM状态": "crmState",
  "综合分": "score", "优先级": "priority", "省份": "province", "城市": "city", "赛道": "trackRaw", "一句话": "summary",
  "信号类型": "signal", "融资阶段": "round", "最新融资额": "amount", "领投方": "investors",
  "MaaS匹配": "maas", "MaaS分析": "maasWhy", "MaaS产品": "maasProduct", "Agent席位潜力": "agent", "Agent分析": "agentWhy",
  "竞争风险": "risk", "阿里关联": "aliRel", "跟进人": "sales", "跟进团队": "team", "关联UID数": "uids", "CID": "cid", "ECID": "ecid",
  "提及次数(14天)": "mentions", "最新信号时间": "signalAt", "雷达更新时间": "radarAt", "最新资讯": "news", "数据来源": "sources",
  "成立日期": "founded", "注册资本": "regCap", "注册地址": "address", "创始人": "founder", "官网": "website", "企典状态": "entStatus",
};

/** schema 漂移护栏的必需字段名（照静态版 REQUIRED）。 */
export const REQUIRED_FIELD_NAMES: readonly string[] = [
  "企业名称", "Name判定", "CRM状态", "综合分", "省份", "城市", "赛道", "一句话", "最新信号时间", "CID",
];

const NUM_KEYS: ReadonlySet<string> = new Set(["score", "mentions", "uids"]);
export const DEFAULT_PRIORITY: readonly string[] = ["北京", "山东", "河南", "山西", "河北"];

export const PLACEHOLDER_RE = /^(待补全|待补充|待CRM扫描|未知|无|—|-|N\/A)$/i;
export const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|token|password|cookie)\s*[:=]\s*(?!\*{3})[^\s,;]+)/ig;

/** 判定档位：与 lead-radar crm.py TIERS 同口径；pending = 人工录入、尚未经雷达 CRM 扫描。 */
export const TIER_ORDER: Readonly<Record<LeadTier, number>> = {
  ME: 0, A: 1, B: 2, B2: 3, "A?": 4, C: 5, D: 9, pending: 7,
};
export const TIER_KEYS: readonly LeadTier[] = ["ME", "A", "B", "B2", "A?", "C", "pending", "D"];

const TRACKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/具身|机器人|人形/, "具身智能/机器人"], [/音频|语音|声音/, "AI语音/音频"], [/AI4S|制药|医药|生命科学|生物/i, "AI4S/医药"],
  [/自动驾驶|智驾/, "自动驾驶"], [/硬件|端侧|芯片|眼镜/, "AI硬件/端侧"], [/算力|infra/i, "AI Infra/算力"],
  [/编程|代码|coding/i, "AI编程"], [/agent|智能体/i, "Agent/智能体"], [/视频|多模态|图像|3D/i, "多模态/视频生成"],
  [/大模型|基座|LLM/i, "大模型/基座"], [/行业|AI\+/i, "AI+行业应用"],
];

const CITY_PROV: Readonly<Record<string, string>> = {
  "杭州": "浙江", "宁波": "浙江", "深圳": "广东", "广州": "广东", "东莞": "广东", "珠海": "广东", "南京": "江苏", "苏州": "江苏", "无锡": "江苏",
  "武汉": "湖北", "西安": "陕西", "成都": "四川", "济南": "山东", "青岛": "山东", "烟台": "山东", "潍坊": "山东", "郑州": "河南", "洛阳": "河南",
  "太原": "山西", "石家庄": "河北", "保定": "河北", "雄安": "河北", "廊坊": "河北", "合肥": "安徽", "厦门": "福建", "福州": "福建", "长沙": "湖南",
};
const MUNICIPALITIES: readonly string[] = ["北京", "上海", "天津", "重庆"];

type LeadRowWhitelist = Omit<LeadRow, "id" | "tier" | "isPriority">;

export function redact(value: unknown): string {
  return String(value ?? "").replace(SECRET_RE, "[已脱敏]");
}

function text(value: unknown): string {
  if (value == null) return "";
  const out = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(text).filter(Boolean).join(",")
      : typeof value === "object"
        ? (() => {
            const record = value as { name?: unknown; text?: unknown; value?: unknown };
            const picked = record.name ?? record.text ?? record.value;
            return typeof picked === "string" ? picked : "";
          })()
        : String(value);
  const s = redact(out).replace(/\s+/g, " ").trim();
  return PLACEHOLDER_RE.test(s) ? "" : s;
}

function num(value: unknown): number | null {
  const asString = text(value);
  if (asString === "") return null;
  const parsed = Number(asString);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTier(label: unknown, crmState: unknown): LeadTier {
  const m = /^\s*(★|ME|A\?|A|B2|B|C|D)(?![A-Za-z])/.exec(String(label || crmState || ""));
  if (!m) return "pending";
  return m[1] === "★" ? "ME" : (m[1] as LeadTier);
}

export function normTrack(raw: unknown): string {
  const s = String(raw ?? "");
  if (!s) return "其他";
  const hit = TRACKS.find(([pattern]) => pattern.test(s));
  return hit ? hit[1] : "其他";
}

export function normProvince(province: unknown, city: unknown): string {
  const p = String(province ?? "").replace(/(省|市|自治区|壮族|回族|维吾尔)$/, "");
  if (p) return p;
  const c = String(city ?? "").replace(/市$/, "");
  if (MUNICIPALITIES.includes(c)) return c;
  const key = Object.keys(CITY_PROV).find((name) => c.startsWith(name));
  return key ? CITY_PROV[key] ?? "" : "";
}

function asNews(raw: unknown): LeadNews | null {
  const link = raw && typeof raw === "object" && !Array.isArray(raw)
    ? String((raw as { link?: unknown; url?: unknown }).link ?? (raw as { url?: unknown }).url ?? "")
    : "";
  if (!/^https?:\/\//.test(link)) return null;
  return { t: text((raw as { text?: unknown }).text) || link, u: link };
}

/** AI 表格一行 cells → 白名单快照行（不含 id，由调用方以 recordId 合成）。 */
export function normalizeLeadCells(
  cells: unknown,
  nameOf: Readonly<Record<string, string>>,
  priorityProvinces: readonly string[],
): Omit<LeadRow, "id"> {
  /* 先铺满白名单默认值：表格缺列时行形状仍完整（""/null），绝不回退成 undefined。 */
  const out: Record<string, unknown> = {};
  for (const key of Object.values(FIELD_MAP)) {
    if (key === "news") out.news = null;
    else if (NUM_KEYS.has(key)) out[key] = null;
    else out[key] = "";
  }
  const source = (cells ?? {}) as Record<string, unknown>;
  for (const [fieldId, raw] of Object.entries(source)) {
    const key = FIELD_MAP[nameOf[fieldId] ?? ""];
    if (!key) continue;
    if (key === "news") out.news = asNews(raw);
    else if (NUM_KEYS.has(key)) out[key] = num(raw);
    else out[key] = text(raw);
  }
  const tier = parseTier(out.tierLabel, out.crmState);
  const track = normTrack(out.trackRaw);
  const province = normProvince(out.province, out.city);
  return {
    ...(out as unknown as Omit<LeadRowWhitelist, "tier" | "track" | "province">),
    tier,
    track,
    province,
    isPriority: priorityProvinces.includes(province),
  };
}

/** 判定档排序（ME 优先，D 最后）+ 综合分降序；纯函数返回新数组。 */
export function sortLeads(rows: readonly LeadRow[]): LeadRow[] {
  return [...rows].sort((a, b) =>
    (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || ((b.score ?? 0) - (a.score ?? 0)));
}

const TIER_SET: ReadonlySet<string> = new Set(TIER_KEYS);

/** 快照文件读入时的白名单投影：未知键（含联系人字段）物理丢弃，坏行返回 null。 */
export function projectLeadRow(value: unknown): LeadRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id : "";
  const name = typeof source.name === "string" ? source.name : "";
  if (!id || !name) return null;
  const str = (key: string): string => (typeof source[key] === "string" ? (source[key] as string) : "");
  const maybeNum = (key: string): number | null =>
    typeof source[key] === "number" && Number.isFinite(source[key]) ? (source[key] as number) : null;
  const tier = typeof source.tier === "string" && TIER_SET.has(source.tier) ? (source.tier as LeadTier) : "pending";
  const news = source.news && typeof source.news === "object" && !Array.isArray(source.news)
    ? (() => {
        const candidate = source.news as Record<string, unknown>;
        const u = typeof candidate.u === "string" && /^https?:\/\//i.test(candidate.u) ? candidate.u : "";
        if (!u) return null;
        return { t: typeof candidate.t === "string" ? candidate.t : "", u };
      })()
    : null;
  return {
    id,
    name,
    legal: str("legal"), crmName: str("crmName"), tierLabel: str("tierLabel"), tier,
    crmState: str("crmState"), score: maybeNum("score"), priority: str("priority"),
    province: str("province"), city: str("city"), track: str("track"), trackRaw: str("trackRaw"),
    summary: str("summary"), signal: str("signal"), round: str("round"), amount: str("amount"),
    investors: str("investors"), maas: str("maas"), maasWhy: str("maasWhy"), maasProduct: str("maasProduct"),
    agent: str("agent"), agentWhy: str("agentWhy"), risk: str("risk"), aliRel: str("aliRel"),
    sales: str("sales"), team: str("team"), uids: maybeNum("uids"), cid: str("cid"), ecid: str("ecid"),
    mentions: maybeNum("mentions"), signalAt: str("signalAt"), radarAt: str("radarAt"), news,
    sources: str("sources"), founded: str("founded"), regCap: str("regCap"), address: str("address"),
    founder: str("founder"), website: str("website"), entStatus: str("entStatus"),
    isPriority: source.isPriority === true,
  };
}
