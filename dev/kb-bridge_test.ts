import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createKbBridge,
  DEFAULT_KB_CONFIG_PATH,
  KB_ID_PATTERN,
  KbBridgeError,
  rrfFuse,
  RRF_K,
  type KbBridge,
  type KbBridgeOptions,
} from "./kb-bridge.ts";
import type {
  KbAdapterHit,
  KbSource,
  KbSourceType,
  KbSummaryHit,
} from "./kb/kb-types.ts";
import { createAliyundocAdapter } from "./kb/kb-aliyundoc.ts";
import { createBailianAdapter } from "./kb/kb-bailian.ts";
import { createDefaultKbRunner, type KbCommandRunner } from "./kb/kb-adapter-shared.ts";
import { createDingtalkAdapter } from "./kb/kb-dingtalk.ts";
import { createLocalRouter } from "./local-router.ts";
import { createObsidianAdapter } from "./kb/kb-obsidian.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：全程使用「甲科技 / 乙股份」等合成名，绝无真实客户数据。
// ---------------------------------------------------------------------------

const MAX_CLI_TIMEOUT_MS = 25_000;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kb-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function writeKbConfig(dir: string, config: unknown): Promise<void> {
  return writeFile(join(dir, "kb.json"), JSON.stringify(config));
}

function hit(overrides: Partial<KbAdapterHit> & Pick<KbAdapterHit, "id" | "key" | "title">): KbAdapterHit {
  return {
    sourceId: "src",
    type: "dingtalk",
    space: "",
    ...overrides,
  };
}

/** Fake adapter with canned hits; never touches a CLI or the network. */
function fakeAdapter(
  type: KbSourceType,
  hits: readonly KbAdapterHit[],
  options: { readonly delayMs?: number; readonly hang?: boolean; readonly fail?: string } = {},
): KbAdapter {
  return {
    type,
    label: type,
    spaces: async () => [{ id: "sp", name: "空间", leaf: true }],
    search: async (_source, _query, k) => {
      if (options.hang) return new Promise(() => undefined);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) throw new Error(options.fail);
      return hits.slice(0, k);
    },
    read: async (_source, id) => ({ title: hits[0]?.title ?? "标题", format: "md", body: `# 正文 ${id}`, url: "" }),
  };
}

function bridgeOptions(dir: string, extra: Partial<KbBridgeOptions> = {}): KbBridgeOptions {
  return { configPath: join(dir, "kb.json"), ...extra };
}

// ---------------------------------------------------------------------------
// 1. 配置 sanitize：坏 id / 越界 products / 重复源被剔除；空配置 → 全禁用
// ---------------------------------------------------------------------------

test("DEFAULT_KB_CONFIG_PATH points at the project-root .local-cache/kb.json", () => {
  // 回归守卫：kb-bridge.ts 位于 dev/kb/，默认路径必须上跳两级到项目根，
  // 指错层级会让真实桥静默全禁用（配置缺失不抛错，只能在这里拦住）。
  assert.match(DEFAULT_KB_CONFIG_PATH, /[\\/]\.local-cache[\\/]kb\.json$/);
  assert.ok(!DEFAULT_KB_CONFIG_PATH.includes(join("dev", ".local-cache")), "must not resolve under dev/");
});

test("sanitize drops bad ids, out-of-range products and duplicate sources; empty config disables all", async () => {
  const { sanitizeKbConfig } = await import("./kb/kb-config.ts");

  // 空配置 / 缺失字段 → sources 空（全禁用），摘要取默认。
  assert.deepEqual(sanitizeKbConfig(undefined), { sources: [], summary: { model: "Auto", topN: 8 } });
  assert.deepEqual(sanitizeKbConfig({}), { sources: [], summary: { model: "Auto", topN: 8 } });
  assert.deepEqual(sanitizeKbConfig("not-an-object"), { sources: [], summary: { model: "Auto", topN: 8 } });

  const sanitized = sanitizeKbConfig({
    sources: [
      // 坏 id：空串 / 超长 / 非法字符 → 整条剔除
      { id: "", type: "aliyundoc", name: "坏 id 空", enabled: true, products: [] },
      { id: "x".repeat(41), type: "aliyundoc", name: "超长 id", enabled: true, products: [] },
      { id: "bad id!", type: "aliyundoc", name: "非法字符", enabled: true, products: [] },
      // 未知 type → 剔除
      { id: "mystery", type: "dropbox", name: "未知类型", enabled: true },
      // aliyundoc：越界 products（..、//、非法字符、超长）逐条剔除；合法的保留
      {
        id: "aliyundoc",
        type: "aliyundoc",
        name: "阿里云官方文档",
        enabled: true,
        site: "cn",
        lang: "zh",
        products: [
          { id: "../etc/passwd", name: "越界" },
          { id: "a//b", name: "双斜杠" },
          { id: `${"x".repeat(161)}`, name: "超长" },
          { id: "ecs", name: "云服务器 ECS" },
          { id: "model-studio", name: "大模型服务平台百炼" },
        ],
      },
      // dingtalk：越界 space id 剔除
      {
        id: "dingtalk",
        type: "dingtalk",
        name: "钉钉知识库",
        enabled: true,
        spaces: [{ id: "ok-space_1", name: "甲科技" }, { id: "bad space", name: "越界" }],
        enterprise: false,
      },
      // 重复 id：第二条剔除
      { id: "aliyundoc", type: "aliyundoc", name: "重复源", enabled: true, products: [] },
      // enabled 非 true 一律停用
      { id: "disabled", type: "aliyundoc", name: "停用", enabled: "yes", products: [] },
    ],
    summary: { model: "Auto", topN: 99 },
  });

  assert.deepEqual(sanitized.sources.map((source) => source.id), ["aliyundoc", "dingtalk", "disabled"]);
  const aliyundoc = sanitized.sources[0]!;
  assert.equal(aliyundoc.enabled, true);
  assert.equal(aliyundoc.type, "aliyundoc");
  assert.deepEqual(
    (aliyundoc as { products: { id: string }[] }).products.map((product) => product.id),
    ["ecs", "model-studio"],
  );
  const dingtalk = sanitized.sources[1] as { spaces: { id: string }[] };
  assert.deepEqual(dingtalk.spaces.map((space) => space.id), ["ok-space_1"]);
  assert.equal(sanitized.sources[2]!.enabled, false, "enabled !== true must stay disabled");
  // topN 越界回到默认 8；合法范围 3-12
  assert.equal(sanitized.summary.topN, 8);
  assert.equal(sanitizeKbConfig({ summary: { topN: 3 } }).summary.topN, 3);
  assert.equal(sanitizeKbConfig({ summary: { topN: 12 } }).summary.topN, 12);
  assert.equal(sanitizeKbConfig({ summary: { topN: 2 } }).summary.topN, 8);
  assert.equal(sanitizeKbConfig({ summary: { model: "Bad\nModel" } }).summary.model, "Auto");
  assert.ok(KB_ID_PATTERN.test("aliyundoc"));
  assert.ok(!KB_ID_PATTERN.test("bad id!"));
});

test("loadKbConfig: missing or corrupt file → all sources disabled, never throws", async () => {
  const { loadKbConfig } = await import("./kb/kb-config.ts");
  await withTempDir(async (dir) => {
    const missing = await loadKbConfig(join(dir, "kb.json"));
    assert.deepEqual(missing.sources, []);
    assert.equal(missing.summary.topN, 8);

    await writeKbConfig(dir, "{ not json");
    const corrupt = await loadKbConfig(join(dir, "kb.json"));
    assert.deepEqual(corrupt.sources, []);

    await writeKbConfig(dir, ["not", "an", "object"]);
    assert.deepEqual((await loadKbConfig(join(dir, "kb.json"))).sources, []);

    await writeKbConfig(dir, {
      sources: [{ id: "aliyundoc", type: "aliyundoc", name: "阿里云官方文档", enabled: true, products: [{ id: "model-studio", name: "百炼" }] }],
    });
    const valid = await loadKbConfig(join(dir, "kb.json"));
    assert.equal(valid.sources.length, 1);
    assert.equal(valid.sources[0]!.id, "aliyundoc");
  });
});

// ---------------------------------------------------------------------------
// 2. RRF 融合序：同文档跨源命中得分累加；单源超时不拖垮其余源
// ---------------------------------------------------------------------------

test("rrf fusion ranks documents hit by both sources above single-source hits (RRF_K=60)", () => {
  assert.equal(RRF_K, 60);
  const fused = rrfFuse(
    [
      {
        sourceId: "src-a",
        hits: [
          hit({ sourceId: "src-a", id: "a-shared", key: "doc:shared", title: "甲科技方案", rank: 1 }),
          hit({ sourceId: "src-a", id: "a-only", key: "doc:a2", title: "甲科技独有", rank: 2 }),
        ],
      },
      {
        sourceId: "src-b",
        hits: [
          hit({ sourceId: "src-b", id: "b-only", key: "doc:b1", title: "乙股份纪要", rank: 1 }),
          hit({ sourceId: "src-b", id: "b-shared", key: "doc:shared", title: "甲科技方案（副本）", rank: 2, snippet: "来自乙股份的片段" }),
        ],
      },
    ],
    { "src-a": 1, "src-b": 1 },
  );

  assert.deepEqual(fused.map((item) => item.key), ["doc:shared", "doc:b1", "doc:a2"]);
  const shared = fused[0]!;
  assert.ok(Math.abs(shared.score - (1 / 61 + 1 / 62)) < 1e-9);
  assert.ok(Math.abs(fused[1]!.score - 1 / 61) < 1e-9);
  assert.ok(Math.abs(fused[2]!.score - 1 / 62) < 1e-9);
  // 同名次下权重生效：权重 2 的源排前
  const weighted = rrfFuse(
    [
      { sourceId: "w1", hits: [hit({ sourceId: "w1", id: "x", key: "k1", title: "x", rank: 1 })] },
      { sourceId: "w2", hits: [hit({ sourceId: "w2", id: "y", key: "k2", title: "y", rank: 1 })] },
    ],
    { w1: 1, w2: 2 },
  );
  assert.deepEqual(weighted.map((item) => item.key), ["k2", "k1"]);
  // 空输入安全
  assert.deepEqual(rrfFuse([], {}), []);
});

test("one hung source times out while the other sources still return (injected timeout clock)", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [
        { id: "src-hang", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [], enterprise: false },
        { id: "src-ok", type: "bailian", name: "乙股份索引", enabled: true, workspaceId: "ws", indices: [] },
      ],
    });
    const bridge = createKbBridge(bridgeOptions(dir, {
      searchTimeoutMs: 30,
      adapters: {
        dingtalk: fakeAdapter("dingtalk", [], { hang: true }),
        bailian: fakeAdapter("bailian", [hit({ sourceId: "src-ok", id: "b1", key: "k1", title: "乙股份切片", rank: 1 })]),
      },
    }));
    const outcome = await bridge.search("全栈 AI");
    assert.equal(outcome.q, "全栈 AI");
    assert.ok(outcome.hits.every((item) => item.sourceId === "src-ok"), "slow source must not poison the rest");
    const hangStatus = outcome.status.find((entry) => entry.sourceId === "src-hang");
    const okStatus = outcome.status.find((entry) => entry.sourceId === "src-ok");
    assert.equal(hangStatus?.ok, false);
    assert.match(hangStatus?.note ?? "", /超时/);
    assert.equal(okStatus?.ok, true);
    assert.equal(okStatus?.n, 1);
  });
});

test("search projects a whitelisted public shape and honours only/k limits", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [
        { id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [{ id: "space101", name: "甲科技" }], enterprise: false },
        { id: "src-b", type: "bailian", name: "乙股份索引", enabled: true, workspaceId: "ws", indices: [{ id: "idx201", name: "乙股份" }] },
        { id: "src-off", type: "aliyundoc", name: "停用源", enabled: false, site: "cn", lang: "zh", products: [] },
      ],
    });
    const dingtalk = fakeAdapter("dingtalk", [
      hit({ sourceId: "src-a", id: "a1", key: "k-a1", title: "甲科技全栈案例", space: "甲科技", snippet: "片段A", rank: 1, url: "https://dingtalk.example/doc/1" }),
      hit({ sourceId: "src-a", id: "a2", key: "k-a2", title: "甲科技第二篇", rank: 2 }),
    ]);
    const bridge = createKbBridge(bridgeOptions(dir, {
      adapters: { dingtalk, bailian: fakeAdapter("bailian", [hit({ sourceId: "src-b", id: "b1", key: "k-b1", title: "乙股份切片", rank: 1 })]) },
    }));

    const outcome = await bridge.search("全栈 AI", ["src-a"], 1);
    assert.equal(outcome.hits.length, 1);
    const keys = Object.keys(outcome.hits[0]!).sort();
    assert.deepEqual(keys, ["id", "path", "rank", "score", "snippet", "sourceId", "sourceName", "space", "title", "type", "url"]);
    assert.equal(outcome.hits[0]!.sourceName, "甲科技知识库");
    assert.equal(outcome.status.length, 1, "only the requested source runs");
    assert.equal(outcome.status[0]!.sourceId, "src-a");

    const both = await bridge.search("全栈 AI");
    assert.equal(both.hits.length, 3);
    assert.equal(both.status.length, 2, "disabled sources never fan out");

    const emptyQuery = await bridge.search("   ");
    assert.deepEqual(emptyQuery.hits, []);
    assert.deepEqual(emptyQuery.status, []);
  });
});

// ---------------------------------------------------------------------------
// 3. 摘要：降级不阻塞检索 + payload 只含标题/路径/摘要片段（哨兵）
// ---------------------------------------------------------------------------

test("summarizer failure degrades to no summary and never blocks search results", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [
        { id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [{ id: "space101", name: "甲科技" }], enterprise: false },
      ],
      summary: { model: "Auto", topN: 8 },
    });
    const adapter = fakeAdapter("dingtalk", [hit({ sourceId: "src-a", id: "a1", key: "k1", title: "甲科技方案", snippet: "全栈 AI 片段", rank: 1 })]);
    const failingRunner: KbCommandRunner = async () => ({ code: 1, stdout: "boom" });
    const bridge = createKbBridge(bridgeOptions(dir, {
      adapters: { dingtalk: adapter },
      run: failingRunner,
      summaryTimeoutMs: 1_000,
    }));

    const before = await bridge.search("全栈 AI");
    assert.equal(before.hits.length, 1);

    await assert.rejects(
      () => bridge.summary("全栈 AI 怎么建？", before.hits),
      (error: unknown) => error instanceof KbBridgeError && error.code === "kb_summary_failed",
    );

    // 摘要失败后再检索：结果原样返回（不阻塞、不丢引用）。
    const after = await bridge.search("全栈 AI");
    assert.deepEqual(after.hits, before.hits);
    assert.equal(after.hits[0]!.title, "甲科技方案");
  });
});

test("summary success path: qodercli JSON parsed, single-flight enforced", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [{ id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [], enterprise: false }],
      summary: { model: "Auto", topN: 8 },
    });
    // release 句柄在测试启动时即绑定到 resolved 前的 deferred：无论胜者何时到达
    // runner（全量并行下 fs 可能很慢），release() 都有效——早前「runner 启动时才
    // 赋值 release」的写法在 spin 上限耗尽后会挂死（F7 评审 P3-1 二次返工教训）。
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: { file: string; args: readonly string[]; stdin?: string; timeoutMs: number }[] = [];
    const runner: KbCommandRunner = async (file, args, options) => {
      calls.push({ file, args, stdin: options.stdin, timeoutMs: options.timeoutMs });
      if (calls.length === 1) {
        await blocked;
      }
      return { code: 0, stdout: JSON.stringify({ result: "按 [1] 的方案落地。", duration_ms: 42, total_credits: 1 }) };
    };
    const bridge = createKbBridge(bridgeOptions(dir, {
      adapters: { dingtalk: fakeAdapter("dingtalk", [hit({ sourceId: "src-a", id: "a1", key: "k1", title: "甲科技方案", snippet: "片段", rank: 1 })]) },
      run: runner,
    }));
    const hitInput = [{ sourceId: "src-a", id: "a1", title: "甲科技方案", space: "甲科技", source: "甲科技知识库", snippet: "片段" }];

    // 交错容忍（评审 P3-1 根因）：闸门置位在 bridge.summary 内部若干 await（配置/来源
    // fs 读取）之后，两次并发调用谁先赢得单飞取决于 IO 交错。语义只保证「恰有一个
    // 在跑、另一个在闸门处被拒」，不保证调用顺序——按此断言，两种交错都成立。
    // handler 必须随创建同步挂上：败者可能在 spin 等待期间就被闸门拒绝，
    // 迟挂 handler 会触发 unhandledRejection（node --test 判失败）。
    const settle = (p: Promise<{ answer: string; ms: number; degraded: boolean }>) =>
      p.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
    const first = settle(bridge.summary("全栈 AI 怎么建？", hitInput));
    const second = settle(bridge.summary("第二个问题", hitInput));
    // 等胜者真实进入 CLI（阻塞在 blocked 上）；不设过短上限——单飞若损坏
    // （两侧都进 CLI），calls.length 会 ≥1 使循环退出并走断言失败，绝不挂死。
    let spins = 0;
    while (calls.length < 1 && spins < 15000) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
      spins += 1;
    }
    assert.ok(calls.length >= 1, "并发期间应有恰一个调用真实进入 CLI（15s 内）");
    release();
    const settled = await Promise.all([first, second]);
    const rejected = settled.filter((r) => !r.ok);
    const fulfilled = settled.filter((r) => r.ok);
    assert.equal(rejected.length, 1, "并发两调用恰有一个被 RUNNING 闸门拒绝");
    assert.equal(fulfilled.length, 1, "恰有一个成功返回");
    const rejection = (rejected[0] as { ok: false; e: unknown }).e;
    assert.ok(rejection instanceof KbBridgeError
      && rejection.code === "kb_summary_failed"
      && /上一个总结/.test(rejection.message),
      "被拒一侧的错误形态：kb_summary_failed + 上一个总结还在生成");
    const done = (fulfilled[0] as { ok: true; v: { answer: string; ms: number; degraded: boolean } }).v;
    assert.equal(done.answer, "按 [1] 的方案落地。");
    assert.equal(done.ms, 42);
    assert.equal(done.degraded, false);
    // 单飞：qodercli 只被调用一次（被拒一侧从未触达 CLI）。
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.file, "qodercli");
    assert.ok(calls[0]!.args.every((arg) => typeof arg === "string"), "CLI args stay an array of strings");
    assert.deepEqual(calls[0]!.args.slice(0, 4), ["-p", "--tools", "", "-o"]);
    assert.ok(calls[0]!.timeoutMs > 0);
    assert.match(calls[0]!.stdin ?? "", /甲科技方案/);
    assert.match(calls[0]!.stdin ?? "", /(全栈 AI 怎么建|第二个问题)/, "胜出调用的查询进入 prompt（不假设先后）");
  });
});

test("summary payload sentinel: extra customer fields are stripped before any CLI call", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [{ id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [], enterprise: false }],
    });
    let capturedStdin = "";
    const runner: KbCommandRunner = async (_file, _args, options) => {
      capturedStdin = options.stdin ?? "";
      return { code: 0, stdout: JSON.stringify({ result: "好的" }) };
    };
    const bridge = createKbBridge(bridgeOptions(dir, {
      adapters: { dingtalk: fakeAdapter("dingtalk", []) },
      run: runner,
    }));
    const adversarial = {
      sourceId: "src-a",
      id: "a1",
      title: "甲科技方案",
      space: "甲科技",
      source: "甲科技知识库",
      snippet: "片段",
      // 越界字段：必须被剥掉，绝不进入摘要提示词
      customerName: "甲科技股份有限公司",
      cid: "c-secret-999",
      contactPhone: "13800000000",
    } as unknown as KbSummaryHit;

    await bridge.summary("总结一下", [adversarial]);
    assert.ok(capturedStdin.includes("甲科技方案"));
    assert.ok(!capturedStdin.includes("c-secret-999"), "cid must never reach the summary payload");
    assert.ok(!capturedStdin.includes("13800000000"), "phone must never reach the summary payload");
    assert.ok(!capturedStdin.includes("customerName"));

    // topN 帽：超过 topN 的命中被截断（默认 8）。
    const many = Array.from({ length: 12 }, (_item, index) => ({
      sourceId: "src-a", id: `a${index}`, title: `甲科技文档${index}`, space: "", source: "甲科技知识库", snippet: "片段",
    }));
    await bridge.summary("批量", many);
    const blocks = capturedStdin.match(/\[\d+\] 《/g) ?? [];
    assert.equal(blocks.length, 8);
  });
});

// ---------------------------------------------------------------------------
// 4. 路由挂载 /local/kb/*（只读）+ 桥安全门复用
// ---------------------------------------------------------------------------

const GOOD_DOC = { title: "百炼文档", format: "md" as const, body: "# 百炼文档\n正文", url: "https://help.aliyun.com/zh/model-studio/doc" };

function fakeKbBridge(overrides: Partial<KbBridge> = {}): KbBridge {
  return {
    config: async () => ({ sources: [], summary: { model: "Auto", topN: 8 } }),
    sources: async () => [
      { id: "aliyundoc", type: "aliyundoc", name: "阿里云官方文档", label: "阿里云官方文档", ok: true, spaces: [{ id: "model-studio", name: "大模型服务平台百炼", leaf: true }] },
    ],
    search: async (query) => ({
      q: query,
      hits: [{
        sourceId: "aliyundoc", sourceName: "阿里云官方文档", type: "aliyundoc", id: "https://help.aliyun.com/zh/model-studio/doc.md",
        title: "百炼概述", space: "大模型服务平台百炼", path: "概述", url: "https://help.aliyun.com/zh/model-studio/doc",
        snippet: "百炼是面向……的平台", rank: 1, score: 0.5,
      }],
      status: [{ sourceId: "aliyundoc", name: "阿里云官方文档", type: "aliyundoc", ok: true, n: 1, ms: 12 }],
    }),
    read: async (sourceId, id) => {
      if (sourceId !== "aliyundoc" || !id) throw new KbBridgeError("source_not_found");
      return GOOD_DOC;
    },
    summary: async () => ({ answer: "可以基于百炼构建。", ms: 12, degraded: false }),
    ...overrides,
  };
}

function kbGet(path: string, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { headers: { host: "127.0.0.1:8000", ...headers } });
}

function kbPost(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:8000", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("router mounts the four read-only /local/kb endpoints", async () => {
  const router = createLocalRouter({ port: 8000, kbBridge: fakeKbBridge() });

  const sources = await router(kbGet("/local/kb/sources"));
  assert.equal(sources.status, 200);
  const sourcesBody = (await sources.json()) as { data: { sources: { id: string }[] } };
  assert.deepEqual(sourcesBody.data.sources.map((source) => source.id), ["aliyundoc"]);

  const search = await router(kbGet("/local/kb/search?q=%E7%99%BE%E7%82%BC"));
  assert.equal(search.status, 200);
  const searchBody = (await search.json()) as { data: { q: string; hits: unknown[]; status: unknown[] } };
  assert.equal(searchBody.data.q, "百炼");
  assert.equal(searchBody.data.hits.length, 1);
  assert.equal(searchBody.data.status.length, 1);

  const onlySearch = await router(kbGet("/local/kb/search?q=x&sources=aliyundoc,bad%20id"));
  assert.equal(onlySearch.status, 200);

  const read = await router(kbGet("/local/kb/read?source=aliyundoc&id=https%3A%2F%2Fhelp.aliyun.com%2Fzh%2Fmodel-studio%2Fdoc.md"));
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { data: { title: string } }).data.title, "百炼文档");

  const summary = await router(kbPost("/local/kb/summary", {
    q: "百炼怎么接入？",
    hits: [{ sourceId: "aliyundoc", id: "doc.md", title: "百炼概述", space: "百炼", source: "阿里云官方文档", snippet: "片段" }],
  }));
  assert.equal(summary.status, 200);
  assert.equal(((await summary.json()) as { data: { answer: string } }).data.answer, "可以基于百炼构建。");
});

test("kb routes validate input and map bridge errors to safe codes", async () => {
  const failing = fakeKbBridge({
    read: async (sourceId) => {
      if (sourceId !== "aliyundoc") throw new KbBridgeError("source_not_found");
      throw new KbBridgeError("kb_read_failed", "网络错误");
    },
    summary: async () => {
      throw new KbBridgeError("kb_summary_failed", "qodercli 无结果");
    },
  });
  const router = createLocalRouter({ port: 8000, kbBridge: failing });

  assert.equal((await router(kbGet("/local/kb/search"))).status, 400, "empty q");
  assert.equal((await router(kbGet(`/local/kb/search?q=${"长".repeat(201)}`))).status, 400, "q over 200 chars");
  assert.equal((await router(kbGet("/local/kb/read?source=aliyundoc"))).status, 400, "missing id");
  assert.equal((await router(kbGet("/local/kb/read?source=unknown&id=x"))).status, 404);

  const readFailed = await router(kbGet("/local/kb/read?source=aliyundoc&id=x"));
  assert.equal(readFailed.status, 502);
  assert.equal(((await readFailed.json()) as { error: string }).error, "kb_read_failed");

  assert.equal((await router(kbPost("/local/kb/summary", { q: "", hits: [] }))).status, 400);
  assert.equal((await router(kbPost("/local/kb/summary", { q: "问" }))).status, 400);
  assert.equal((await router(kbPost("/local/kb/summary", { q: "问", hits: "not-array" }))).status, 400);

  const hugeHits = { q: "问", hits: [{ sourceId: "s", id: "x", title: "t", space: "", source: "s", snippet: "x".repeat(20_000) }] };
  assert.equal((await router(kbPost("/local/kb/summary", hugeHits))).status, 400, "summary body cap");

  const summaryFailed = await router(kbPost("/local/kb/summary", {
    q: "问",
    hits: [{ sourceId: "s", id: "x", title: "t", space: "", source: "s", snippet: "片段" }],
  }));
  assert.equal(summaryFailed.status, 502);
  assert.equal(((await summaryFailed.json()) as { error: string }).error, "kb_summary_failed");

  // 只读端点：不接受写方法。
  assert.equal((await router(kbPost("/local/kb/search", {}))).status, 405);
  assert.equal((await router(new Request("http://127.0.0.1:8000/local/kb/sources", { method: "POST", headers: { host: "127.0.0.1:8000" } }))).status, 405);
  assert.equal((await router(kbPost("/local/kb/read", {}))).status, 405);
});

test("kb routes stay behind the shared host/origin gates and rate limit", async () => {
  let calls = 0;
  const bridge = fakeKbBridge({ search: async (query) => { calls += 1; return { q: query, hits: [], status: [] }; } });
  const router = createLocalRouter({
    port: 8000,
    kbBridge: bridge,
    rateLimit: { maxRequests: 2, windowMs: 60_000 },
  });

  const badHost = await router(kbGet("/local/kb/search?q=x", { host: "attacker.example:8000" }));
  assert.equal(badHost.status, 403);
  const badOrigin = await router(kbGet("/local/kb/search?q=x", { origin: "https://attacker.example" }));
  assert.equal(badOrigin.status, 403);

  assert.equal((await router(kbGet("/local/kb/search?q=甲科技"))).status, 200);
  assert.equal((await router(kbGet("/local/kb/search?q=乙股份"))).status, 200);
  const limited = await router(kbGet("/local/kb/search?q=丙集团"));
  assert.equal(limited.status, 429);
  assert.equal(calls, 2, "rate-limited request never reaches the bridge");
});

// ---------------------------------------------------------------------------
// 5. 桥安全基线：CLI 数组传参 + 25s 超时；绝对路径不出桥
// ---------------------------------------------------------------------------

test("dingtalk adapter calls dws with array args and a bounded timeout", async () => {
  const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
  const runner: KbCommandRunner = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    return {
      code: 0,
      stdout: JSON.stringify({ data: { nodes: [{ nodeId: "node123", name: "甲科技接入方案", nodeType: "doc", url: "https://dingtalk.example/x" }] } }),
    };
  };
  const adapter = createDingtalkAdapter({ run: runner });
  const source = {
    id: "dingtalk", type: "dingtalk" as const, name: "钉钉知识库", enabled: true,
    spaces: [{ id: "space101", name: "甲科技" }], enterprise: false,
  };
  const hits = await adapter.search(source, "全栈 AI 案例", 10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "dws");
  assert.deepEqual(calls[0]!.args, ["wiki", "+node-search", "--workspace", "space101", "--query", "全栈 AI 案例", "--limit", "10", "-f", "json"]);
  assert.ok(calls[0]!.timeoutMs <= MAX_CLI_TIMEOUT_MS, `dws timeout must be <= 25s, got ${calls[0]!.timeoutMs}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, "甲科技接入方案");
  assert.equal(hits[0]!.key, "dt:node123");
  assert.equal(hits[0]!.rank, 1);

  await assert.rejects(() => adapter.read(source, "bad node id"), /非法节点 ID/);
  const missing = createDingtalkAdapter({ run: async () => ({ code: "ENOENT", stdout: "" }) });
  await assert.rejects(() => missing.search(source, "q", 5), /未找到 DWS CLI/);
});

test("bailian adapter calls aliyun CLI with array args and keeps chunk reads in memory", async () => {
  const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
  const runner: KbCommandRunner = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    if (args[1] === "retrieve") {
      return {
        code: 0,
        stdout: JSON.stringify({ Data: { Nodes: [{ Text: "乙股份全栈 AI 切片正文", Score: 0.92, Metadata: { doc_name: "乙股份方案说明" } }] } }),
      };
    }
    return { code: 0, stdout: "{}" };
  };
  const adapter = createBailianAdapter({ run: runner });
  const source = {
    id: "bailian", type: "bailian" as const, name: "百炼知识库", enabled: true,
    profile: "", region: "", workspaceId: "ws1", indices: [{ id: "idx201", name: "乙股份" }],
  };
  const hits = await adapter.search(source, "乙股份 全栈", 10);
  assert.equal(calls[0]!.file, "aliyun");
  assert.deepEqual(calls[0]!.args.slice(0, 8), ["bailian", "retrieve", "--workspace-id", "ws1", "--index-id", "idx201", "--query", "乙股份 全栈"]);
  assert.ok(calls[0]!.timeoutMs <= MAX_CLI_TIMEOUT_MS);
  assert.equal(hits[0]!.title, "乙股份方案说明");
  assert.match(hits[0]!.snippet ?? "", /乙股份全栈 AI 切片正文/);
  assert.match(hits[0]!.key, /^bl:idx201:[0-9a-f]{16}$/);

  const doc = await adapter.read(source, hits[0]!.id);
  assert.match(doc.body, /乙股份全栈 AI 切片正文/);
  await assert.rejects(() => adapter.read(source, "idx201:deadbeefdeadbeef"), /切片已过期/);
});

test("obsidian adapter keeps everything inside the vault and never exposes absolute paths", async () => {
  await withTempDir(async (dir) => {
    const vault = join(dir, "vault");
    await mkdir(join(vault, "方案"), { recursive: true });
    await writeFile(join(vault, "方案", "甲科技方案.md"), "# 甲科技方案\n\n全栈 AI 能力落地案例。");
    await writeFile(join(vault, "乙股份纪要.md"), "---\ntags: [纪要]\n---\n\n乙股份复盘。");
    const adapter = createObsidianAdapter({ now: () => Date.now() });
    const source = { id: "obs-1", type: "obsidian" as const, name: "本地笔记", enabled: true, vault, dirs: [] };

    const hits = await adapter.search(source, "甲科技", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, "甲科技方案");
    assert.equal(hits[0]!.key, `obs:方案/甲科技方案.md`);
    assert.ok(!JSON.stringify(hits).includes(dir), "vault absolute path must never leak");

    const doc = await adapter.read(source, "方案/甲科技方案.md");
    assert.match(doc.body, /全栈 AI 能力落地案例/);
    await assert.rejects(() => adapter.read(source, "../outside/secret.md"), /非法路径/);
    await assert.rejects(() => adapter.read(source, "方案/missing.md"), /非法路径/);

    const spaces = await adapter.spaces(source);
    assert.deepEqual(spaces.map((space) => space.id).sort(), ["", "方案"]);
    assert.equal(spaces.find((space) => space.id === "方案")!.count, 1);
    assert.equal(spaces.find((space) => space.id === "")!.count, 1);

    const missingVault = { ...source, vault: join(dir, "nope") };
    await assert.rejects(() => adapter.spaces(missingVault), /vault 路径不存在/);
  });
});

test("bridge sources() reports failures per source without leaking paths", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [
        { id: "obs-1", type: "obsidian", name: "本地笔记", enabled: true, vault: join(dir, "missing-vault"), dirs: [] },
        { id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [{ id: "space101", name: "甲科技" }], enterprise: false },
      ],
    });
    const runner: KbCommandRunner = async () => ({ code: "ENOENT", stdout: "" });
    const bridge = createKbBridge(bridgeOptions(dir, {
      run: runner,
      searchTimeoutMs: 200,
    }));
    const sources = await bridge.sources();
    assert.equal(sources.length, 2);
    const obsidian = sources.find((source) => source.id === "obs-1")!;
    assert.equal(obsidian.ok, false);
    assert.match(obsidian.note ?? "", /vault 路径不存在/);
    // dws 的 spaces 直接来自配置（不调 CLI）：映射 id/name，leaf=false。
    const dingtalk = sources.find((source) => source.id === "src-a")!;
    assert.equal(dingtalk.ok, true);
    assert.deepEqual(dingtalk.spaces, [{ id: "space101", name: "甲科技", leaf: false }]);
    assert.ok(!JSON.stringify(sources).includes(dir), "no absolute path in sources view");
  });
});

test("read maps unknown sources to 404 and forwards validated ids to the adapter", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [{ id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [], enterprise: false }],
    });
    const adapter = fakeAdapter("dingtalk", [hit({ sourceId: "src-a", id: "a1", key: "k1", title: "甲科技方案", rank: 1 })]);
    const bridge = createKbBridge(bridgeOptions(dir, { adapters: { dingtalk: adapter } }));

    const doc = await bridge.read("src-a", "a1");
    assert.equal(doc.title, "甲科技方案");
    await assert.rejects(
      () => bridge.read("src-unknown", "a1"),
      (error: unknown) => error instanceof KbBridgeError && error.code === "source_not_found",
    );
  });
});

test("default runner uses execFile semantics (never a shell)", async () => {
  const runner = createDefaultKbRunner();
  const result = await runner("node", ["-e", "console.log(JSON.stringify({ok:1}))"], { timeoutMs: 5_000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /"ok":1/);
  const missing = await runner("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5_000 });
  assert.equal(missing.code, "ENOENT");
});

// ---------------------------------------------------------------------------
// 6. 回归保险：外部范围与本地检索互不混排由 AskView 状态隔离保证（人工验收）；
//    此处固化桥契约：search 结果不含任何本地索引字段。
// ---------------------------------------------------------------------------

test("search hits never carry local-index-only fields", async () => {
  await withTempDir(async (dir) => {
    await writeKbConfig(dir, {
      sources: [{ id: "src-a", type: "dingtalk", name: "甲科技知识库", enabled: true, spaces: [], enterprise: false }],
    });
    const bridge = createKbBridge(bridgeOptions(dir, {
      adapters: { dingtalk: fakeAdapter("dingtalk", [hit({ sourceId: "src-a", id: "a1", key: "k1", title: "甲科技方案", rank: 1 })]) },
    }));
    const outcome = await bridge.search("甲科技");
    const raw = JSON.stringify(outcome);
    for (const forbidden of ["documentId", "relativePath", "keywordScore", "vectorScore", "sourceLabel", "retrievalMode"]) {
      assert.ok(!raw.includes(forbidden), `external hits must not carry local retrieval field ${forbidden}`);
    }
  });
});
