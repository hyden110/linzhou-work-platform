import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join as joinPath } from "node:path";

import {
  maskArg,
  maskDef,
  maskUrl,
  MCP_CONNECTOR_NAME_RE,
  redactTail,
  secretNames,
  tildePath,
  transportOf,
} from "./mcp-mask.ts";
import { errNote, pickMsg } from "./mcp-protocol.ts";
import {
  McpBridgeError,
  MCP_CHECK_BUDGET_MS,
  MCP_CHECK_CONCURRENCY,
  MCP_CHILD_OUTPUT_MAX,
  MCP_HANDSHAKE_TIMEOUT_MS,
  type McpCheckView,
  type McpConfirmResult,
  type McpConnectorCheckResult,
  type McpConnectorOp,
  type McpConnectorSourceView,
  type McpConnectorView,
  type McpConnectorsView,
  type McpSpawnFn,
} from "./mcp-types.ts";

/**
 * MCP 连接器（发现 / 握手体检 / dry→confirm 写入）。
 * donor: scripts/lib/mcp.js（搬语义不搬代码）。
 *
 * 四处配置互不一致是常态——只注册在非生效来源的连接器根本没被宿主加载，这类分歧本身就是
 * 健康信号（discover 如实呈现 sources/effective/notLoaded）。
 *
 * 红线：url query / env 值 / 疑似密钥 arg 一律掩码后才出站；写入只动 mcpServers 一个键，
 * 写前备份 .bak（0600）、原子写、失败回滚并如实报错；JSON 解析失败即拒写（绝不 clobber）。
 * 握手：stdio 经注入 spawnFn（生产 = 数组参数 + shell:false + 硬超时 + 有界输出）跑
 * initialize → tools/list；HTTP POST 同一序列（兼容 SSE 响应与会话头）。
 */

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "sa-workbench-v2", version: "0.1.0" };
/** npx/uvx 一类要联网拉包，默认不自动握手（donor REMOTE_RUNNER 同口径）。 */
const REMOTE_RUNNER = /^(npx|uvx|bunx|pnpm|yarn)$/i;
const OPS: readonly McpConnectorOp[] = ["set", "enable", "disable", "remove"];

export interface ConnectorSourceSpec {
  readonly role: string;
  readonly label: string;
  readonly file: string;
  readonly shown: string;
  readonly dot: string;
  readonly effective: boolean;
  readonly writable: boolean;
}

export interface WritePlan {
  readonly op: McpConnectorOp;
  readonly role: string;
  readonly name: string;
  readonly source: ConnectorSourceSpec;
  readonly def: Record<string, unknown> | null;
  readonly existed: boolean;
  readonly diffBefore: string | null;
  readonly diffAfter: string | null;
}

export interface ConnectorRegistry {
  readonly sources: () => readonly ConnectorSourceSpec[];
  readonly discover: () => Promise<McpConnectorsView>;
  readonly handshake: (name: string) => Promise<McpConnectorCheckResult>;
  readonly check: (opts?: { name?: string; all?: boolean }) => Promise<McpCheckView>;
  readonly plan: (op: McpConnectorOp, role: string, name: string, def?: unknown) => Promise<WritePlan>;
  readonly apply: (plan: WritePlan) => Promise<McpConfirmResult>;
}

export interface ConnectorRegistryOptions {
  readonly sources?: readonly ConnectorSourceSpec[];
  readonly home?: string;
  readonly spawnFn?: McpSpawnFn;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly budgetMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly writeFileAtomic?: (path: string, text: string, mode: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 默认来源：工作台自有登记（恒可写、生效）+ ~/.qoder 两处宿主配置（缺省只读）。 */
export function defaultConnectorSources(options: { home: string; workbenchFile: string; hostWrite: boolean }): readonly ConnectorSourceSpec[] {
  const { home, workbenchFile, hostWrite } = options;
  return [
    {
      role: "workbench",
      label: "工作台登记",
      file: workbenchFile,
      shown: ".local-cache/mcp/connectors.json",
      dot: "mcpServers",
      effective: true,
      writable: true,
    },
    {
      role: "host-mcp",
      label: "Qoder mcp.json",
      file: joinPath(home, ".qoder", "mcp.json"),
      shown: "~/.qoder/mcp.json",
      dot: "mcpServers",
      effective: false,
      writable: hostWrite,
    },
    {
      role: "host-settings",
      label: "Qoder settings.json",
      file: joinPath(home, ".qoder", "settings.json"),
      shown: "~/.qoder/settings.json",
      dot: "mcp.mcpServers",
      effective: true,
      writable: hostWrite,
    },
  ];
}

/** 写入白名单清洗：只收 command/args/url/type/env/headers/disabled；值形态不合法即丢弃。 */
export function cleanDef(patch: unknown): Record<string, unknown> {
  const p = isRecord(patch) ? patch : {};
  const out: Record<string, unknown> = {};
  const str = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max && !/[\0\n\r]/.test(v);
  if (str(p.command, 300)) out.command = p.command.trim();
  if (Array.isArray(p.args)) {
    const a = p.args.slice(0, 30).filter((x): x is string => str(x, 512)).map((x) => x.trim());
    if (a.length) out.args = a;
  }
  if (str(p.url, 600) && /^https?:\/\//.test(p.url)) out.url = p.url.trim();
  if (str(p.type, 32) && /^(stdio|sse|http|streamableHttp|streamable-http)$/i.test(p.type)) out.type = p.type.trim();
  for (const k of ["env", "headers"] as const) {
    if (isRecord(p[k])) {
      const o: Record<string, string> = {};
      for (const [kk, vv] of Object.entries(p[k]).slice(0, 30)) {
        if (str(kk, 100) && str(vv, 2048)) o[kk] = vv;
      }
      if (Object.keys(o).length) out[k] = o;
    }
  }
  if (typeof p.disabled === "boolean") out.disabled = p.disabled;
  return out;
}

/** 生产 stdio 实现：数组参数 + shell:false + 硬超时 SIGKILL + 有界输出（超限即杀）。 */
export function createNodeSpawn(options: { timeoutMs: number }): McpSpawnFn {
  return (command, args, spawnOptions) => {
    const child = nodeSpawn(command, [...args], {
      env: spawnOptions.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, options.timeoutMs);
    timer.unref?.();
    let bytes = 0;
    const dataCbs: ((chunk: string) => void)[] = [];
    const errCbs: ((e: { code?: string; message: string }) => void)[] = [];
    const closeCbs: ((code: number | null) => void)[] = [];
    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > MCP_CHILD_OUTPUT_MAX) {
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        return;
      }
      for (const cb of dataCbs) cb(d.toString("utf-8"));
    });
    let errTail = "";
    child.stderr.on("data", (d: Buffer) => {
      errTail = `${errTail}${d.toString("utf-8")}`.slice(-32 * 1024);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      for (const cb of errCbs) cb({ code: e.code, message: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const cb of closeCbs) cb(code ?? (errTail ? -1 : null));
    });
    return {
      write(line: string) {
        try { child.stdin.write(`${line}\n`); } catch { /* 管道已关：由 close/error 收尾 */ }
      },
      onData(cb) { dataCbs.push(cb); },
      onError(cb) { errCbs.push(cb); },
      onClose(cb) { closeCbs.push(cb); },
      kill() {
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      },
    };
  };
}

interface SourceRead {
  readonly exists: boolean;
  readonly servers: Record<string, unknown>;
  readonly error: string | null;
}

function dotGet(doc: unknown, dot: string): unknown {
  return dot.split(".").reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), doc);
}

export function createConnectorRegistry(options: ConnectorRegistryOptions = {}): ConnectorRegistry {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || MCP_HANDSHAKE_TIMEOUT_MS, 100), 120_000);
  const budgetMs = Math.min(Math.max(Number(options.budgetMs) || MCP_CHECK_BUDGET_MS, 1_000), 900_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const envBase = options.env ?? process.env;
  const spawnFn = options.spawnFn ?? createNodeSpawn({ timeoutMs });
  const specs = options.sources ?? defaultConnectorSources({
    home,
    workbenchFile: joinPath(dirname(dirname(home)), ".local-cache", "mcp", "connectors.json"),
    hostWrite: false,
  });
  const writeAtomic = options.writeFileAtomic ?? defaultWriteFileAtomic;

  const iso = (): string => new Date(now()).toISOString();

  async function readSource(spec: ConnectorSourceSpec): Promise<SourceRead> {
    let text: string;
    try {
      text = await readFile(spec.file, "utf-8");
    } catch {
      return { exists: false, servers: {}, error: "文件缺失（尚未注册任何连接器）" };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { exists: true, servers: {}, error: "JSON 非法（拒绝读写，避免 clobber）" };
    }
    const node = dotGet(doc, spec.dot);
    return { exists: true, servers: isRecord(node) ? node : {}, error: null };
  }

  function expandCommand(command: string): string {
    return command.startsWith("~/") ? joinPath(home, command.slice(2)) : command;
  }

  /** 出站视图：只含可展示字段，凭据已掩码，路径一律 ~ / 相对形态。 */
  function viewOf(name: string, def: unknown, srcs: readonly ConnectorSourceSpec[]): McpConnectorView {
    const d = isRecord(def) ? def : {};
    const transport = transportOf(d);
    const view: { -readonly [K in keyof McpConnectorView]: McpConnectorView[K] } = {
      name,
      transport,
      disabled: d.disabled === true,
      valid: Boolean(d.command || d.url),
      effective: srcs.some((s) => s.effective),
      sources: srcs.map((s) => s.role),
    };
    if (typeof d.command === "string" && d.command) {
      view.command = tildePath(d.command, home);
      view.args = (Array.isArray(d.args) ? d.args : []).slice(0, 20).map((a) => maskArg(a, home));
      view.exists = existsSync(expandCommand(d.command));
    }
    if (typeof d.url === "string" && d.url) view.url = maskUrl(d.url);
    if (isRecord(d.env)) view.env = secretNames(d.env);
    if (isRecord(d.headers)) view.headers = secretNames(d.headers).map((h) => h.name);
    return view;
  }

  async function discover(): Promise<McpConnectorsView> {
    const reads = await Promise.all(specs.map(async (s) => ({ spec: s, read: await readSource(s) })));
    const outSources: McpConnectorSourceView[] = reads.map(({ spec, read }) => ({
      role: spec.role,
      label: spec.label,
      shown: spec.shown,
      effective: spec.effective,
      writable: spec.writable,
      exists: read.exists,
      count: Object.keys(read.servers).filter((n) => MCP_CONNECTOR_NAME_RE.test(n)).length,
      error: read.error,
    }));
    const byName = new Map<string, { def: unknown; srcs: ConnectorSourceSpec[]; effective: boolean }>();
    for (const { spec, read } of reads) {
      for (const [name, def] of Object.entries(read.servers)) {
        if (!MCP_CONNECTOR_NAME_RE.test(name)) continue;
        const hit = byName.get(name);
        if (!hit) {
          byName.set(name, { def, srcs: [spec], effective: spec.effective });
          continue;
        }
        hit.srcs.push(spec);
        // 生效来源的定义才是宿主实际加载的那份，覆盖先前从非生效来源取到的定义。
        if (spec.effective && !hit.effective) {
          hit.def = def;
          hit.effective = true;
        }
      }
    }
    const servers = Array.from(byName.entries())
      .map(([name, e]) => viewOf(name, e.def, e.srcs))
      .sort((a, b) => (a.effective === b.effective ? a.name.localeCompare(b.name) : a.effective ? -1 : 1));
    return {
      sources: outSources,
      servers,
      summary: {
        total: servers.length,
        effective: servers.filter((s) => s.effective).length,
        notLoaded: servers.filter((s) => !s.effective).length,
        disabled: servers.filter((s) => s.disabled).length,
        broken: servers.filter((s) => s.valid && s.transport === "stdio" && s.exists === false).length,
      },
    };
  }

  async function rawDefOf(name: string): Promise<Record<string, unknown> | null> {
    for (const spec of specs) {
      const read = await readSource(spec);
      const def = read.servers[name];
      if (isRecord(def)) return def;
    }
    return null;
  }

  function rpcLine(method: string, id: number | null, params?: unknown): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(id == null ? {} : { id }),
      ...(params ? { params } : {}),
    });
  }

  /** stdio 握手：initialize(id1) → notifications/initialized → tools/list(id2)，硬超时 SIGKILL。 */
  function handshakeStdio(def: Record<string, unknown>): Promise<McpConnectorCheckResult> {
    return new Promise((resolve) => {
      const t0 = now();
      const command = expandCommand(String(def.command ?? ""));
      const args = (Array.isArray(def.args) ? def.args : []).map((a) => String(a));
      let child;
      try {
        child = spawnFn(command, args, {
          env: { ...envBase as Record<string, string>, ...(isRecord(def.env) ? def.env as Record<string, string> : {}) },
        });
      } catch (e) {
        resolve({ name: "", status: "down", note: `无法启动：${String((e as Error)?.message ?? e).split("\n")[0]}`, checkedAt: iso() });
        return;
      }
      let out = "";
      let done = false;
      let sentList = false;
      const finish = (r: Omit<McpConnectorCheckResult, "name" | "checkedAt">): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* 已退出 */ }
        resolve({ name: "", checkedAt: iso(), ...r });
      };
      const timer = setTimeout(() => finish({ status: "down", note: `握手超时（${timeoutMs}ms）` }), timeoutMs);
      // 注意：此处刻意不 unref——握手期间它就是唯一的在途工作，unref 会让事件loop
      // 误判空闲（合成子进程场景直接饿死）；finish 必清 timer，不会悬挂进程。
      child.onData((chunk) => {
        out += chunk;
        if (out.length > MCP_CHILD_OUTPUT_MAX) {
          finish({ status: "error", note: "输出超限，已中止" });
          return;
        }
        const init = pickMsg(out, 1);
        if (!init) return;
        if (init.error) {
          finish({ status: "error", note: errNote(init, "initialize 失败") });
          return;
        }
        if (!sentList) {
          sentList = true;
          child.write(rpcLine("notifications/initialized", null));
          child.write(rpcLine("tools/list", 2, {}));
        }
        const list = pickMsg(out, 2);
        if (list) {
          const tools = ((list.result as { tools?: { name?: unknown }[] })?.tools ?? [])
            .map((t) => String(t?.name ?? "").slice(0, 60))
            .filter(Boolean);
          finish({
            status: "ok",
            toolCount: tools.length,
            tools: tools.slice(0, 60),
            note: `${tools.length} 个工具`,
            ms: now() - t0,
          });
        }
      });
      child.onError((e) => finish({
        status: "down",
        note: e.code === "ENOENT" ? `命令不存在：${tildePath(String(def.command ?? ""), home)}` : `启动失败：${String(e.message).split("\n")[0]}`,
        ms: now() - t0,
      }));
      child.onClose((code) => {
        const init = pickMsg(out, 1);
        if (init && !init.error && sentList) return; // 等 tools/list 的数据回调收尾
        finish({ status: "down", note: `进程退出（code ${String(code)}），未完成握手`, ms: now() - t0 });
      });
      child.write(rpcLine("initialize", 1, { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }));
    });
  }

  /** Streamable HTTP/SSE 握手：同一 initialize → tools/list 序列；401/403 如实 unauthorized。 */
  async function handshakeHttp(def: Record<string, unknown>): Promise<McpConnectorCheckResult> {
    const url = String(def.url ?? "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(isRecord(def.headers) ? def.headers as Record<string, string> : {}),
    };
    let sid: string | null = null;
    const call = async (body: unknown): Promise<{ status: number; text: string }> => {
      const h = { ...headers, ...(sid ? { "Mcp-Session-Id": sid } : {}) };
      const res = await fetchImpl(url, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      sid = res.headers.get("mcp-session-id") ?? sid;
      return { status: res.status, text };
    };
    const t0 = now();
    const base = { name: "", checkedAt: iso() };
    try {
      const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
      if (init.status === 401 || init.status === 403) {
        return { ...base, status: "unauthorized", ms: now() - t0, note: `HTTP ${init.status}：需宿主完成授权（OAuth / 网关登录态），命令行握手拿不到` };
      }
      if (init.status === 404 || init.status === 405) {
        return { ...base, status: "down", ms: now() - t0, note: `HTTP ${init.status}：端点不支持 POST initialize（可能是 SSE 传输或地址已变）` };
      }
      if (init.status < 200 || init.status >= 300) {
        return { ...base, status: "down", ms: now() - t0, note: `HTTP ${init.status} ${redactTail(init.text)}` };
      }
      const j = pickMsg(init.text, 1);
      if (!j) return { ...base, status: "error", ms: now() - t0, note: `响应非 JSON-RPC：${redactTail(init.text)}` };
      if (j.error) return { ...base, status: "error", ms: now() - t0, note: errNote(j, "initialize 失败") };
      await call({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => null);
      const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const lj = pickMsg(list.text, 2);
      const tools = lj
        ? (((lj.result as { tools?: { name?: unknown }[] })?.tools) ?? []).map((t) => String(t?.name ?? "").slice(0, 60)).filter(Boolean)
        : [];
      return { ...base, status: "ok", ms: now() - t0, toolCount: tools.length, tools: tools.slice(0, 60), note: `${tools.length} 个工具${sid ? " · 会话已建立" : ""}` };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).split("\n")[0];
      const abort = /abort|timeout/i.test(msg);
      return { ...base, status: "down", ms: now() - t0, note: abort ? `连接超时（${timeoutMs}ms）` : `连接失败：${msg.slice(0, 160)}` };
    }
  }

  async function handshake(name: string): Promise<McpConnectorCheckResult> {
    const disc = await discover();
    const srv = disc.servers.find((s) => s.name === name);
    if (!srv) {
      throw new McpBridgeError("mcp_not_found", `未在任何来源发现该连接器：${name.slice(0, 80)}`);
    }
    if (srv.disabled) return { name, status: "disabled", note: "配置里已禁用", checkedAt: iso() };
    if (!srv.valid) return { name, status: "unconfigured", note: "定义缺 command / url", checkedAt: iso() };
    const def = await rawDefOf(name);
    if (!def) return { name, status: "down", note: "读不到原始定义（来源文件已变更）", checkedAt: iso() };
    if (srv.transport === "stdio" && srv.exists === false) {
      return { name, status: "down", note: `命令不存在：${srv.command ?? ""}`, checkedAt: iso() };
    }
    if (srv.transport !== "stdio" && srv.transport !== "http" && srv.transport !== "sse") {
      return { name, status: "unconfigured", note: "无法推断传输方式（type 缺失且无 command/url）", checkedAt: iso() };
    }
    const r = srv.transport === "stdio" ? await handshakeStdio(def) : await handshakeHttp(def);
    return { ...r, name, checkedAt: iso() };
  }

  /** 本地已装的廉价 stdio 项也值得握一次；npx/uvx 要联网拉包，不自动握。 */
  function cheapLocalStdio(s: McpConnectorView): boolean {
    if (s.transport !== "stdio" || s.exists !== true || s.disabled || !s.valid) return false;
    return !REMOTE_RUNNER.test(basename(String(s.command ?? "")).replace(/\.exe$/i, ""));
  }

  async function check(opts: { name?: string; all?: boolean } = {}): Promise<McpCheckView> {
    const t0 = now();
    const disc = await discover();
    const targets = opts.name
      ? disc.servers.filter((s) => s.name === opts.name)
      : disc.servers.filter((s) => !s.disabled && s.valid && (opts.all === true || s.effective || cheapLocalStdio(s)));
    const deadline = now() + budgetMs;
    const results: McpConnectorCheckResult[] = [];
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < targets.length) {
        if (now() > deadline) return;
        const srv = targets[i];
        i += 1;
        try {
          results.push(await handshake(srv.name));
        } catch (error) {
          if (error instanceof McpBridgeError) {
            results.push({ name: srv.name, status: "down", note: error.message, checkedAt: iso() });
          } else {
            results.push({ name: srv.name, status: "error", note: `体检失败：${redactTail(String((error as Error)?.message ?? error))}`, checkedAt: iso() });
          }
        }
      }
    };
    const lanes = Math.min(MCP_CHECK_CONCURRENCY, Math.max(targets.length, 1));
    await Promise.all(Array.from({ length: lanes }, worker));
    return {
      checkedAt: iso(),
      ms: now() - t0,
      attempted: results.length,
      skipped: Math.max(0, targets.length - results.length),
      results,
    };
  }

  /* ---------------- dry（plan）/ confirm（apply） ---------------- */

  async function plan(op: McpConnectorOp, role: string, name: string, def?: unknown): Promise<WritePlan> {
    if (!OPS.includes(op)) {
      throw new McpBridgeError("mcp_invalid_request", `未知写操作：${String(op).slice(0, 20)}（可选 set/enable/disable/remove）。`);
    }
    const spec = specs.find((s) => s.role === role);
    if (!spec) {
      throw new McpBridgeError("mcp_invalid_request", `未知来源 role：${String(role).slice(0, 40)}（GET /local/mcp/connectors 查看来源清单）。`);
    }
    if (!spec.writable) {
      throw new McpBridgeError(
        "mcp_invalid_request",
        `来源「${spec.label}」未开放写入：宿主配置默认只读，桥侧显式配置 hostWrite=true 后才允许 dry→confirm 写入。`,
      );
    }
    if (!MCP_CONNECTOR_NAME_RE.test(String(name ?? ""))) {
      throw new McpBridgeError("mcp_invalid_request", "连接器名不合法（1–80 字符，不含引号与控制符）。");
    }
    const read = await readSource(spec);
    if (!read.exists) {
      throw new McpBridgeError("mcp_not_found", `来源文件不存在：${spec.shown}（宿主配置文件缺失时绝不代建）。`);
    }
    if (read.error) {
      throw new McpBridgeError("mcp_invalid_request", `来源文件 JSON 非法，拒绝写入（避免覆盖宿主配置）：${spec.shown}`);
    }
    const existed = Object.prototype.hasOwnProperty.call(read.servers, name);
    let payload: Record<string, unknown> | null = null;
    if (op === "set") {
      payload = cleanDef(def);
      if (!payload.command && !payload.url) {
        throw new McpBridgeError("mcp_invalid_request", "定义需要 command（stdio）或 url（HTTP/SSE）其一，且必须过白名单清洗。");
      }
    } else if (!existed) {
      throw new McpBridgeError("mcp_not_found", `该来源里没有这个连接器：${name.slice(0, 80)}`);
    }
    const before = existed ? JSON.stringify(maskDef(read.servers[name], home)) : null;
    const after = op === "remove"
      ? null
      : JSON.stringify(maskDef(op === "set" ? payload : { ...(read.servers[name] as Record<string, unknown>), ...(op === "disable" ? { disabled: true } : {}) }, home));
    if (op === "enable" && after !== null) {
      const projected = { ...(read.servers[name] as Record<string, unknown>) };
      delete projected.disabled;
      return { op, role, name, source: spec, def: payload, existed, diffBefore: before, diffAfter: JSON.stringify(maskDef(projected, home)) };
    }
    return { op, role, name, source: spec, def: payload, existed, diffBefore: before, diffAfter: after };
  }

  async function apply(writePlan: WritePlan): Promise<McpConfirmResult> {
    const spec = writePlan.source;
    let origText: string;
    try {
      origText = await readFile(spec.file, "utf-8");
    } catch {
      throw new McpBridgeError("mcp_not_found", `来源文件不存在：${spec.shown}（dry 之后被移走，本次未写入）。`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(origText);
    } catch {
      throw new McpBridgeError("mcp_invalid_request", `来源文件 JSON 非法，拒绝写入（避免覆盖宿主配置）：${spec.shown}`);
    }
    if (!isRecord(doc)) {
      throw new McpBridgeError("mcp_invalid_request", `来源文件顶层不是 JSON 对象，拒绝写入：${spec.shown}`);
    }
    // 只动 mcpServers 一个键：沿点路径下钻，缺失的中间层原样补空对象。
    const segs = spec.dot.split(".");
    let cur: Record<string, unknown> = doc;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      if (!isRecord(cur[seg])) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    const leafKey = segs[segs.length - 1];
    if (!isRecord(cur[leafKey])) cur[leafKey] = {};
    const leaf = cur[leafKey] as Record<string, unknown>;
    const existed = Object.prototype.hasOwnProperty.call(leaf, writePlan.name);
    if (writePlan.op !== "set" && !existed) {
      throw new McpBridgeError("mcp_not_found", `该来源里没有这个连接器（dry 之后被改动）：${writePlan.name.slice(0, 80)}`);
    }
    if (writePlan.op === "remove") delete leaf[writePlan.name];
    else if (writePlan.op === "disable") leaf[writePlan.name] = { ...(leaf[writePlan.name] as Record<string, unknown>), disabled: true };
    else if (writePlan.op === "enable") {
      const next = { ...(leaf[writePlan.name] as Record<string, unknown>) };
      delete next.disabled;
      leaf[writePlan.name] = next;
    } else leaf[writePlan.name] = { ...(existed ? leaf[writePlan.name] as Record<string, unknown> : {}), ...(writePlan.def ?? {}) };

    // 写前备份 .bak（0600）：备份失败即中止，绝不裸写宿主配置。
    const bakPath = `${spec.file}.bak`;
    try {
      await mkdir(dirname(bakPath), { recursive: true, mode: 0o700 });
      await writeFile(bakPath, origText, { encoding: "utf-8", mode: 0o600 });
      await chmod(bakPath, 0o600).catch(() => {});
    } catch (e) {
      throw new McpBridgeError("mcp_store_unavailable", `备份失败，已中止写入：${redactTail(String((e as Error)?.message ?? e))}`);
    }
    // 原子写；失败 → 原文未动（tmp+rename 语义），备份已在，如实报错。
    let mode = 0o600;
    try {
      mode = (await stat(spec.file)).mode & 0o777;
    } catch { /* 新文件用 0600 */ }
    try {
      await writeAtomic(spec.file, `${JSON.stringify(doc, null, 2)}\n`, mode || 0o600);
    } catch (e) {
      throw new McpBridgeError(
        "mcp_store_unavailable",
        `写入失败（原文未动，备份已留存 ${tildePath(bakPath, home)}）：${redactTail(String((e as Error)?.message ?? e))}`,
      );
    }
    // 回读校验：失败即从备份回滚，绝不留下半坏配置。
    try {
      JSON.parse(await readFile(spec.file, "utf-8"));
    } catch {
      await copyFile(bakPath, spec.file).catch(() => {});
      throw new McpBridgeError("mcp_upstream_error", `回读校验失败，已从备份回滚：${tildePath(bakPath, home)}`);
    }
    const verb: Record<McpConnectorOp, string> = { remove: "已移除", set: existed ? "已更新" : "已新增", disable: "已禁用", enable: "已启用" };
    const readBack = await readSource(spec);
    return {
      op: writePlan.op,
      role: writePlan.role,
      name: writePlan.name,
      existed,
      backup: tildePath(bakPath, home),
      note: `${verb[writePlan.op]}（写前备份 ${tildePath(bakPath, home)}）`,
      server: writePlan.op === "remove" ? null : viewOf(writePlan.name, readBack.servers[writePlan.name], [spec]),
    };
  }

  return { sources: () => specs, discover, handshake, check, plan, apply };
}

/** 缺省原子写：唯一 tmp + rename，失败清理 tmp（沿 reply/notify 桥口径）。 */
async function defaultWriteFileAtomic(path: string, text: string, mode: number): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, text, { encoding: "utf-8", mode });
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
