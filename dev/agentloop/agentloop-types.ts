/**
 * AgentLoop bridge contracts — 凭据管理 + 只读连接测试 + SLS CreateTicket 两步出票。
 * donor: base/sa-workbench scripts/lib/agentloop.js + scripts/lib/sls.js +
 * scripts/bridge.js /agentloop/*（搬语义不搬代码）。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * AGENTLOOP_ROUTES 常量供接线——集成方只需在 local-router 里
 * `const routed = await agentloopBridge.handle(request); if (routed) return routed;`
 * 即可挂载全部七条路由（405/错误映射都在子路由内闭环），沿 F9 reply 桥先例。
 *
 * 错误分层：所有失败响应为 {ok:false, error:{code, message}}；code 为下方稳定错误码，
 * message 为可直接展示的中文文案（不含绝对路径、不含 AK/SK、不含票据明文）。
 *
 * 红线（与 donor 一致，不可放宽）：
 * - 凭据只写不回显：GET/PUT/DELETE 应答一律掩码视图（set/mask/updatedAt），绝无 AK/SK 值；
 *   存储文件 0600、目录 0700、唯一 tmp + rename 原子写；
 * - 连接测试只读：仅 listLogstores（GET /logstores）探活，绝不出票、绝不改云端状态；
 * - 出票属外部写：必须两步闸门——dry 只返回掩码请求摘要 + 一次性 token（零网络），
 *   confirm 要求 body.confirm 严格 === dry 铸造的 token 才真实 POST /tickets
 *   （HMAC-SHA1 经典签名，官方限定上海端点，照 donor sls.js 口径 cn-shanghai）；
 * - 出票审计 append-only（tickets.jsonl），票据只落掩码，绝不落明文；
 * - 票据值本身也是 bearer 凭据：confirm 应答只回掩码 + 有效期，不回票据明文
 *   （V2 本页无 iframe 内嵌，收紧于 donor 属有意为之）。
 */

/** 稳定错误码：路由按 code 映射 400/404/405/409/502/503。 */
export type AgentloopErrorCode =
  | "agentloop_invalid_request"
  | "agentloop_not_found"
  | "agentloop_creds_missing"
  | "agentloop_confirm_mismatch"
  | "agentloop_upstream_auth"
  | "agentloop_upstream_error"
  | "agentloop_store_unavailable"
  | "agentloop_unavailable"
  | "method_not_allowed";

export class AgentloopBridgeError extends Error {
  readonly code: AgentloopErrorCode;

  constructor(code: AgentloopErrorCode, message: string) {
    super(message);
    this.name = "AgentloopBridgeError";
    this.code = code;
  }
}

/** 路由表（供接线）：七条路由与任务口径一一对应。 */
export const AGENTLOOP_ROUTES = [
  { method: "GET", path: "/local/agentloop/creds", operation: "creds-get" },
  { method: "PUT", path: "/local/agentloop/creds", operation: "creds-put" },
  { method: "DELETE", path: "/local/agentloop/creds", operation: "creds-delete" },
  { method: "POST", path: "/local/agentloop/test", operation: "test" },
  { method: "POST", path: "/local/agentloop/ticket-dry", operation: "ticket-dry" },
  { method: "POST", path: "/local/agentloop/ticket-confirm", operation: "ticket-confirm" },
  { method: "GET", path: "/local/agentloop/tickets", operation: "tickets" },
] as const;

export type AgentloopRoute = (typeof AGENTLOOP_ROUTES)[number];

/** 免登票据有效期（donor TICKET_TTL：accessToken 上限即 1 天）。 */
export const AGENTLOOP_TICKET_TTL_SEC = 86_400;
/** GET /local/agentloop/tickets 返回的审计尾行数。 */
export const AGENTLOOP_TICKETS_TAIL = 50;
/** 只读探活单视图超时（listLogstores）。 */
export const AGENTLOOP_PROBE_TIMEOUT_MS = 8_000;
/** 出票请求超时（donor slsFetch timeoutMs 15s 同口径）。 */
export const AGENTLOOP_TICKET_TIMEOUT_MS = 15_000;
/** dry token 有效期：5 分钟内不确认即作废，需重新预检。 */
export const AGENTLOOP_DRY_TOKEN_TTL_MS = 5 * 60_000;
/** 出票端点官方限定上海（donor sls.js TICKET_HOST，票可跨地域使用）。 */
export const AGENTLOOP_TICKET_HOST = "cn-shanghai.log.aliyuncs.com";
/** 出票端点地域标识（应答与审计如实标注）。 */
export const AGENTLOOP_TICKET_REGION = "cn-shanghai";
/** SLS 控制台基址（donor CONSOLE_BASE，仅外链展示，不做 iframe）。 */
export const AGENTLOOP_CONSOLE_BASE = "https://sls.console.aliyun.com";
/** AgentLoop 控制台（donor CONSOLE，仅外链展示）。 */
export const AGENTLOOP_CONSOLE = "https://agentloop.console.aliyun.com/agentloop/home";
/** SLS 经典签名口径（donor sls.js canon headers）。 */
export const AGENTLOOP_API_VERSION = "0.6.0";
export const AGENTLOOP_SIGNATURE_METHOD = "hmac-sha1";
/** 上游响应体读取上限（有界输出：超限截断，错误详情再截 200 字）。 */
export const AGENTLOOP_MAX_UPSTREAM_BYTES = 256 * 1024;

/** GET/PUT/DELETE /local/agentloop/creds 的掩码视图（绝无凭据值）。 */
export interface AgentloopCredsView {
  readonly set: boolean;
  readonly mask: string | null;
  readonly updatedAt: string | null;
  readonly storage: "file-0600";
}

/** 探活目标行（test 应答；note 已脱敏截断）。 */
export interface AgentloopProbeTarget {
  readonly id: string;
  readonly t: string;
  readonly ok: boolean;
  readonly note: string;
}

/** 连接测试诚实三态：unset（未设置）/ ok（有效）/ error（异常 + 原因）。 */
export type AgentloopTestState = "unset" | "ok" | "error";

/** POST /local/agentloop/test 的 data（永远 200，三态如实）。 */
export interface AgentloopTestView {
  readonly state: AgentloopTestState;
  readonly note: string;
  readonly targets: readonly AgentloopProbeTarget[];
  readonly checkedAt: string;
}

/** dry 返回的「将提交的签名请求」掩码摘要（零网络、无签名值、无凭据值）。 */
export interface AgentloopTicketRequestSummary {
  readonly method: "POST";
  readonly host: string;
  readonly resource: string;
  readonly apiVersion: string;
  readonly signatureMethod: string;
  readonly authorizationPreview: string;
  readonly ttlSec: number;
  readonly region: string;
  readonly externalWrite: true;
}

/** POST /local/agentloop/ticket-dry 的 data。 */
export interface AgentloopTicketDryView {
  readonly token: string;
  readonly expiresAt: string;
  readonly credsMask: string;
  readonly request: AgentloopTicketRequestSummary;
}

/** POST /local/agentloop/ticket-confirm 的 data（票据只回掩码，不回明文）。 */
export interface AgentloopTicketConfirmView {
  readonly ticketMask: string;
  readonly ttl: number;
  readonly issuedAt: string;
  readonly expireAt: string;
  readonly region: string;
  readonly audited: boolean;
}

/** 出票审计行（tickets.jsonl；append-only，票据只落掩码）。 */
export interface AgentloopTicketAudit {
  readonly at: string;
  readonly action: "ticket";
  readonly status: "ok" | "error";
  readonly ticketMask: string;
  readonly ttl: number;
  readonly expireAt: string;
  readonly reason: string;
}

/** GET /local/agentloop/tickets 的 data（最新在前）。 */
export interface AgentloopTicketsView {
  readonly tickets: readonly AgentloopTicketAudit[];
  readonly total: number;
}

/** 上游 HTTP 契约（注入点）：测试用 stub 绝不真联网。 */
export interface SlsFetchResponse {
  readonly status: number;
  readonly bodyText: string;
}

export interface SlsFetchInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export type SlsFetch = (url: string, init: SlsFetchInit) => Promise<SlsFetchResponse>;

/** 凭据（仅在桥内部流转，绝不进应答/日志/审计）。 */
export interface AgentloopCreds {
  readonly ak: string;
  readonly sk: string;
  readonly updatedAt: string;
}

export interface AgentloopBridge {
  /** GET /local/agentloop/creds —— 掩码视图（set/mask/updatedAt）。 */
  readonly creds: () => Promise<AgentloopCredsView>;
  /** PUT /local/agentloop/creds —— body {accessKeyId,accessKeySecret}；0600 原子写。 */
  readonly setCreds: (body: unknown) => Promise<AgentloopCredsView>;
  /** DELETE /local/agentloop/creds —— 幂等删除；返回掩码视图 + removed。 */
  readonly clearCreds: () => Promise<AgentloopCredsView & { readonly removed: boolean }>;
  /** POST /local/agentloop/test —— 只读探活（listLogstores），诚实三态。 */
  readonly test: () => Promise<AgentloopTestView>;
  /** POST /local/agentloop/ticket-dry —— 出票预检（零网络，铸造一次性 token）。 */
  readonly ticketDry: () => Promise<AgentloopTicketDryView>;
  /** POST /local/agentloop/ticket-confirm —— body {confirm}；严格 === dry token 才真发。 */
  readonly ticketConfirm: (body: unknown) => Promise<AgentloopTicketConfirmView>;
  /** GET /local/agentloop/tickets —— 出票审计尾 50（最新在前）。 */
  readonly tickets: () => Promise<AgentloopTicketsView>;
  /** 子路由：命中 AGENTLOOP_ROUTES 返回 Response；非本桥路径返回 undefined。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
