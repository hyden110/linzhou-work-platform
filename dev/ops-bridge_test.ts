import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandRunner } from "./crm-bridge.ts";
import { createCrmBridge } from "./crm-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import { createOpsBridge, type OpsItem } from "./ops-bridge.ts";

const NOW = new Date("2026-10-16T12:00:00").getTime();

async function withCache(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ops-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for the refresh to finish");
}

async function writeOpsDigest(dir: string, items: unknown[], sources: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(dir, "ops-digest.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-10-16T04:00:00Z",
    readOnly: true,
    sources: {
      blog: { status: "ok", error: null, fetchedAt: "2026-10-16T04:00:00Z", lastSuccessAt: "2026-10-16T04:00:00Z", count: 1, complete: true, stale: false },
      ...sources,
    },
    cursors: { qianzaiSince: "2026-10-16 12:00:00" },
    items,
    secretToken: "should-not-leak",
  }));
}

function item(overrides: Partial<OpsItem> & Pick<OpsItem, "id" | "title" | "sourceType">): OpsItem & Record<string, unknown> {
  return {
    source: "示例来源",
    url: null,
    publishedAt: "2026-10-16T09:30:00",
    summary: null,
    kind: null,
    ...overrides,
  };
}

test("digest is projected to known fields only", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [
      item({ id: "blog:a", sourceType: "blog", title: "博客 A", evilExtra: "drop me" }),
      { title: "缺 id 的条目必须被丢弃", sourceType: "blog" },
      item({ id: "changelog:x", sourceType: "changelog", title: "更新 X", publishedAt: null }),
    ]);
    const bridge = createOpsBridge({ cacheDir: dir });
    const digest = await bridge.digest();
    assert.ok(digest);
    assert.equal(digest.items.length, 2);
    assert.equal((digest.items[0] as Record<string, unknown>).evilExtra, undefined);
    assert.equal((digest as Record<string, unknown>).secretToken, undefined);
    assert.equal(digest.sources.blog?.status, "ok");
    assert.equal(digest.sources.announcement?.status, "missing");
    assert.equal((await createOpsBridge({ cacheDir: join(dir, "empty") }).digest()), undefined);
  });
});

test("refresh runs once at a time and reports failure codes only", async () => {
  await withCache(async (dir) => {
    let release: (value: { code: number | null; stdout: string }) => void = () => {};
    const calls: string[] = [];
    const runner: CommandRunner = (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      return new Promise((resolve) => { release = resolve; });
    };
    const bridge = createOpsBridge({ cacheDir: dir, run: runner, now: () => NOW });
    assert.equal(bridge.startRefresh().state, "running");
    assert.equal(bridge.startRefresh().state, "running");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.endsWith("sync/ops_digest.py"));
    release({ code: 1, stdout: "token=secret" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      { state: bridge.refreshStatus().state, error: bridge.refreshStatus().error },
      { state: "failed", error: "digest_failed" },
    );
  });
});

test("card groups today deterministically and dedupes url and title", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [
      item({ id: "blog:a", sourceType: "blog", title: "博客 A", url: "https://qoder.com/zh/blog/a/" }),
      // Same URL with a trailing-slash/protocol variant from another source → deduped.
      item({ id: "changelog:dupe", sourceType: "changelog", title: "重复 URL", url: "http://qoder.com/zh/blog/a" }),
      // Same normalised title without URL → deduped.
      item({ id: "qianzai:dupe", sourceType: "qianzai", title: "博客 A！" }),
      item({ id: "qianzai:keep", sourceType: "qianzai", title: "千仔推送", publishedAt: "2026-10-16T10:00:00" }),
      item({ id: "blog:old", sourceType: "blog", title: "昨天的博客", publishedAt: "2026-10-15T09:00:00" }),
      item({ id: "changelog:nodate", sourceType: "changelog", title: "无日期不进当日卡", publishedAt: null }),
    ]);
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {} });
    const card = await bridge.card();
    assert.ok(card);
    assert.equal(card.date, "2026-10-16");
    assert.equal(card.dedupedFrom, 4);
    assert.equal(card.total, 2);
    assert.deepEqual(card.groups.map((group) => group.label), ["活动", "更新", "公告", "千仔讯息"]);
    assert.equal(card.groups[0]!.count, 1);
    assert.equal(card.groups[1]!.count, 0);
    assert.equal(card.groups[3]!.count, 1);
    assert.equal(card.overview.kind, "template");
    assert.match(card.overview.text, /今日共 2 条运营讯息/);
    assert.match(card.overview.note, /模板汇总/);
  });
});

test("empty card stays honest instead of fabricating entries", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:old", sourceType: "blog", title: "昨天的博客", publishedAt: "2026-10-15T09:00:00" })]);
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {} });
    const card = await bridge.card();
    assert.ok(card);
    assert.equal(card.total, 0);
    assert.equal(card.overview.text, "今日暂无新增运营讯息。");
  });
});

test("refresh computes the ai overview once; card reads it without calling out", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:a", sourceType: "blog", title: "博客 A" })]);

    const seen: { url: string; auth: string }[] = [];
    const fetchOk: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: String((init?.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "一句话 AI 摘要。" } }] }), { status: 200 });
    };
    const runner: CommandRunner = () => Promise.resolve({ code: 0, stdout: "" });
    const withKey = createOpsBridge({
      cacheDir: dir, run: runner, now: () => NOW, fetchImpl: fetchOk,
      env: { DASHSCOPE_API_KEY: "sk-test" },
    });
    withKey.startRefresh();
    await waitFor(() => withKey.refreshStatus().state !== "running");
    assert.equal(withKey.refreshStatus().state, "succeeded");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.auth, "Bearer sk-test");
    assert.ok(seen[0]!.url.includes("dashscope.aliyuncs.com"));

    const card = await withKey.card();
    assert.ok(card);
    assert.equal(card.overview.kind, "ai");
    assert.equal(card.overview.text, "一句话 AI 摘要。");
    assert.match(card.overview.note, /AI 摘要/);
    // 重复 GET 只读产物，不再外呼 AI。
    const cardAgain = await withKey.card();
    assert.equal(cardAgain.overview.kind, "ai");
    assert.equal(seen.length, 1);
  });
});

test("refresh falls back to the template overview when the ai call fails", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:a", sourceType: "blog", title: "博客 A" })]);
    const runner: CommandRunner = () => Promise.resolve({ code: 0, stdout: "" });
    const bridge = createOpsBridge({
      cacheDir: dir, run: runner, now: () => NOW,
      fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch,
      env: { DASHSCOPE_API_KEY: "sk-test" },
    });
    bridge.startRefresh();
    await waitFor(() => bridge.refreshStatus().state !== "running");
    const card = await bridge.card();
    assert.ok(card);
    assert.equal(card.overview.kind, "template");
    assert.match(card.overview.note, /AI 摘要失败，已回退模板汇总/);
  });
});

test("card never calls out even with a dashscope key and today's items", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:a", sourceType: "blog", title: "博客 A" })]);
    let calls = 0;
    const bridge = createOpsBridge({
      cacheDir: dir, now: () => NOW,
      fetchImpl: (async () => { calls += 1; return new Response("{}"); }) as typeof fetch,
      env: { DASHSCOPE_API_KEY: "sk-test" },
    });
    const card = await bridge.card();
    assert.ok(card);
    assert.equal(card.total, 1);
    assert.equal(calls, 0, "GET /local/ops/card must not make external calls");
    assert.equal(card.overview.kind, "template");
  });
});

test("wechat links are registered, fetched when whitelisted and persisted", async () => {
  await withCache(async (dir) => {
    const bridge = createOpsBridge({
      cacheDir: dir, now: () => NOW, env: {},
      fetchImpl: (async () => new Response("<html><title>Qoder Blog</title></html>", { status: 200 })) as typeof fetch,
    });

    const wechat = await bridge.registerWechatLink("https://mp.weixin.qq.com/s/example123");
    assert.ok(wechat.ok);
    assert.equal(wechat.link.status, "registered");
    assert.match(wechat.link.note, /不在自动抓取白名单/);

    const whitelisted = await bridge.registerWechatLink("https://qoder.com/zh/blog");
    assert.ok(whitelisted.ok);
    assert.equal(whitelisted.link.status, "fetched");
    assert.equal(whitelisted.link.title, "Qoder Blog");

    assert.deepEqual(await bridge.registerWechatLink("notaurl"), { ok: false, error: "invalid_url" });
    assert.deepEqual(await bridge.registerWechatLink("ftp://qoder.com/x"), { ok: false, error: "invalid_url" });

    const links = await bridge.wechatLinks();
    assert.equal(links.length, 2);
    assert.equal((await stat(join(dir, "ops-wechat-links.json"))).mode & 0o777, 0o600);

    const reloaded = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {} });
    assert.equal((await reloaded.wechatLinks()).length, 2);
  });
});

test("wechat fetch rejects a whitelisted url that redirects to a foreign host", async () => {
  await withCache(async (dir) => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://evil.example/landing" } });
    }) as typeof fetch;
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {}, fetchImpl });
    const result = await bridge.registerWechatLink("https://qoder.com/zh/blog");
    assert.ok(result.ok);
    assert.equal(result.link.status, "fetch_failed");
    assert.match(result.link.note, /重定向到非白名单域名/);
    // 逐跳复验：对非白名单目标的后续请求根本不会发出。
    assert.deepEqual(urls, ["https://qoder.com/zh/blog"]);
  });
});

test("wechat fetch follows whitelisted redirect hops and reads the landing title", async () => {
  await withCache(async (dir) => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://qoder.com/zh/blog") {
        return new Response(null, { status: 302, headers: { location: "https://help.aliyun.com/zh/landing" } });
      }
      return new Response("<html><title>落地页标题</title></html>", { status: 200 });
    }) as typeof fetch;
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {}, fetchImpl });
    const result = await bridge.registerWechatLink("https://qoder.com/zh/blog");
    assert.ok(result.ok);
    assert.equal(result.link.status, "fetched");
    assert.equal(result.link.title, "落地页标题");
    assert.deepEqual(urls, ["https://qoder.com/zh/blog", "https://help.aliyun.com/zh/landing"]);
  });
});

test("wechat fetch stops at the five-hop redirect cap", async () => {
  await withCache(async (dir) => {
    let hops = 0;
    const fetchImpl = (async () => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: "https://qoder.com/zh/loop" } });
    }) as typeof fetch;
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {}, fetchImpl });
    const result = await bridge.registerWechatLink("https://qoder.com/zh/blog");
    assert.ok(result.ok);
    assert.equal(result.link.status, "fetch_failed");
    assert.match(result.link.note, /跳上限/);
    assert.equal(hops, 6); // 首发 1 次 + 最多跟随 5 跳
  });
});

test("router exposes ops routes with origin and body guards", async () => {
  await withCache(async (dir) => {
    let refreshCalls = 0;
    const runner: CommandRunner = () => {
      refreshCalls += 1;
      return Promise.resolve({ code: 0, stdout: "" });
    };
    const opsBridge = createOpsBridge({
      cacheDir: dir, run: runner, now: () => NOW, env: {},
      fetchImpl: (async () => new Response("", { status: 200 })) as typeof fetch,
    });
    const router = createLocalRouter({
      port: 8000,
      crmBridge: createCrmBridge({ cacheDir: dir, run: runner }),
      opsBridge,
    });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };

    const missing = await router(new Request("http://127.0.0.1:8000/local/ops/digest", { headers }));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: string }).error, "digest_unavailable");

    await writeOpsDigest(dir, [item({ id: "blog:a", sourceType: "blog", title: "博客 A" })]);
    const digest = await router(new Request("http://127.0.0.1:8000/local/ops/digest", { headers }));
    assert.equal(digest.status, 200);
    const digestBody = await digest.json() as { ok: boolean; data: { items: unknown[] }; refresh: { state: string } };
    assert.equal(digestBody.ok, true);
    assert.equal(digestBody.data.items.length, 1);
    assert.equal(digestBody.refresh.state, "idle");

    const refreshed = await router(new Request("http://127.0.0.1:8000/local/ops/refresh", { method: "POST", headers }));
    assert.equal(refreshed.status, 202);
    assert.equal(refreshCalls, 1);
    assert.equal(((await refreshed.json()) as { data: { state: string } }).data.state, "running");

    const card = await router(new Request("http://127.0.0.1:8000/local/ops/card", { headers }));
    assert.equal(card.status, 200);
    const cardBody = await card.json() as { data: { total: number } };
    assert.equal(cardBody.data.total, 1);

    const registered = await router(new Request("http://127.0.0.1:8000/local/ops/wechat-links", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://mp.weixin.qq.com/s/example123" }),
    }));
    assert.equal(registered.status, 201);

    const invalid = await router(new Request("http://127.0.0.1:8000/local/ops/wechat-links", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ url: "x" }),
    }));
    assert.equal(invalid.status, 400);

    const listed = await router(new Request("http://127.0.0.1:8000/local/ops/wechat-links", { headers }));
    const listedBody = await listed.json() as { data: { links: { url: string }[] } };
    assert.equal(listedBody.data.links.length, 1);

    const crossOrigin = await router(new Request("http://127.0.0.1:8000/local/ops/digest", {
      headers: { ...headers, origin: "https://attacker.example" },
    }));
    assert.equal(crossOrigin.status, 403);
  });
});
