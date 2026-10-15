import { spawn } from "node:child_process";
import { access, constants as fsConstants, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import {
  normalizeSolutionDraft,
  SOLUTION_LIMITS,
  type SolutionDegradeCode,
  type SolutionDraft,
  type SolutionEvidence,
  type SolutionPlan,
} from "../src/lib/assistant-contract.ts";
import { templateSolutionDraft, type SolutionInput } from "./solution-template.ts";

/**
 * Generates a solution plan by driving the local Qoder CLI headlessly. The CLI is
 * a machine-local binary, so this module only ever runs inside `dev/` and can never
 * be part of the deployed Function. Only redacted retrieval snippets are handed to
 * the model; raw files, absolute paths and credentials stay out of the prompt.
 */

export interface SolutionGenerationRequest {
  readonly input: SolutionInput;
  readonly evidence: readonly SolutionEvidence[];
  readonly requestId: string;
}

export type SolutionGenerator = (request: SolutionGenerationRequest) => Promise<SolutionPlan>;

export interface CliInvocation {
  readonly binary: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly workdir: string;
  readonly timeoutMs: number;
}

/** Raw process outcome; envelope parsing stays in the generator so it is testable. */
export type CliOutcome = { ok: true; stdout: string } | { ok: false; code: SolutionDegradeCode };

export type CliRunner = (invocation: CliInvocation) => Promise<CliOutcome>;

const CLI_ENV_VAR = "SA_WORKBENCH_QODER_CLI";
const CLI_DIRECTORY = join(homedir(), ".qoder", "bin", "qodercli");
const PATH_FALLBACKS = ["qodercli", "qoder"] as const;
const WORK_DIRECTORY = join(tmpdir(), "sa-workbench-assistant");
/** A real headless run measured 163s of model time; 240s leaves headroom without outliving the browser's 270s budget. */
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** A complete plan measured 12.2k output tokens; the cap must not truncate the JSON. */
const MAX_OUTPUT_TOKENS = "16000";
const MAX_PROMPT_EVIDENCE = 6;

/**
 * Environment markers that switch the CLI into Agent-SDK mode. They are inherited
 * when the workbench itself is launched from a Qoder session and make a plain
 * headless run fail with `sdk_invalid_args`, so they are removed for the child.
 */
const SDK_ENV_KEYS = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODERCLI_RUNTIME_PACKAGING",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
  "QODER_WORKER_CWD",
  "QW_QODER_WORKER_RUNTIME_PATH",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_SDK_CUSTOM_BASE_URL_BYOK",
  "QODER_SESSION_TYPE",
] as const;

export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of SDK_ENV_KEYS) delete next[key];
  return next;
}

async function isExecutable(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const paths = isAbsolute(candidate)
    ? [candidate]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, candidate));
  for (const path of paths) {
    try {
      await access(path, fsConstants.X_OK);
      return true;
    } catch {
      // A missing file or a broken symlink simply is not a usable binary.
    }
  }
  return false;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function versionedBinaries(env: NodeJS.ProcessEnv): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(CLI_DIRECTORY);
  } catch {
    return [];
  }
  const versions = entries
    .map((entry) => /^qodercli-(\d+(?:\.\d+)*)$/.exec(entry)?.[1])
    .filter((version): version is string => Boolean(version))
    .sort(compareVersions);
  const candidates = versions.map((version) => join(CLI_DIRECTORY, `qodercli-${version}`));
  const pinned: string[] = [];
  try {
    const pinnedPath = join(CLI_DIRECTORY, `qodercli-${(await readFile(join(CLI_DIRECTORY, "version.txt"), "utf-8")).trim()}`);
    if (candidates.includes(pinnedPath)) pinned.push(pinnedPath);
  } catch {
    // No pinned version file: fall back to the newest installed binary.
  }
  const ordered = [...pinned, ...candidates.filter((path) => !pinned.includes(path))];
  for (const path of ordered) {
    if (await isExecutable(path, env)) return [path];
  }
  return [];
}

export async function resolveQoderCli(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const explicit = env[CLI_ENV_VAR]?.trim();
  if (explicit && await isExecutable(explicit, env)) return explicit;
  const [versioned] = await versionedBinaries(env);
  if (versioned) return versioned;
  for (const name of PATH_FALLBACKS) {
    if (await isExecutable(name, env)) return name;
  }
  return undefined;
}

interface ResultEnvelope {
  readonly result?: string;
  readonly stopReason?: string;
}

/** Scans stdout bottom-up for the CLI's `--output-format json` result envelope. */
function readResultEnvelope(stdout: string): ResultEnvelope | undefined {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (record.type !== "result") continue;
      const stopReason = typeof record.stop_reason === "string" ? record.stop_reason : undefined;
      if (record.is_error === true) return { stopReason };
      return { result: typeof record.result === "string" ? record.result : undefined, stopReason };
    } catch {
      // Not the envelope line; keep scanning upwards.
    }
  }
  return undefined;
}

/** Reads the `result` field out of the CLI's `--output-format json` envelope. */
export function extractModelText(stdout: string): string | undefined {
  return readResultEnvelope(stdout)?.result;
}

/** `max_tokens` here means the answer was cut off, not that the model wrote bad JSON. */
export function extractStopReason(stdout: string): string | undefined {
  return readResultEnvelope(stdout)?.stopReason;
}

export const defaultCliRunner: CliRunner = ({ binary, args, stdin, env, workdir, timeoutMs }) => new Promise((resolve) => {
  const child = spawn(binary, [...args], { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  const finish = (outcome: CliOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(outcome);
  };
  const timer = setTimeout(() => {
    console.error(JSON.stringify({ event: "qoder_cli_timeout", timeoutMs, stdoutBytes, stderrBytes }));
    child.kill("SIGKILL");
    finish({ ok: false, code: "cli-timeout" });
  }, timeoutMs);

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk;
  });
  // Drained and counted only: stderr can echo local configuration paths.
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
  });
  child.on("error", () => finish({ ok: false, code: "cli-not-found" }));
  child.on("close", (exitCode) => {
    if (exitCode === 0) {
      finish({ ok: true, stdout });
      return;
    }
    console.error(JSON.stringify({ event: "qoder_cli_run_failed", exitCode, stdoutBytes, stderrBytes }));
    finish({ ok: false, code: "cli-failed" });
  });
  child.stdin.on("error", () => finish({ ok: false, code: "cli-failed" }));
  child.stdin.end(stdin);
});

const SYSTEM_PROMPT = [
  "你是阿里云资深解决方案架构师，为企业客户设计贴合阿里云产品体系的落地方案。",
  "严格遵守：",
  "1. 只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块，不要注释。",
  "2. JSON 结构固定为：",
  '{"title":string,"summary":string,',
  '"layers":[{"name":string,"purpose":string,"products":[{"name":string,"role":string}]}],',
  '"flows":[{"name":string,"steps":[string]}],',
  '"mapping":[{"need":string,"product":string,"reason":string}],',
  '"risks":[{"risk":string,"mitigation":string}],"nextSteps":[string]}',
  `3. layers 为 4 到 ${SOLUTION_LIMITS.layers} 层，自上而下构成完整架构（接入、应用与智能体、模型与知识、数据、基础设施与可观测、安全合规），每层 2 到 ${SOLUTION_LIMITS.productsPerLayer} 个产品。`,
  "4. 产品必须使用真实的阿里云产品名称（如 容器服务 Kubernetes 版 ACK、函数计算 FC、阿里云百炼、人工智能平台 PAI、对象存储 OSS、大数据计算服务 MaxCompute、实时数仓 Hologres、日志服务 SLS、专有网络 VPC、Web 应用防火墙 WAF 3.0、API 网关、访问控制 RAM、密钥管理服务 KMS、云安全中心、数据安全中心 DSC、应用实时监控服务 ARMS、通义千问 Qwen、向量检索服务 DashVector、云效、Qoder），不得杜撰产品或版本号。",
  "5. flows 给出 2 到 3 条关键链路，steps 为可执行的先后步骤。",
  "6. mapping 把客户诉求逐条映射到具体阿里云产品并说明理由；risks 给出风险与缓解措施；nextSteps 为可落地的下一步。",
  "7. 只使用提供的受控证据片段作为事实依据；证据没有覆盖的内容按通用最佳实践设计，不要编造客户既有系统、数据量或合同信息。",
  "8. 不得输出任何绝对文件路径、凭据、令牌或个人隐私信息；引用资料时只用给定的 referenceId。",
  "9. 全文使用简体中文，summary 为 120 到 300 字的整体说明。",
].join("\n");

function evidenceBlock(evidence: readonly SolutionEvidence[]): string {
  if (!evidence.length) return "（本次没有召回到受控证据，请按通用最佳实践设计，并在 summary 中说明未使用本地资料。）";
  return evidence.slice(0, MAX_PROMPT_EVIDENCE).map((item, index) => [
    `[${index + 1}] referenceId=${item.referenceId}`,
    `标题：${item.title || "未命名"}｜来源：${item.sourceLabel}｜定位：${item.locator}`,
    `片段：${item.text}`,
  ].join("\n")).join("\n\n");
}

export function buildPrompt(request: SolutionGenerationRequest): string {
  const { input, evidence } = request;
  return [
    "请为以下客户设计一份贴合阿里云产品体系的落地方案。",
    "",
    `客户名称：${input.customer}`,
    `所属行业：${input.industry || "未提供"}`,
    `业务目标：${input.goal}`,
    `现状与约束：${input.constraints || "未提供"}`,
    "",
    "隐私边界（必须在方案中体现）：原始文件与凭据保留在本机，仅摘要、受控引用片段、元数据与向量进入云上知识底座。",
    "",
    "可用的受控证据片段：",
    evidenceBlock(evidence),
    "",
    `请在 mapping 或 summary 中，用 referenceId 标注引用了哪些证据（形如 [${evidence[0]?.referenceId ?? "doc:c1"}]），最多引用 ${SOLUTION_LIMITS.evidence} 条。`,
  ].join("\n");
}

export function cliArgs(workdir: string): string[] {
  return [
    "--setting-sources", "local",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--system-prompt", SYSTEM_PROMPT,
    "--max-output-tokens", MAX_OUTPUT_TOKENS,
    "-o", "json",
    "-w", workdir,
    "-p",
    "--tools", "",
  ];
}

/** Strips Markdown fences and returns the outermost JSON object text. */
export function extractJsonPayload(text: string): string | undefined {
  const unfenced = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : undefined;
}

export interface SolutionGeneratorDependencies {
  readonly runner?: CliRunner;
  readonly resolveBinary?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  readonly timeoutMs?: number;
  readonly workdir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export function createSolutionGenerator(dependencies: SolutionGeneratorDependencies = {}): SolutionGenerator {
  const runner = dependencies.runner ?? defaultCliRunner;
  const resolveBinary = dependencies.resolveBinary ?? resolveQoderCli;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workdir = dependencies.workdir ?? WORK_DIRECTORY;
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());

  return async (request) => {
    const evidence = [...request.evidence];
    const fallback = (code: SolutionDegradeCode): SolutionPlan => {
      console.error(JSON.stringify({
        event: "solution_generation_degraded",
        requestId: request.requestId,
        code,
        evidenceCount: evidence.length,
      }));
      return {
        ...templateSolutionDraft(request.input),
        engine: "template",
        degraded: code,
        evidence,
        generatedAt: now().toISOString(),
      };
    };

    const binary = await resolveBinary(cliEnv(env));
    if (!binary) return fallback("cli-not-found");

    try {
      await mkdir(workdir, { recursive: true });
    } catch {
      return fallback("cli-failed");
    }

    const outcome = await runner({
      binary,
      args: cliArgs(workdir),
      stdin: buildPrompt(request),
      env: cliEnv(env),
      workdir,
      timeoutMs,
    });
    if (!outcome.ok) return fallback(outcome.code);

    const modelText = extractModelText(outcome.stdout);
    const payload = modelText === undefined ? undefined : extractJsonPayload(modelText);
    const draft: SolutionDraft | undefined = payload ? normalizeSolutionDraft(safeParse(payload)) : undefined;
    if (draft) return { ...draft, engine: "qoder-cli", evidence, generatedAt: now().toISOString() };

    console.error(JSON.stringify({
      event: "qoder_cli_output_rejected",
      requestId: request.requestId,
      stopReason: extractStopReason(outcome.stdout) ?? "unknown",
      modelTextLength: modelText?.length ?? 0,
      payloadLength: payload?.length ?? 0,
    }));
    return fallback("cli-invalid-output");
  };
}

function safeParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

export const solutionGenerator: SolutionGenerator = createSolutionGenerator();
