import { connect } from "node:net";

import { checkRow, type CheckRow } from "./workbench-types.ts";

/**
 * 端口占用检查（只读 TCP 探测，连接后立即断开）：4173 = vite preview 默认
 * 端口，8000 = 本地 Function 桥（dev:function / local-router）。
 * 被占 → warn（多半是已有实例在跑，属提示非故障）；空闲 → ok；
 * 探测超时/被拒 → info（不猜）。均不影响退出码。
 */

export type PortState = "occupied" | "free" | "unknown";

export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<PortState>;

export interface PortSpec {
  readonly name: string;
  readonly port: number;
  readonly hint: string;
}

const GROUP = "ports";

export const PORT_HOST = "127.0.0.1";

export const PORT_SPECS: readonly PortSpec[] = [
  { name: "4173（vite preview）", port: 4173, hint: "可能已有 vite preview 实例在运行" },
  { name: "8000（本地 Function 桥）", port: 8000, hint: "可能已有 dev:function 本地桥在运行" },
];

export const DEFAULT_PORT_TIMEOUT_MS = 2_000;

/** 默认探针：connect 成功=占用；ECONNREFUSED=空闲；超时或其他错误=未能确认。 */
export function createDefaultPortProbe(): PortProbe {
  return (host, port, timeoutMs) =>
    new Promise((resolve) => {
      let settled = false;
      const socket = connect({ host, port });
      const finish = (state: PortState): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(state);
      };
      socket.setTimeout(timeoutMs, () => finish("unknown"));
      socket.once("connect", () => finish("occupied"));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ECONNREFUSED" ? "free" : "unknown");
      });
    });
}

export async function portRow(spec: PortSpec, probe: PortProbe, timeoutMs: number): Promise<CheckRow> {
  const state = await probe(PORT_HOST, spec.port, timeoutMs);
  if (state === "occupied") {
    return checkRow(
      GROUP,
      spec.name,
      "warn",
      `${PORT_HOST}:${spec.port} 已被占用（${spec.hint}；确认后停掉旧实例，或直接复用现有实例）`,
    );
  }
  if (state === "free") {
    return checkRow(GROUP, spec.name, "ok", `${PORT_HOST}:${spec.port} 空闲`);
  }
  return checkRow(GROUP, spec.name, "info", `${PORT_HOST}:${spec.port} 未能确认占用（探测超时或被拒绝）`);
}

export async function portsRows(
  probe: PortProbe,
  timeoutMs: number = DEFAULT_PORT_TIMEOUT_MS,
): Promise<readonly CheckRow[]> {
  return Promise.all(PORT_SPECS.map((spec) => portRow(spec, probe, timeoutMs)));
}
