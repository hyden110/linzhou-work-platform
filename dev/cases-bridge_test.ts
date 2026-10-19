import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  caseKey,
  createCasesBridge,
  DEFAULT_CASES_CONFIG_PATH,
  fileTitle,
  mergeRawCases,
  sanitizeCasesConfig,
  type CasesBridge,
  type CasesSnapshot,
} from "./cases-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import type { CasesCommandRunner } from "./cases/cases-cli.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：全程使用「甲科技 / 乙股份」等合成仓名 / 桶名 / 客户名，
// 绝不出现真实仓库、真实桶、真实客户。
// ---------------------------------------------------------------------------

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cases-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function writeCasesConfig(dir: string, config: unknown): Promise<void> {
  return writeFile(join(dir, "cases.json"), JSON.stringify(config), "utf-8");
}

interface CliReply {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

function fakeRunner(handler: (file: string, args: readonly string[]) => CliReply): CasesCommandRunner {
  return async (file, args) => {
    const reply = handler(file, args);
    return { code: reply?.code ?? 0, stdout: reply?.stdout ?? "", stderr: reply?.stderr ?? "" };
  };
}

const missingCli: CasesCommandRunner = async () => ({ code: "ENOENT", stdout: "", stderr: "" });

/** a1 桩：文件清单 / pages view / repo list 按仓分发；未覆盖的调用一律 ENOENT。 */
function fakeA1(repos: Record<string, { files: string[]; pages?: unknown }>, activity: unknown): CasesCommandRunner {
  return fakeRunner((file, args) => {
    if (file !== "a1") return { code: "ENOENT" };
    if (args.includes("file") && args.includes("list")) {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      const spec = repos[repo];
      if (!spec) return { code: 1, stderr: "no such repo" };
      return { stdout: JSON.stringify(spec.files.map((path) => ({ type: "blob", path }))) };
    }
    if (args.includes("pages")) {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      return { stdout: JSON.stringify(repos[repo]?.pages ?? {}) };
    }
    if (args.includes("--per-page")) return { stdout: JSON.stringify(activity) };
    return { code: "ENOENT" };
  });
}

function ossLs(lines: readonly string[]): CasesCommandRunner {
  return fakeRunner((file, args) => {
    if (file !== "ossutil" || !args.includes("ls")) return { code: "ENOENT" };
    return { stdout: lines.join("\n") + "\n" };
  });
}

const TRUSTED = { host: "127.0.0.1:8000" };

function get(path: string): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method: "GET", headers: TRUSTED });
}

// ---------------------------------------------------------------------------
// 1. 默认路径与配置降级
// ---------------------------------------------------------------------------

test("DEFAULT_CASES_CONFIG_PATH points at the project-root .local-cache/cases.json", () => {
  // 回归守卫：cases-bridge.ts 位于 dev/cases/，默认路径必须上跳两级到项目根。
  assert.match(DEFAULT_CASES_CONFIG_PATH, /[\\/]\.local-cache[\\/]cases\.json$/);
  assert.ok(!DEFAULT_CASES_CONFIG_PATH.includes(join("dev", ".local-cache")), "must not resolve under dev/");
});

test("missing or corrupt config answers configured:false with empty cases and never throws", async () => {
  await withTempDir(async (dir) => {
    const bridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: missingCli });
    const missing = await bridge.snapshot();
    assert.equal(missing.configured, false);
    assert.deepEqual(missing.cases, []);
    assert.equal(missing.channels.code.state, "unconfigured");
    assert.equal(missing.channels.oss.state, "unconfigured");
    assert.match(missing.channels.code.note, /cases\.json/);
    assert.match(missing.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

    await writeCasesConfig(dir, "{ 不是 JSON");
    const corrupt = await bridge.snapshot();
    assert.equal(corrupt.configured, false);
    assert.deepEqual(corrupt.cases, []);
    assert.equal(corrupt.channels.oss.state, "unconfigured");
  });
});

test("sanitize drops bad repo entries, bad bucket, bad publicBase and bad alias entries", async () => {
  const config = sanitizeCasesConfig({
    code: {
      repos: [
        { repo: "../escape" },
        { repo: "" },
        { repo: 42 },
        { repo: "合成组/a//b" },
        { repo: "合成组/正常仓", mode: "collection", publishDir: "/deeper/../x", exclude: [42, "ok*", ""] },
        { repo: "合成组/正常仓" },
      ],
      exclude: [42, "shared*"],
    },
    oss: { bucket: "BAD BUCKET", publicBase: "javascript:alert(1)" },
    aliases: { "Bad Key!": "x", goodkey: "target key!" },
    custAliases: { goodkey: "<script>" },
  });
  assert.deepEqual(config.repos.map((spec) => spec.repo), ["合成组/正常仓"], "只留合法仓库，重复仓去重");
  assert.equal(config.repos[0]!.mode, "collection");
  assert.equal(config.repos[0]!.publishDir, "", "越界 publishDir 清空");
  assert.deepEqual(config.repos[0]!.exclude, ["ok*"]);
  assert.deepEqual(config.codeExclude, ["shared*"]);
  assert.equal(config.oss, null, "坏桶名整渠道剔除");
  assert.deepEqual(config.aliases, {});
  assert.deepEqual(config.custAliases, {});
});

test("valid config without any channel stays configured:false with honest notes", async () => {
  await withTempDir(async (dir) => {
    await writeCasesConfig(dir, { code: { repos: [] }, oss: {} });
    const bridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: missingCli });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.configured, false);
    assert.match(snapshot.channels.code.note, /code\.repos/);
    assert.match(snapshot.channels.oss.note, /oss\.bucket/);
  });
});

// ---------------------------------------------------------------------------
// 2. Code 平台渠道（a1）
// ---------------------------------------------------------------------------

const CODE_REPOS = {
  "合成组/甲科技交付集": {
    files: [
      "public/index.html",
      "public/甲科技-门店AI/index.html",
      "public/甲科技-门店AI/门店大屏.html",
      "public/乙股份-供应链/index.html",
      "public/assets/theme.css",
      "public/_drafts/草稿.html",
      "public/视频巡检/index.html",
    ],
    pages: { url: "https://pages.example.internal/delivery" },
  },
  "合成组/乙股份单页": {
    files: ["deck.html"],
    pages: {},
  },
};

const ACTIVITY = [
  { pathWithNamespace: "合成组/甲科技交付集", lastActivityAt: "2026-09-30T10:00:00+08:00" },
  { pathWithNamespace: "合成组/乙股份单页", lastActivityAt: "2026-10-18T08:00:00+08:00" },
];

test("code channel groups collection/site repos, applies excludes and picks entry links", async () => {
  await withTempDir(async (dir) => {
    await writeCasesConfig(dir, {
      code: {
        repos: [
          { repo: "合成组/甲科技交付集", mode: "collection" },
          { repo: "合成组/乙股份单页", mode: "site" },
        ],
        exclude: ["视频*"],
      },
    });
    const bridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: fakeA1(CODE_REPOS, ACTIVITY) });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.cases.length, 3, "collection 2 个案例 + site 1 个案例");

    const names = snapshot.cases.map((entry) => entry.name);
    assert.ok(names.includes("甲科技-门店AI"));
    assert.ok(names.includes("乙股份-供应链"));
    assert.ok(names.includes("乙股份单页"), "site 模式整仓一个案例，名取仓库名");
    assert.ok(!names.some((name) => name.includes("草稿") || name.includes("视频")), "内置与配置 exclude 生效");

    const store = snapshot.cases.find((entry) => entry.name === "甲科技-门店AI")!;
    assert.equal(store.updatedAt, "2026-09-30T10:00:00+08:00", "最近发布取仓库最近活跃");
    assert.equal(store.pageCount, 2);
    assert.equal(store.srcs.join(","), "code");
    const entry = new URL(store.entryUrl);
    assert.equal(entry.origin, "https://pages.example.internal");
    assert.match(decodeURIComponent(entry.pathname), /甲科技-门店AI\/index\.html$/, "入口取最浅 index.html");

    const single = snapshot.cases.find((entry2) => entry2.name === "乙股份单页")!;
    assert.equal(single.updatedAt, "2026-10-18T08:00:00+08:00");
    assert.equal(single.entryUrl, "https://code.alibaba-inc.com/合成组/乙股份单页", "未开通 Pages 回落仓库链接");
    assert.match(snapshot.channels.code.note, /乙股份单页 未开通 Aone Pages/);
    assert.equal(snapshot.channels.code.state, "ok");
    assert.equal(snapshot.channels.code.count, 3);
    assert.equal(snapshot.channels.oss.state, "unconfigured");
  });
});

test("missing a1 CLI reports an honest channel error and yields no fabricated cases", async () => {
  await withTempDir(async (dir) => {
    await writeCasesConfig(dir, { code: { repos: [{ repo: "合成组/甲科技交付集" }] } });
    const bridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: missingCli });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.configured, true, "配置存在即为已配置");
    assert.deepEqual(snapshot.cases, [], "渠道失败 → 案例空，绝不造数据");
    assert.equal(snapshot.channels.code.state, "error");
    assert.match(snapshot.channels.code.note, /a1 CLI 不可用/);
  });
});

// ---------------------------------------------------------------------------
// 3. OSS 渠道（ossutil）
// ---------------------------------------------------------------------------

const OSS_LINES = [
  "2026-10-11 09:30:00 +0800 CST    12345   Standard   A1B2C3D4E5F6   oss://deck-bucket.example/甲科技-门店AI/index.html",
  "2026-10-12 10:00:00 +0800 CST      789   Standard   A1B2C3D4E5F7   oss://deck-bucket.example/甲科技-门店AI/门店大屏.html",
  "2026-10-01 08:00:00 +0800 CST      555   Standard   A1B2C3D4E5F8   oss://deck-bucket.example/乙股份-供应链/index.html",
  "2026-10-05 08:00:00 +0800 CST      100   Standard   A1B2C3D4E5F9   oss://deck-bucket.example/video-scratch/index.html",
  "2026-10-05 08:00:00 +0800 CST      100   Standard   A1B2C3D4E5FA   oss://deck-bucket.example/index.html",
];

test("oss channel parses ossutil ls output into cases with public entry urls", async () => {
  await withTempDir(async (dir) => {
    await writeCasesConfig(dir, {
      oss: { bucket: "deck-bucket.example", publicBase: "https://deck.example.com/", exclude: ["video*"] },
    });
    const bridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: ossLs(OSS_LINES) });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.cases.length, 2, "根 index 是导航不是案例；video* 被配置 exclude 剔除");

    const store = snapshot.cases.find((entry) => entry.name === "甲科技-门店AI")!;
    assert.equal(store.updatedAt, "2026-10-12T10:00:00+08:00", "最近发布取目录内最新文件 mtime");
    assert.equal(store.pageCount, 2);
    const entry = new URL(store.entryUrl);
    assert.equal(`${entry.origin}${entry.pathname}`.startsWith("https://deck.example.com/"), true);
    assert.match(decodeURIComponent(entry.pathname), /甲科技-门店AI\/index\.html$/);
    assert.equal(snapshot.channels.oss.state, "ok");
    assert.equal(snapshot.channels.oss.count, 2);
    assert.equal(snapshot.channels.code.state, "unconfigured");
  });
});

test("failing oss channel keeps code cases and surfaces the last error verbatim", async () => {
  await withTempDir(async (dir) => {
    await writeCasesConfig(dir, {
      code: { repos: [{ repo: "合成组/甲科技交付集", mode: "collection" }], exclude: ["视频*"] },
      oss: { bucket: "deck-bucket.example" },
    });
    const bridge = createCasesBridge({
      configPath: join(dir, "cases.json"),
      run: async (file, args) => (file === "a1" ? fakeA1(CODE_REPOS, ACTIVITY)(file, args) : { code: "ENOENT" }),
    });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.cases.length, 2, "code 渠道不受 oss 失败影响");
    assert.equal(snapshot.channels.oss.state, "error");
    assert.match(snapshot.channels.oss.note, /ossutil CLI 不可用/);
    assert.equal(snapshot.channels.code.state, "ok");
  });
});

// ---------------------------------------------------------------------------
// 4. 跨源合并：别名归一 + 客户别名
// ---------------------------------------------------------------------------

test("caseKey normalizes names and mergeRawCases folds channels via aliases", () => {
  assert.equal(caseKey("甲-科技_零售"), "甲科技零售");
  assert.equal(caseKey("Jia Keji.HTML"), "jiakeji");
  assert.equal(fileTitle("甲科技/门店大屏.html"), "门店大屏");
  assert.equal(fileTitle("甲科技/index.html"), "");

  const raws = [
    { key: "甲科技零售", name: "甲科技零售", title: "甲科技零售", updatedAt: "", url: "https://code.example.internal/x", src: "code" as const, pageCount: 1 },
    { key: "甲科技零售方案", name: "甲科技零售方案", title: "", updatedAt: "2026-10-12T10:00:00+08:00", url: "https://deck.example.com/jia/index.html", src: "oss" as const, pageCount: 2 },
  ];
  const merged = mergeRawCases(raws, { "甲科技零售": "甲科技零售方案" }, { "甲科技零售方案": "甲科技" });
  assert.equal(merged.length, 1, "aliases 并键后跨源合并为一个案例");
  const only = merged[0]!;
  assert.deepEqual(only.srcs, ["oss", "code"], "srcs 按渠道优先级去重");
  assert.equal(only.cust, "甲科技");
  assert.equal(only.updatedAt, "2026-10-12T10:00:00+08:00", "取各源最新");
  assert.equal(only.pageCount, 2);
  assert.equal(only.entryUrl, "https://deck.example.com/jia/index.html", "入口按 oss 优先");
  assert.match(only.id, /^c[0-9a-f]{10}$/);
});

test("alias config merges the same deck published on both channels into one case", async () => {
  await withTempDir(async (dir) => {
    await writeCasesConfig(dir, {
      code: { repos: [{ repo: "合成组/丙交付", mode: "collection" }] },
      oss: { bucket: "deck-bucket.example" },
      aliases: { "甲科技零售": "甲科技零售方案" },
      custAliases: { "甲科技零售方案": "甲科技" },
    });
    const runner: CasesCommandRunner = async (file, args) => {
      if (file === "a1") {
        return fakeA1({ "合成组/丙交付": { files: ["public/甲科技零售方案/index.html"], pages: { url: "https://pages.example.internal/bing" } } }, [])(file, args);
      }
      return ossLs(["2026-10-12 10:00:00 +0800 CST      789   Standard   A1B2C3D4E5F7   oss://deck-bucket.example/甲科技零售/index.html"])(file, args);
    };
    const bridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: runner });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.cases.length, 1, "两渠道同键案例合并");
    const only = snapshot.cases[0]!;
    assert.deepEqual(only.srcs, ["oss", "code"]);
    assert.equal(only.cust, "甲科技", "custAliases 提供客户别名");
    assert.ok(
      only.entryUrl.startsWith("https://deck-bucket.example.oss-cn-beijing.aliyuncs.com/"),
      "入口按 oss 渠道优先（该渠道 publicBase 缺省回落桶域名）",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 路由端点（/local/cases，只读）
// ---------------------------------------------------------------------------

test("router serves GET /local/cases read-only and maps bridge failure to 502", async () => {
  await withTempDir(async (dir) => {
    const bridge: CasesBridge = createCasesBridge({ configPath: join(dir, "cases.json"), run: missingCli });
    const router = createLocalRouter({ port: 8000, casesBridge: bridge });
    const response = await router(get("/local/cases"));
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; data: CasesSnapshot };
    assert.equal(body.ok, true);
    assert.equal(body.data.configured, false);
    assert.deepEqual(body.data.cases, []);

    const rejected = await router(new Request("http://127.0.0.1:8000/local/cases", { method: "POST", headers: TRUSTED }));
    assert.equal(rejected.status, 405, "只读端点拒绝写方法");

    const failingRouter = createLocalRouter({
      port: 8000,
      casesBridge: { snapshot: async () => { throw new Error("boom"); } },
    });
    const failed = await failingRouter(get("/local/cases"));
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as { error: string }).error, "cases_unavailable");
  });
});
