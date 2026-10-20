/**
 * 指引 check 步执行器（TS 移植自 base/sa-workbench scripts/lib/guides.js checkStep，
 * 搬语义不搬代码：同步 spawnSync/existsSync 改为异步注入 runner/fs）。
 *
 * 五类检测全部只读：bin（--version 探测）/ dwsSession（auth status，身份值绝不回显）/
 * file（存在性）/ cap（注入的能力视图判定，未注入则诚实报无法判定）/
 * aitable-verify（读回远端表字段比对必需项）。detail 不含绝对路径；
 * 一切子进程输出先过 redactNote 才可能进 detail。
 */

import { access } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Guide, GuideStep } from "../../src/lib/guides-model.ts";
import { redactNote } from "../health/health-redact.ts";
import { verifySchema } from "./aitable-provision.ts";
import type { CapsView, GuideCheckResult, GuideCommandRunner, GuideVerifyResult } from "./guides-types.ts";

export interface CheckDeps {
  readonly run: GuideCommandRunner;
  readonly dwsBin: string;
  readonly cacheDir: string;
  readonly timeoutMs: number;
  readonly capsView?: CapsView;
}

interface RawResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly results?: readonly GuideVerifyResult[];
}

const VERSION_RE = /(\d+\.\d+\.\d+)/;

async function checkBin(name: string, deps: CheckDeps): Promise<RawResult> {
  const bin = name === "dws" ? deps.dwsBin : name;
  const label = basename(bin);
  const result = await deps.run(bin, ["--version"], { timeoutMs: deps.timeoutMs });
  if (result.code === "ENOENT") return { ok: false, detail: `未找到可执行文件：${label}` };
  if (result.code === null) return { ok: false, detail: `${label} --version 探测超时` };
  if (result.code !== 0) {
    const line = redactNote(result.stderr || result.stdout);
    return { ok: false, detail: line ? `${label} --version 失败：${line}` : `${label} 退出码 ${String(result.code)}` };
  }
  const version = VERSION_RE.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? "";
  return { ok: true, detail: version ? `${label} CLI 在位（${version}）` : `${label} CLI 在位` };
}

async function checkDwsSession(deps: CheckDeps): Promise<RawResult> {
  const result = await deps.run(deps.dwsBin, ["auth", "status", "--format", "json"], { timeoutMs: deps.timeoutMs });
  if (result.code === "ENOENT") return { ok: false, detail: `dws CLI 不存在：${basename(deps.dwsBin)}` };
  if (result.code === null) return { ok: false, detail: "dws auth status 探测超时" };
  let payload: Record<string, unknown> | undefined;
  for (const text of [result.stdout, result.stderr]) {
    const s = String(text ?? "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const parsed: unknown = JSON.parse(s.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      /* 继续尝试下一段输出 */
    }
  }
  if (!payload) {
    const line = redactNote(result.stderr || result.stdout);
    return { ok: false, detail: line ? `dws auth status 失败：${line}` : `dws 退出码 ${String(result.code)}` };
  }
  const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  if (data.authenticated === true || data.authenticated === "true") {
    /* v2 红线：corp_name / user_name 等身份值绝不回显，只报「已授权」。 */
    return { ok: true, detail: "已授权" };
  }
  return { ok: false, detail: "授权未完成或已过期：终端执行 dws auth login" };
}

async function checkFile(path: string, deps: CheckDeps): Promise<RawResult> {
  const rel = String(path ?? "").replace(/^[/~].*$/, "");
  if (!rel) return { ok: false, detail: "检测未声明文件路径" };
  try {
    await access(join(deps.cacheDir, rel));
    return { ok: true, detail: `${rel} 存在` };
  } catch {
    return { ok: false, detail: `文件不存在：${rel}` };
  }
}

function checkCap(id: string, deps: CheckDeps): RawResult {
  const view = deps.capsView ? deps.capsView() : undefined;
  if (!view) return { ok: false, detail: "无法判定：桥未注入能力视图（capsView）" };
  const state = view[id]?.state ?? "unconfigured";
  return state === "ok"
    ? { ok: true, detail: "能力已就绪" }
    : { ok: false, detail: `能力未就绪（${state}），缺项见设置页 · 能力` };
}

async function checkAitableVerify(schemas: readonly string[], deps: CheckDeps): Promise<RawResult> {
  const results: GuideVerifyResult[] = [];
  for (const id of schemas) {
    const v = await verifySchema(id, { run: deps.run, dwsBin: deps.dwsBin, cacheDir: deps.cacheDir, timeoutMs: deps.timeoutMs });
    results.push({ id, ok: v.ok, note: v.note });
  }
  const bad = results.filter((x) => !x.ok);
  return bad.length
    ? { ok: false, detail: bad.map((x) => `${x.id}：${x.note}`).join("；").slice(0, 300), results }
    : { ok: true, detail: "全部校验通过", results };
}

/** 执行一个 check 步；step.kind !== "check" 由调用方（bridge）先行拦截。 */
export async function checkStep(guide: Guide, step: GuideStep, deps: CheckDeps): Promise<GuideCheckResult> {
  const c = step.check ?? { type: "file" as const };
  let raw: RawResult;
  switch (c.type) {
    case "bin":
      raw = await checkBin(c.name ?? "dws", deps);
      break;
    case "dwsSession":
      raw = await checkDwsSession(deps);
      break;
    case "file":
      raw = await checkFile(c.path ?? "", deps);
      break;
    case "cap":
      raw = checkCap(c.id ?? "", deps);
      break;
    case "aitable-verify":
      raw = await checkAitableVerify(c.schemas ?? [], deps);
      break;
    default:
      raw = { ok: false, detail: `未知检测类型 ${String((c as { type?: unknown }).type ?? "")}` };
  }
  return raw.results
    ? { guide: guide.id, step: step.id, state: raw.ok ? "ok" : "fail", detail: raw.detail, results: raw.results }
    : { guide: guide.id, step: step.id, state: raw.ok ? "ok" : "fail", detail: raw.detail };
}
