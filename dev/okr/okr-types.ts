/**
 * OKR 桥（CRD 目标读写）— 类型与稳定错误码。
 * 契约与 profile/report 桥同口径：成功 {ok:true,data}；
 * 失败 {ok:false,error:{code,message}}（可选附加字段，如 conflicts 清单）。
 */

export type OkrErrorCode =
  | "okr_invalid_request"   // 参数 / 编辑项白名单校验失败（400）
  | "profile_no_session"    // 未配置 BUC 会话（400，诚实引导态）
  | "okr_corrupt"           // 本机缓存文件损坏，拒读拒覆盖（409）
  | "okr_conflict"          // 勾选键含冲突项且未 acceptConflicts（409）
  | "okr_busy"              // 单飞锁：另一 OKR 任务进行中（429）
  | "okr_refresh_failed"    // fetch_okr.py 失败 / 超时 / 输出不可解析（502）
  | "okr_sync_failed"       // okr_write.py 失败 / 输出不可解析（502）
  | "okr_unavailable";      // 未知异常兜底（502）

export const OKR_ERROR_STATUS: Readonly<Record<OkrErrorCode, number>> = {
  okr_invalid_request: 400,
  profile_no_session: 400,
  okr_corrupt: 409,
  okr_conflict: 409,
  okr_busy: 429,
  okr_refresh_failed: 502,
  okr_sync_failed: 502,
  okr_unavailable: 502,
};

/** 携带稳定错误码的桥异常；details 会并入错误响应体（如 conflicts 清单）。 */
export class OkrBridgeError extends Error {
  readonly code: OkrErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: OkrErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OkrBridgeError";
    this.code = code;
    this.details = details;
  }
}

/** 归一化后的单条编辑（字段白名单见 okr-edits.ts）。 */
export interface OkrEdit {
  readonly kind: "o" | "kr";
  readonly oId: string;
  readonly krId: string | null;
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** edits.json / edits.confirm.json 的落盘形态（donor data/okr_edits.json 同构）。 */
export interface OkrEditsFile {
  readonly exportedAt: string;
  readonly baseSnapshotAt: string;
  readonly edits: readonly OkrEdit[];
}

/** sync-dry / sync-confirm 的逐项差异（donor okr_write.py results 的白名单投影）。 */
export interface OkrDiffItem {
  readonly key: string;
  readonly kind: "o" | "kr";
  readonly oId: string;
  readonly krId: string | null;
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly crd: string | null;
  readonly state: "pending" | "written" | "already" | "conflict" | "kr-missing" | "failed";
  readonly conflict: boolean;
  readonly note: string;
}

export type OkrWriteState = OkrDiffItem["state"];

export const OKR_WRITE_STATES: readonly OkrWriteState[] = [
  "pending", "written", "already", "conflict", "kr-missing", "failed",
];

/** 审计行（.local-cache/okr/audit.jsonl，每行一条 JSON）。 */
export interface OkrAuditLine {
  readonly at: string;
  readonly keys: readonly string[];
  readonly acceptConflicts: boolean;
  readonly exitCode: number | null;
}
