/**
 * Guides bridge contracts — 接入向导本地桥的错误码、路由表与结果契约。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * GUIDES_ROUTES 常量供接线——集成方只需在 local-router 里
 * `const routed = await guidesBridge.handle(request); if (routed) return routed;`
 * 即可挂载全部三条路由（405/错误映射都在子路由内闭环）。
 *
 * 安全红线：terminal 动作只回显命令文本、绝不执行；aitable-provision 必经
 * confirm===true（严格布尔）；dws 输出一律过 redactNote；detail/note 不含绝对路径。
 */

export type GuidesErrorCode =
  | "guides_invalid_request"
  | "guides_not_found"
  | "guides_confirm_required"
  | "guides_busy"
  | "guides_provision_failed"
  | "guides_unavailable"
  | "method_not_allowed";

export class GuidesBridgeError extends Error {
  readonly code: GuidesErrorCode;
  /** confirm_required 时携带的二次确认文案（供前端确认框展示）。 */
  readonly confirmText: string;

  constructor(code: GuidesErrorCode, message: string, confirmText = "") {
    super(message);
    this.name = "GuidesBridgeError";
    this.code = code;
    this.confirmText = confirmText;
  }
}

export const GUIDES_ROUTES = [
  { method: "GET", path: "/local/guides", operation: "defs" },
  { method: "POST", path: "/local/guide/check", operation: "check" },
  { method: "POST", path: "/local/guide/act", operation: "act" },
] as const;

/** dws 子进程运行器（execFile 语义：数组参数、无 shell、硬超时），全量可注入。 */
export type GuideCommandRunner = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<{ readonly code: number | string | null; readonly stdout: string; readonly stderr: string }>;

/** 能力视图（cap 检测的可注入依赖；未注入时 cap 步诚实报无法判定）。 */
export type CapsView = () => Readonly<Record<string, { readonly state: string }>> | undefined;

export interface GuideVerifyResult {
  readonly id: string;
  readonly ok: boolean;
  readonly note: string;
}

export interface GuideCheckResult {
  readonly guide: string;
  readonly step: string;
  readonly state: "ok" | "fail";
  readonly detail: string;
  readonly results?: readonly GuideVerifyResult[];
}

export interface ProvisionPlanEntry {
  readonly schemaId: string;
  readonly tableName: string;
  readonly action: "reuse" | "create" | "created-with-base";
}

export interface ProvisionConfigEntry {
  readonly id: string;
  /** cacheDir 相对文件名（绝不出绝对路径）。 */
  readonly file: string;
  readonly tableCount: number;
  readonly missing: readonly string[];
}

export interface ProvisionResult {
  readonly ok: true;
  readonly baseId: string;
  readonly baseName: string;
  readonly plan: readonly ProvisionPlanEntry[];
  readonly configs: readonly ProvisionConfigEntry[];
}

export interface GuideActResult {
  readonly ok: boolean;
  readonly terminal?: boolean;
  readonly command?: string;
  readonly note?: string;
  readonly provision?: ProvisionResult;
  readonly [key: string]: unknown;
}

export interface GuideDefsView {
  readonly version: string;
  readonly guides: readonly unknown[];
}

export interface GuidesBridgeOptions {
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: GuideCommandRunner;
  readonly dwsBin?: string;
  readonly cacheDir?: string;
  readonly capsView?: CapsView;
  readonly actRefresh?: (group: string | null) => Promise<Record<string, unknown>>;
  readonly dwsTimeoutMs?: number;
}

export interface GuidesBridge {
  readonly defs: () => Promise<GuideDefsView>;
  readonly check: (body: unknown) => Promise<GuideCheckResult>;
  readonly act: (body: unknown) => Promise<GuideActResult>;
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
