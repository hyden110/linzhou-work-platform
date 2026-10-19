/**
 * Contracts for the agents bridge (F7) — 数字员工只读桥（QoderWake daemon 状态 +
 * AgentLoop 观测状态 + 微信办公快照）。
 * Semantics ported from base/sa-workbench（搬语义不搬代码）：
 * - scripts/lib/lifecycle/presales.js + scripts/refresh.js probeWakeDaemon：
 *   端口读 ~/.qoderwake/run/daemon.port（回退 19820），探 /api/health，ok/degraded/down + note；
 * - assets/pages/agents.js + components/core.js wakeFrames：三端 Tab 与四视图路径，
 *   Console 内嵌有「401 → 跳登录 → 回跳」死循环问题——本台一律新窗口外链，绝不做 iframe；
 * - scripts/bridge.js agentStatusView()：configured / mask / updatedAt / console / views。
 *
 * F7-P0 只读红线：
 * - 唯一网络动作是本机 daemon 的 GET /api/health 健康探测（显式超时 ≤5s）；
 * - 凭据只读「存在性与掩码」（掩码形态照静态台 maskAk），绝不读取 / 透出 AK/SK 明文；
 *   凭据配置表单、PUT/DELETE credentials、POST test、CreateTicket 出票一律不做。
 * - 微信只做快照统计的白名单投影：绝不读消息表、绝不解密 / 同步 / 常驻 worker；
 *   群-客户绑定管理不做——实时群台账 / @我待办由静态台本机常驻同步维护。
 */

/** 稳定错误码：路由按 code 映射 400/502，message 已过 redact。 */
export type AgentsErrorCode = "agents_unconfigured" | "agents_unavailable";

export class AgentsBridgeError extends Error {
  readonly code: AgentsErrorCode;

  constructor(code: AgentsErrorCode, message: string) {
    super(message);
    this.name = "AgentsBridgeError";
    this.code = code;
  }
}

/** 配置里的 ECS 网关入口：只存 URL 与条目名，绝不存 Basic Auth 凭据。 */
export interface WakeEndpointLink {
  readonly id: string;
  readonly t: string;
  readonly url: string;
}

/** daemon 健康状态（照静态台三态：res.ok / HTTP 异常 / 网络不通）。 */
export type WakeDaemonStatus = "ok" | "degraded" | "down";

/** GET /local/agents/state 里的 daemon 段：失败如实 down + note，绝不假绿。 */
export interface WakeDaemonView {
  readonly status: WakeDaemonStatus;
  readonly port: number;
  readonly url: string;
  readonly http: number | null;
  readonly note: string;
  readonly checkedAt: string;
}

/** daemon 上的功能视图入口（照 core.js wakeFrames 的路径表），仅在新窗口打开。 */
export interface WakeEntryLink {
  readonly id: string;
  readonly t: string;
  readonly path: string;
}

/** GET /local/agents/state 的 data。daemon 永远有答案（down 也是数据），不抛错。 */
export interface AgentsWakeState {
  readonly daemon: WakeDaemonView;
  readonly entries: readonly WakeEntryLink[];
  readonly endpoints: readonly WakeEndpointLink[];
}

/** AgentLoop 观测视图行（照静态台 agentStatusView 的 views 投影）。 */
export interface AgentLoopViewRow {
  readonly id: string;
  readonly t: string;
  readonly sub: string;
  readonly project: string;
  readonly logstore: string;
  readonly region: string;
}

/** GET /local/agents/agentloop 的 data。writesNote 固定标注「待授权，本台未开通」。 */
export interface AgentLoopStatusView {
  readonly configured: boolean;
  readonly mask: string | null;
  readonly updatedAt: string | null;
  readonly note: string;
  readonly console: string;
  readonly views: readonly AgentLoopViewRow[];
  readonly writesNote: string;
}

/** 微信办公快照统计（白名单字段；快照缺字段容错为 null，绝不造 0）。 */
export interface WechatSnapshotStats {
  readonly groups: number | null;
  readonly groupsActive7: number | null;
  readonly groupsActive30: number | null;
  readonly groupsMine7: number | null;
  readonly custBound: number | null;
  readonly atMeAll: number | null;
}

/** 微信办公快照数据源计数器（解密库盘点口径，无任何消息内容）。 */
export interface WechatSnapshotSource {
  readonly dbs: number | null;
  readonly tables: number | null;
  readonly messages: number | null;
  readonly groups: number | null;
  readonly singles: number | null;
  readonly window: number | null;
}

/** GET /local/agents/wechat 的 data：只有统计，绝无群名 / 消息 / 待办内容。
 * 「实时群台账 / @我待办由本机常驻同步维护，本台仅展示快照」的指引由视图静态文案承担。 */
export interface WechatSnapshotView {
  readonly at: string;
  readonly updatedAt: string;
  readonly me: { readonly wxid: string; readonly name: string };
  readonly source: WechatSnapshotSource;
  readonly stats: WechatSnapshotStats;
}
