import assert from "node:assert/strict";
import test from "node:test";

import { dependenciesRow, isSupportedNode, nodeVersionRow } from "./workbench/workbench-node.ts";
import { configRows } from "./workbench/workbench-config.ts";
import { envRows, QODER_CHANNEL_KEYS } from "./workbench/workbench-env.ts";
import { TOOL_SPECS, toolsRows, type CommandRunner } from "./workbench/workbench-tools.ts";
import { portsRows, type PortProbe } from "./workbench/workbench-ports.ts";
import { permissionsRow } from "./workbench/workbench-permissions.ts";
import { collectChecks, type WorkbenchDeps } from "./workbench/workbench-checks.ts";
import { buildReport, checkRow, exitCodeOf, summarize, type CheckRow } from "./workbench/workbench-types.ts";
import { formatReport, renderToolOutput } from "./workbench/workbench-format.ts";
import type { WorkbenchEntry, WorkbenchFs } from "./workbench/workbench-fs.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：目录表 / 存在集合 / 内容表全部使用合成路径与合成包名
// （synth-root、react-syn、甲乙丙丁以外不出现真实仓库、桶、客户或凭据）。
// 敏感路径（.env.local、.local-cache/**）一旦被读内容，假 fs 立即抛错——
// init/doctor 的契约是「只报存在性，绝不读值」。
// ---------------------------------------------------------------------------

const SYNTH_ROOT = "/synth-root";

const PKG_MANIFEST = JSON.stringify({
  dependencies: { "react-syn": "1.0.0" },
  devDependencies: { "vite-syn": "1.0.0" },
});

const CONFIG_ENTRIES: readonly WorkbenchEntry[] = [
  { name: "agents.json.example", kind: "file", mode: 0o644 },
  { name: "cases.json.example", kind: "file", mode: 0o644 },
  { name: "kb.json.example", kind: "file", mode: 0o644 },
  { name: "leads.json.example", kind: "file", mode: 0o644 },
  { name: "report.json.example", kind: "file", mode: 0o644 },
];

interface TableFsOptions {
  readonly dirs?: Readonly<Record<string, readonly WorkbenchEntry[]>>;
  readonly existing?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
}

function tableFs(options: TableFsOptions): WorkbenchFs {
  const existing = new Set(options.existing ?? []);
  return {
    exists: async (path) => existing.has(path),
    readFile: async (path) => {
      const content = options.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    list: async (dir) => {
      const entries = options.dirs?.[dir];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return [...entries];
    },
  };
}

function byName(rows: readonly CheckRow[]): Map<string, CheckRow> {
  return new Map(rows.map((row) => [row.name, row]));
}

const file = (name: string, mode = 0o600): WorkbenchEntry => ({ name, kind: "file", mode });
const dir = (name: string, mode = 0o700): WorkbenchEntry => ({ name, kind: "dir", mode });

// ---------------------------------------------------------------------------
// 1. runtime：Node 版本判定边界 + 依赖分支
// ---------------------------------------------------------------------------

test("isSupportedNode accepts 22.12+ within the 22.x series only", () => {
  assert.equal(isSupportedNode("22.12.0"), true, "下边界 minor=12 通过");
  assert.equal(isSupportedNode("v22.23.2"), true, "带 v 前缀也能解析");
  assert.equal(isSupportedNode("22.11.9"), false, "minor=11 拒绝");
  assert.equal(isSupportedNode("23.0.0"), false, "23.x 拒绝");
  assert.equal(isSupportedNode("21.7.0"), false, "21.x 拒绝");
  assert.equal(isSupportedNode("22"), false, "缺 minor 拒绝");
  assert.equal(isSupportedNode(""), false);
  assert.equal(isSupportedNode("不是版本号"), false);
});

test("nodeVersionRow reports error with fix hint for unsupported node, ok otherwise", () => {
  const bad = nodeVersionRow("23.0.0");
  assert.equal(bad.group, "runtime");
  assert.equal(bad.status, "error");
  assert.match(bad.detail, /nvm use 22/);
  assert.equal(nodeVersionRow("22.23.2").status, "ok");
});

test("dependenciesRow demands npm ci when node_modules is missing", async () => {
  const fs = tableFs({ files: { [`${SYNTH_ROOT}/package.json`]: PKG_MANIFEST } });
  const row = await dependenciesRow(SYNTH_ROOT, fs);
  assert.equal(row.status, "error");
  assert.match(row.detail, /npm ci/);
  assert.match(row.detail, /2 个包/);
});

test("dependenciesRow names missing packages and passes when all resolve", async () => {
  const missing = await dependenciesRow(
    SYNTH_ROOT,
    tableFs({
      files: { [`${SYNTH_ROOT}/package.json`]: PKG_MANIFEST },
      existing: [`${SYNTH_ROOT}/node_modules`, `${SYNTH_ROOT}/node_modules/react-syn/package.json`],
    }),
  );
  assert.equal(missing.status, "error");
  assert.match(missing.detail, /vite-syn/);
  assert.match(missing.detail, /npm ci/);

  const ok = await dependenciesRow(
    SYNTH_ROOT,
    tableFs({
      files: { [`${SYNTH_ROOT}/package.json`]: PKG_MANIFEST },
      existing: [
        `${SYNTH_ROOT}/node_modules`,
        `${SYNTH_ROOT}/node_modules/react-syn/package.json`,
        `${SYNTH_ROOT}/node_modules/vite-syn/package.json`,
      ],
    }),
  );
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, /2\/2/);
});

test("dependenciesRow degrades to error when package.json is unreadable", async () => {
  const row = await dependenciesRow(SYNTH_ROOT, tableFs({}));
  assert.equal(row.status, "error");
  assert.match(row.detail, /package\.json/);
});

// ---------------------------------------------------------------------------
// 2. config：只报存在性，缺失项带「复制模板」修法
// ---------------------------------------------------------------------------

test("configRows reports presence only: templates ok, missing personal configs stay info with copy hints", async () => {
  const fs = tableFs({
    dirs: { [`${SYNTH_ROOT}/config`]: CONFIG_ENTRIES },
    existing: [`${SYNTH_ROOT}/.env.local`, `${SYNTH_ROOT}/.local-cache`, `${SYNTH_ROOT}/.local-cache/kb.json`],
    files: {
      // 契约哨兵：若实现试图读 .env.local / 个人配置的内容，这里直接失败。
      [`${SYNTH_ROOT}/.env.local`]: "DASHSCOPE_API_KEY=sk-synthetic-must-not-read",
      [`${SYNTH_ROOT}/.local-cache/kb.json`]: "{\"secret\":\"synthetic\"}",
    },
  });
  const rows = await configRows(SYNTH_ROOT, fs);
  assert.ok(rows.every((row) => row.group === "config"));
  const named = byName(rows);

  assert.equal(named.get(".env.local")?.status, "ok");
  assert.equal(named.get(".local-cache/")?.status, "ok");
  assert.equal(named.get(".local-cache/kb.json")?.status, "ok");

  const cases = named.get(".local-cache/cases.json");
  assert.equal(cases?.status, "info", "个人配置缺失 = 未配置（info），不是错误");
  assert.match(cases?.detail ?? "", /复制 config\/cases\.json\.example 为 \.local-cache\/cases\.json/);

  const templates = named.get("config/*.json.example");
  assert.equal(templates?.status, "ok");
  assert.match(templates?.detail ?? "", /5 个/);
  assert.match(templates?.detail ?? "", /agents|cases|kb|leads|report/);

  assert.equal(named.get("config/*.json")?.status, "ok", "无个人配置误放");
});

test("configRows hints .env.local copy fix when missing and flags stray personal json in config/", async () => {
  const fs = tableFs({
    dirs: { [`${SYNTH_ROOT}/config`]: [...CONFIG_ENTRIES, file("cases.json", 0o644)] },
  });
  const rows = await configRows(SYNTH_ROOT, fs);
  const named = byName(rows);

  const envLocal = named.get(".env.local");
  assert.equal(envLocal?.status, "info");
  assert.match(envLocal?.detail ?? "", /\.env\.example/);
  assert.equal(named.get(".local-cache/")?.status, "info", "目录缺失如实报未创建");

  const stray = named.get("config/*.json");
  assert.equal(stray?.status, "warn", "config/ 会随 git 入库，个人配置误放必须提醒");
  assert.match(stray?.detail ?? "", /cases\.json/);
  assert.match(stray?.detail ?? "", /\.local-cache/);
});

test("configRows errors honestly when the template directory is unreadable", async () => {
  const rows = await configRows(SYNTH_ROOT, tableFs({ existing: [`${SYNTH_ROOT}/.local-cache`] }));
  const templates = byName(rows).get("config/*.json.example");
  assert.equal(templates?.status, "error");
});

// ---------------------------------------------------------------------------
// 3. env：只报已设置/未设置，值绝不入行
// ---------------------------------------------------------------------------

const ENV_SENTINEL = "sk-synthetic-sentinel-000000000000";

test("envRows reports set/unset booleans only and never echoes values", () => {
  const full = Object.fromEntries([
    ["DASHSCOPE_API_KEY", ENV_SENTINEL],
    ...QODER_CHANNEL_KEYS.map((key) => [key, ENV_SENTINEL]),
  ]);
  const rows = envRows(full);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes(ENV_SENTINEL), "env 值绝不出现在任何行里");

  const named = byName(rows);
  assert.equal(named.get("DASHSCOPE_API_KEY")?.status, "ok");
  assert.match(named.get("DASHSCOPE_API_KEY")?.detail ?? "", /已设置/);
  const channel = named.get("Qoder Cloud Agents 通道");
  assert.equal(channel?.status, "ok");
  assert.match(channel?.detail ?? "", /4\/4/);
});

test("envRows treats blank values as unset and partial Qoder keys as warn", () => {
  const rows = envRows({ DASHSCOPE_API_KEY: "   ", QODER_PAT: "syn-1", QODER_AGENT_ID: "syn-2" });
  assert.ok(!JSON.stringify(rows).includes("syn-1"), "部分键的值同样不泄漏");
  const named = byName(rows);

  const dashscope = named.get("DASHSCOPE_API_KEY");
  assert.equal(dashscope?.status, "info", "空串视为未设置");
  assert.match(dashscope?.detail ?? "", /\.env\.local/);

  const channel = named.get("Qoder Cloud Agents 通道");
  assert.equal(channel?.status, "warn", "四键只齐一半 → 提醒");
  assert.match(channel?.detail ?? "", /2\/4/);
  assert.match(channel?.detail ?? "", /QODER_AGENT_VERSION/);
  assert.ok(!channel?.detail.includes("syn-1"));

  assert.equal(byName(envRows({})).get("Qoder Cloud Agents 通道")?.status, "info", "全缺 = 未配置，不凑 warn");
});

// ---------------------------------------------------------------------------
// 4. tools：注入假 runner 的 which 探测
// ---------------------------------------------------------------------------

test("toolsRows probes each tool via which with the injected runner and degrades per row", async () => {
  const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args: [...args], timeoutMs: options.timeoutMs });
    const tool = args[0] ?? "";
    if (tool === "dws") return { code: 0, stdout: "/synth/bin/dws\n", stderr: "" };
    if (tool === "a1") return { code: 1, stdout: "", stderr: "" };
    if (tool === "ossutil") return { code: "ENOENT", stdout: "", stderr: "" };
    if (tool === "qodercli") return { code: null, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  const rows = await toolsRows(runner, 5_000);
  assert.equal(rows.length, TOOL_SPECS.length);
  const named = byName(rows);

  const dws = named.get("dws");
  assert.equal(dws?.status, "ok");
  assert.ok(!dws?.detail.includes("/synth/bin"), "which 输出的路径不进说明（只报存在性）");

  const a1 = named.get("a1");
  assert.equal(a1?.status, "info", "未安装是能力缺口（info），不是错误");
  assert.match(a1?.detail ?? "", /修法/);

  const ossutil = named.get("ossutil");
  assert.equal(ossutil?.status, "info", "which 本身不可用时如实说无法探测");
  assert.match(ossutil?.detail ?? "", /which/);

  assert.equal(named.get("qodercli")?.status, "warn");
  assert.match(named.get("qodercli")?.detail ?? "", /超时/);
  assert.equal(named.get("aliyun")?.status, "ok");

  assert.deepEqual(
    calls.map((call) => [call.file, call.args]),
    TOOL_SPECS.map((spec) => ["which", [spec.name]]),
    "恰每工具一次 which 探测，参数是数组形式",
  );
  assert.ok(calls.every((call) => call.timeoutMs === 5_000));
});

// ---------------------------------------------------------------------------
// 5. ports：占用 → warn，空闲 → ok，探测失败 → info
// ---------------------------------------------------------------------------

test("portRows warns only when occupied and stays honest when the probe cannot decide", async () => {
  const probe: PortProbe = async (_host, port) => (port === 4173 ? "occupied" : "free");
  const rows = await portsRows(probe, 2_000);
  const named = byName(rows);

  const preview = named.get("4173（vite preview）");
  assert.equal(preview?.status, "warn");
  assert.match(preview?.detail ?? "", /127\.0\.0\.1:4173/);
  assert.equal(named.get("8000（本地 Function 桥）")?.status, "ok");

  const undecided = await portsRows(async () => "unknown", 2_000);
  assert.ok(undecided.every((row) => row.status === "info"));
});

// ---------------------------------------------------------------------------
// 6. security：.local-cache 权限巡检（只报权限位数字）
// ---------------------------------------------------------------------------

test("permissionsRow warns on mode drift with digits only and skips symlinks", async () => {
  const fs = tableFs({
    existing: [`${SYNTH_ROOT}/.local-cache`],
    dirs: {
      [`${SYNTH_ROOT}/.local-cache`]: [
        file("kb.json", 0o600),
        file("ops-note.json", 0o644),
        dir("reports", 0o755),
        { name: "link-syn", kind: "other", mode: 0o777 },
      ],
      [`${SYNTH_ROOT}/.local-cache/reports`]: [file("daily.json", 0o600)],
    },
  });
  const row = await permissionsRow(SYNTH_ROOT, fs);
  assert.equal(row.group, "security");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /0644/);
  assert.match(row.detail, /0755/);
  assert.match(row.detail, /ops-note\.json/);
  assert.ok(!row.detail.includes("daily.json"), "合规条目不逐个点名");
  assert.ok(!row.detail.includes("link-syn"), "符号链接不适用 0600/0700 口径");
});

test("permissionsRow answers ok when every entry is 0600/0700 and info when the dir is absent", async () => {
  const good = await permissionsRow(
    SYNTH_ROOT,
    tableFs({
      existing: [`${SYNTH_ROOT}/.local-cache`],
      dirs: {
        [`${SYNTH_ROOT}/.local-cache`]: [file("kb.json", 0o600), dir("sub", 0o700)],
        [`${SYNTH_ROOT}/.local-cache/sub`]: [],
      },
    }),
  );
  assert.equal(good.status, "ok");
  assert.match(good.detail, /内容不读取/);

  const absent = await permissionsRow(SYNTH_ROOT, tableFs({}));
  assert.equal(absent.status, "info");
  assert.match(absent.detail, /不存在/);
});

test("permissionsRow truncates long deviation lists instead of flooding the report", async () => {
  const entries = Array.from({ length: 8 }, (_, index) => file(`synth-${index}.json`, 0o644));
  const row = await permissionsRow(
    SYNTH_ROOT,
    tableFs({ existing: [`${SYNTH_ROOT}/.local-cache`], dirs: { [`${SYNTH_ROOT}/.local-cache`]: entries } }),
  );
  assert.equal(row.status, "warn");
  assert.match(row.detail, /8 个/);
  assert.match(row.detail, /等 8 个/);
  assert.ok(!row.detail.includes("synth-6"), "只展示前几个偏离项");
});

// ---------------------------------------------------------------------------
// 7. 报告契约与退出码
// ---------------------------------------------------------------------------

test("report summary, ok flag and exit code follow the contract", () => {
  const rows = [
    checkRow("runtime", "node", "ok", "合成"),
    checkRow("config", ".env.local", "info", "合成"),
    checkRow("ports", "4173（vite preview）", "warn", "合成"),
    checkRow("runtime", "dependencies", "error", "合成"),
  ];
  const report = buildReport("doctor", rows, Date.parse("2026-10-20T08:00:00.000Z"));
  assert.equal(report.ok, false);
  assert.deepEqual(report.summary, { ok: 1, info: 1, warn: 1, error: 1 });
  assert.equal(report.generatedAt, "2026-10-20T08:00:00.000Z");
  assert.equal(exitCodeOf(report), 1, "任一 error → 退出码 1");

  const clean = buildReport("init", rows.slice(0, 3), Date.now());
  assert.equal(clean.ok, true);
  assert.equal(exitCodeOf(clean), 0, "warn/info 不影响退出码");
  assert.deepEqual(summarize([]), { ok: 0, info: 0, warn: 0, error: 0 });
});

// ---------------------------------------------------------------------------
// 8. 表格渲染 + init 引导
// ---------------------------------------------------------------------------

test("formatReport renders grouped rows with status symbols and a summary line", () => {
  const report = buildReport(
    "doctor",
    [
      checkRow("runtime", "node", "ok", "Node 22.23.2（合成）"),
      checkRow("runtime", "dependencies", "error", "node_modules 缺失（合成）"),
      checkRow("config", ".env.local", "info", "未创建（合成）"),
    ],
    Date.parse("2026-10-20T08:00:00.000Z"),
  );
  const text = formatReport(report);
  assert.match(text, /SA 工作台/);
  assert.match(text, /\[runtime\]/);
  assert.match(text, /\[config\]/);
  assert.ok(text.indexOf("[runtime]") < text.indexOf("[config]"), "分组按行序出现");
  assert.ok(text.includes("✓") && text.includes("○") && text.includes("✗"));
  assert.match(text, /汇总[：:]ok 1 · info 1 · warn 0 · error 1/);
  assert.match(text, /2026-10-20T08:00:00\.000Z/);
});

test("renderToolOutput appends next steps for init only", () => {
  const rows = [checkRow("runtime", "node", "ok", "合成")];
  const init = renderToolOutput(buildReport("init", rows, 0));
  assert.match(init, /下一步/);
  assert.match(init, /npm run doctor/);
  assert.ok(!renderToolOutput(buildReport("doctor", rows, 0)).includes("下一步"));
});

// ---------------------------------------------------------------------------
// 9. 汇总装配：全合成 deps
// ---------------------------------------------------------------------------

function synthDeps(overrides: Partial<WorkbenchDeps> = {}): WorkbenchDeps {
  return {
    rootDir: SYNTH_ROOT,
    nodeVersion: "22.23.2",
    env: {},
    fs: tableFs({
      dirs: {
        [`${SYNTH_ROOT}/config`]: CONFIG_ENTRIES,
        [`${SYNTH_ROOT}/.local-cache`]: [file("kb.json", 0o600)],
      },
      files: { [`${SYNTH_ROOT}/package.json`]: PKG_MANIFEST },
      existing: [
        `${SYNTH_ROOT}/node_modules`,
        `${SYNTH_ROOT}/node_modules/react-syn/package.json`,
        `${SYNTH_ROOT}/node_modules/vite-syn/package.json`,
        `${SYNTH_ROOT}/.local-cache`,
      ],
    }),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    probePort: async () => "free",
    nowMs: Date.parse("2026-10-20T08:00:00.000Z"),
    ...overrides,
  };
}

test("collectChecks assembles all groups in order and derives the exit code", async () => {
  const report = await collectChecks("doctor", synthDeps());
  const groups = [...new Set(report.checks.map((row) => row.group))];
  assert.deepEqual(groups, ["runtime", "config", "env", "tools", "ports", "security"]);
  assert.equal(report.tool, "doctor");
  assert.equal(report.generatedAt, "2026-10-20T08:00:00.000Z");
  assert.equal(report.ok, true, "合成环境无 error");
  assert.equal(exitCodeOf(report), 0);
});

test("collectChecks degrades a throwing group to one error row instead of crashing", async () => {
  const deps = synthDeps({ probePort: async () => { throw new Error("probe boom synth"); } });
  const report = await collectChecks("init", deps);
  const portsGroup = report.checks.filter((row) => row.group === "ports");
  assert.equal(portsGroup.length, 1, "ports 组整体降级为一行 error");
  assert.equal(portsGroup[0]?.status, "error");
  assert.match(portsGroup[0]?.detail ?? "", /检查异常/);
  assert.equal(report.checks.filter((row) => row.group === "tools").length, TOOL_SPECS.length, "其余组不受影响");
  assert.equal(exitCodeOf(report), 1);
});
