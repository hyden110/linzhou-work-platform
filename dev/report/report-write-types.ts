/**
 * Report write bridge contracts (F6-P1) — 日报回写（草稿保存 / 提交）写能力契约。
 * donor: base/sa-workbench scripts/lib/report/index.js actSave / act('send') / runNow /
 * outboxToday / cooldownLeft + scripts/bridge.js POST /report/{save,send}（搬语义不搬代码）。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * REPORT_WRITE_ROUTES 常量供接线——集成方在 local-router 委托链加一行
 * `?? await reportWriteBridge.handle(request)` 即可（沿 F9 reply 桥先例）。
 * 既有 4 条只读 GET 路由（/local/report/{state,automations,weeklies,weekly}）不在本
 * 路由表内，handle() 对它们一律返回 undefined 交回主路由，保持行为字节不变。
 *
 * 红线（与 donor 一致或更严，不可放宽）：
 * - 写只收白名单字段（topic/followup/opportunity/risk/other，文本 ≤4000 字），
 *   白名单外字段一律整体拒绝（比 donor 静默丢弃更严：宁可拒绝也不半写）；
 * - 两步确认：dry 铸造一次性 token（10min TTL、单次消费），confirm 必须
 *   body.confirm 严格 === token 才执行外部写；闸门在服务端、先于任何外部调用；
 * - recordId 冲突 → 409 带冲突清单，绝不覆盖（donor actSave 同款）；
 * - 提交不重实现远端链路：SSH ECS QoderWake automation run-now 触发 submit 任务
 *   （工作日判定 / 模板 / 收件人 / 群同步都在远端）；5 分钟冷却持久化在审计里
 *   （重启不能刷冷却），冷却内 429 诚实拒绝、绝不重发；outbox 双保险去重：
 *   今日已提交 → 409 already_submitted；
 * - 成功与否都回读校验（save 回读 record 字段逐一比对；submit 回读 outbox 计数），
 *   回读结果如实返回 verified，绝不假装成功；
 * - 审计 writes.jsonl append-only（0600 / 目录 0700）：每次真实外部写尝试无论成败
 *   都留一行，正文只落掩码预览（先脱敏、折空白、截 24 字）；
 * - dws 缺失 → dws_missing 503 诚实失败；错误消息一律先脱敏（redactText）再截断。
 */

/** 写审计行（writes.jsonl；append-only，一行一次真实外部尝试或一次回读校验）。 */
export interface ReportWriteAudit {
  /** ISO 时间（桥侧注入 now）。 */
  readonly at: string;
  readonly op: "save" | "submit";
  /** update=record 回写；run=run-now 触发；verify=提交后的 outbox 回读。 */
  readonly phase: "update" | "run" | "verify";
  /** save=recordId；submit=触发器 id（均非机密）。 */
  readonly target: string;
  readonly exitCode: number | string | null;
  /** 外部进程是否真的跑过（ENOENT=没跑，false，不计入冷却）。 */
  readonly executed: boolean;
  readonly ok: boolean;
  readonly verified: boolean;
  readonly maskedPreview: string;
}

/** 稳定错误码：handle() 按 code 映射 400/405/409/429/502/503。 */
export type ReportWriteErrorCode =
  | "report_invalid_request"
  | "report_unconfigured"
  | "confirm_mismatch"
  | "confirm_stale"
  | "no_record"
  | "record_conflict"
  | "already_submitted"
  | "cooldown"
  | "dws_missing"
  | "dws_failed"
  | "ssh_unavailable"
  | "submit_failed"
  | "write_unavailable"
  | "method_not_allowed";

export class ReportWriteBridgeError extends Error {
  readonly code: ReportWriteErrorCode;
  /** 结构化补充（record_conflict 的冲突清单 / already_submitted 的提交记录）。 */
  readonly data: unknown;

  constructor(code: ReportWriteErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ReportWriteBridgeError";
    this.code = code;
    this.data = data;
  }
}

/** 路由表（供接线）：五条写路由与任务口径一一对应。 */
export const REPORT_WRITE_ROUTES = [
  { method: "POST", path: "/local/report/save-dry", operation: "saveDry" },
  { method: "POST", path: "/local/report/save-confirm", operation: "saveConfirm" },
  { method: "POST", path: "/local/report/submit-dry", operation: "submitDry" },
  { method: "POST", path: "/local/report/submit-confirm", operation: "submitConfirm" },
  { method: "GET", path: "/local/report/writes", operation: "writes" },
] as const;

export type ReportWriteRoute = (typeof REPORT_WRITE_ROUTES)[number];
export type ReportWriteOperation = ReportWriteRoute["operation"];

/** 可写白名单（照 donor WRITABLE；dept/workStatus/date 只读，绝不入写面）。 */
export const REPORT_WRITABLE_FIELDS = ["topic", "followup", "opportunity", "risk", "other"] as const;
export type ReportWritableField = (typeof REPORT_WRITABLE_FIELDS)[number];

/** 单字段文本上限（照 donor MAX_TEXT）。 */
export const REPORT_MAX_TEXT = 4000;
/** 提交冷却（照 donor COOLDOWN_MS：5 分钟，防连点重复触发远端）。 */
export const SUBMIT_COOLDOWN_MS = 5 * 60_000;
/** dry token 有效期（一次性、10 分钟；过期须重新预检）。 */
export const DRY_TOKEN_TTL_MS = 10 * 60_000;
/** pending token 表容量上限（超出淘汰最旧，防内存膨胀）。 */
export const PENDING_TOKEN_LIMIT = 200;
/** GET /local/report/writes 返回的审计尾行数。 */
export const WRITES_TAIL = 50;
/** 审计掩码预览长度（先脱敏再截，只留可核对的开头）。 */
export const REPORT_PREVIEW_CHARS = 24;
/** dws aitable record update 超时（照 donor 60s）。 */
export const RECORD_UPDATE_TIMEOUT_MS = 60_000;
/** submit-dry 的 SSH 只读探测超时（比 run-now 短：探测失败要快）。 */
export const SUBMIT_PROBE_TIMEOUT_MS = 30_000;
/** recordId 形态（照 donor ID_RE）。 */
export const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 写请求体上限：5 字段 × 4000 字（UTF-8 中文 ≈3 字节/字）+ JSON 开销，128KB 足够。 */
export const MAX_WRITE_BODY_BYTES = 128 * 1024;

/** save-dry 的逐字段差异（只含白名单内、本次 cells 实际提交的字段）。 */
export interface ReportSaveDiffItem {
  readonly key: ReportWritableField;
  readonly fieldId: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

/** POST /local/report/save-dry 的 data。 */
export interface ReportSaveDryResult {
  readonly token: string;
  readonly recordId: string;
  readonly at: string;
  readonly today: string;
  readonly diff: readonly ReportSaveDiffItem[];
}

/** POST /local/report/save-confirm 的 data（成功）。 */
export interface ReportSaveConfirmResult {
  readonly recordId: string;
  readonly verified: boolean;
  readonly at: string;
  readonly updated: readonly ReportWritableField[];
  readonly audited: boolean;
  readonly note: string;
}

/** 今日已提交信息（outbox 投影；照 donor outboxToday）。 */
export interface ReportSubmittedInfo {
  readonly n: number;
  readonly items: ReadonlyArray<{ readonly title: string; readonly time: string }>;
}

/** 发送通道探测结果（SSH ECS QoderWake automation detail，只读）。 */
export interface ReportSubmitChannel {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly lastStatus: string;
  readonly nextAt: string;
  readonly note: string;
}

/** POST /local/report/submit-dry 的 data（提交预检：冷却 / outbox 去重 / 通道探测）。 */
export interface ReportSubmitDryResult {
  readonly token: string;
  readonly at: string;
  readonly today: string;
  readonly blocked: boolean;
  readonly cooldownRemainMs: number;
  readonly alreadySubmitted: ReportSubmittedInfo | null;
  readonly channel: ReportSubmitChannel;
  readonly note: string;
}

/** POST /local/report/submit-confirm 的 data（成功触发；verified 为回读如实结果）。 */
export interface ReportSubmitConfirmResult {
  readonly at: string;
  readonly executed: boolean;
  readonly runId: string;
  readonly sessionId: string;
  readonly verified: boolean;
  readonly submittedN: number;
  readonly audited: boolean;
  readonly note: string;
}

/** GET /local/report/writes 的 data（最新在前，尾 50）。 */
export interface ReportWritesView {
  readonly writes: readonly ReportWriteAudit[];
  readonly total: number;
}

export interface ReportWriteBridge {
  /** POST /local/report/save-dry —— 预检并返回白名单字段 diff + 一次性 token。 */
  readonly saveDry: (body: unknown) => Promise<ReportSaveDryResult>;
  /** POST /local/report/save-confirm —— body.confirm 严格 === token 才执行 record update。 */
  readonly saveConfirm: (body: unknown) => Promise<ReportSaveConfirmResult>;
  /** POST /local/report/submit-dry —— 提交预检（冷却 / outbox / SSH 通道探测）。 */
  readonly submitDry: () => Promise<ReportSubmitDryResult>;
  /** POST /local/report/submit-confirm —— body.confirm 严格 === token 才 run-now 触发。 */
  readonly submitConfirm: (body: unknown) => Promise<ReportSubmitConfirmResult>;
  /** GET /local/report/writes —— 写审计尾 50（最新在前，已掩码）。 */
  readonly writes: () => Promise<ReportWritesView>;
  /** 子路由：命中 REPORT_WRITE_ROUTES 返回 Response；其余路径返回 undefined。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
