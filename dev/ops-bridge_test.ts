import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("push card dry-run persists a preview and never calls dws", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [
      item({ id: "blog:today", sourceType: "blog", title: "今日博客", url: "https://qoder.com/zh/blog/a" }),
      item({ id: "changelog:today", sourceType: "changelog", title: "今日更新" }),
      item({ id: "blog:old", sourceType: "blog", title: "昨天博客", publishedAt: "2026-10-15T09:00:00" }),
    ]);
    const runs: string[] = [];
    const runner: CommandRunner = (file, args) => {
      runs.push(`${file} ${args.slice(0, 2).join(" ")}`);
      return Promise.resolve({ code: 0, stdout: "" });
    };
    // 开关关（默认）+ 已配置接收人：也必须只走 dry-run，不调用 dws。
    const bridge = createOpsBridge({
      cacheDir: dir, now: () => NOW, run: runner, env: {
        OPS_DINGTALK_PUSH_ENABLED: "0",
        OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "receiverOpenId123",
      },
    });
    const result = await bridge.pushCard({ dryRun: true });
    assert.ok(result.ok);
    assert.equal(result.preview.mode, "dry_run");
    assert.equal(result.preview.date, "2026-10-16");
    assert.equal(result.preview.entryCount, 2);
    assert.equal(result.preview.receiverConfigured, true);
    assert.match(result.preview.note, /未实际发送/);
    // 内容只能来自当日卡：今日条目在内、昨日条目不在。
    assert.match(result.preview.cardText, /运营推广日报 · 2026-10-16/);
    assert.match(result.preview.cardText, /今日博客/);
    assert.match(result.preview.cardText, /今日更新/);
    assert.ok(!result.preview.cardText.includes("昨天博客"));
    // previewId = sha256(cardText + 卡片 generatedAt) 前 16 位，且同内容稳定复现。
    assert.match(result.preview.previewId, /^[0-9a-f]{16}$/);
    const again = await bridge.pushCard({ dryRun: true });
    assert.ok(again.ok);
    assert.equal(again.ok && again.preview.previewId, result.ok && result.preview.previewId);
    // dws 从未被调用。
    assert.deepEqual(runs, []);
    // 预览产物 0600 落盘且不落接收人 ID。
    assert.equal((await stat(join(dir, "ops-push-preview.json"))).mode & 0o777, 0o600);
    const raw = await readFile(join(dir, "ops-push-preview.json"), "utf-8");
    assert.ok(!raw.includes("receiverOpenId123"), "receiver id must not be persisted");
    assert.ok(raw.includes(result.ok ? result.preview.previewId : ""), "preview artifact carries the previewId");
  });
});

test("push sends require confirm with a matching fresh preview id", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "今日博客" })]);
    const runner: CommandRunner = () => Promise.resolve({ code: 0, stdout: "" });
    // 无 confirm 的请求一律 preview_required，连卡都不读。
    const plain = createOpsBridge({ cacheDir: dir, now: () => NOW, env: {}, run: runner });
    assert.deepEqual(await plain.pushCard(), { ok: false, error: "preview_required" });
    // 总开关关时，confirm 请求先如实报 push_disabled。
    assert.deepEqual(await plain.pushCard({ confirm: true }), { ok: false, error: "push_disabled" });

    // 没有摘要时：dry-run 与 confirm 都如实 digest_unavailable。
    const empty = createOpsBridge({ cacheDir: join(dir, "none"), now: () => NOW, env: {}, run: runner });
    assert.deepEqual(await empty.pushCard({ dryRun: true }), { ok: false, error: "digest_unavailable" });
    assert.deepEqual(
      await empty.pushCard({ confirm: true, previewId: "0123456789abcdef" }),
      { ok: false, error: "digest_unavailable" },
    );

    // 开了开关但没有接收人 → 明确拒绝。
    const noReceiver = createOpsBridge({
      cacheDir: dir, now: () => NOW, run: runner, env: { OPS_DINGTALK_PUSH_ENABLED: "1" },
    });
    const preview = await noReceiver.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";
    assert.deepEqual(
      await noReceiver.pushCard({ confirm: true, previewId }),
      { ok: false, error: "recipient_not_configured" },
    );
    // 接收人格式非法同样拒绝。
    const badReceiver = createOpsBridge({
      cacheDir: dir, now: () => NOW, run: runner, env: {
        OPS_DINGTALK_PUSH_ENABLED: "1",
        OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "bad id with spaces!",
      },
    });
    assert.deepEqual(
      await badReceiver.pushCard({ confirm: true, previewId }),
      { ok: false, error: "recipient_not_configured" },
    );

    // 总开关关（默认）：confirm + 合法 previewId 也不得真发。
    const disabled = createOpsBridge({
      cacheDir: dir, now: () => NOW, run: runner, env: {
        OPS_DINGTALK_PUSH_ENABLED: "0",
        OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "receiverOpenId123",
      },
    });
    assert.deepEqual(
      await disabled.pushCard({ confirm: true, previewId }),
      { ok: false, error: "push_disabled" },
    );

    // 旧/伪造 previewId → preview_stale。
    const enabled = createOpsBridge({
      cacheDir: dir, now: () => NOW, run: runner, env: {
        OPS_DINGTALK_PUSH_ENABLED: "1",
        OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "receiverOpenId123",
      },
    });
    assert.deepEqual(
      await enabled.pushCard({ confirm: true, previewId: "deadbeefdeadbeef" }),
      { ok: false, error: "preview_stale" },
    );
  });
});

test("push confirm flow: fresh preview sends once, replays and drift go stale", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "今日博客" })]);
    const commands: { file: string; args: string[] }[] = [];
    const runner: CommandRunner = async (file, args) => {
      commands.push({ file, args: [...args] });
      return { code: 0, stdout: '{"ok":true}' };
    };
    const bridge = createOpsBridge({
      cacheDir: dir, now: () => NOW, run: runner, env: {
        OPS_DINGTALK_PUSH_ENABLED: "1",
        OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "receiverOpenId123",
      },
    });
    // 开关与接收人就绪但缺 previewId → preview_required。
    assert.deepEqual(await bridge.pushCard({ confirm: true }), { ok: false, error: "preview_required" });
    const preview = await bridge.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";

    // 首次确认：真发一次，落 sent 产物。
    const sent = await bridge.pushCard({ confirm: true, previewId });
    assert.ok(sent.ok);
    assert.equal(sent.ok && sent.preview.mode, "sent");
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.file, "dws");
    assert.equal(commands[0]!.args[0], "chat");
    assert.equal(commands[0]!.args[1], "+messages-send-card");
    assert.ok(commands[0]!.args.includes("--receiver-open-dingtalk-id"));
    assert.ok(commands[0]!.args.includes("receiverOpenId123"));
    assert.ok(!commands[0]!.args.includes("--group"), "group push must never be constructed");
    assert.ok(!commands[0]!.args.includes("--at-all"));

    // 逐次确认：同一 previewId 不允许二次发送。
    assert.deepEqual(
      await bridge.pushCard({ confirm: true, previewId }),
      { ok: false, error: "preview_stale" },
    );
    assert.equal(commands.length, 1, "replay must not reach dws again");

    // 内容漂移：摘要刷新后（generatedAt 变化）旧 previewId 即使重新 dry-run 过也作废。
    await writeOpsDigest(dir, [item({ id: "blog:today2", sourceType: "blog", title: "今日博客二" })]);
    const stale = await bridge.pushCard({ dryRun: true });
    assert.ok(stale.ok);
    assert.notEqual(stale.ok ? stale.preview.previewId : "", previewId);
    assert.deepEqual(
      await bridge.pushCard({ confirm: true, previewId }),
      { ok: false, error: "preview_stale" },
    );
    assert.equal(commands.length, 1);
  });
});

const PUSH_ENV = {
  OPS_DINGTALK_PUSH_ENABLED: "1",
  OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "receiverOpenId123",
} as const;

async function readPreviewMode(dir: string): Promise<string> {
  return (JSON.parse(await readFile(join(dir, "ops-push-preview.json"), "utf-8")) as { mode: string }).mode;
}

test("push confirm after content drift without a fresh preview is stale and never calls dws", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "甲科技今日博客" })]);
    let runs = 0;
    const runner: CommandRunner = async () => { runs += 1; return { code: 0, stdout: "" }; };
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, run: runner, env: PUSH_ENV });
    const preview = await bridge.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";

    // 预览后摘要内容变化，但未重新预览：落盘预览仍是 dry_run + 旧 id，当前卡指纹已变。
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "乙股份今日博客" })]);
    assert.deepEqual(await bridge.pushCard({ confirm: true, previewId }), { ok: false, error: "preview_stale" });
    assert.equal(runs, 0, "drifted content must never reach dws");
    assert.equal(await readPreviewMode(dir), "dry_run");
  });
});

test("push confirm reports push_failed when dws fails, keeps the preview unsent and allows an explicit retry", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "甲科技今日博客" })]);
    const outcomes = [{ code: 1, stdout: '{"ok":false}' }, { code: 0, stdout: '{"ok":true}' }];
    let runs = 0;
    const runner: CommandRunner = async () => outcomes[Math.min(runs++, outcomes.length - 1)]!;
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, run: runner, env: PUSH_ENV });
    const preview = await bridge.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";

    assert.deepEqual(await bridge.pushCard({ confirm: true, previewId }), { ok: false, error: "push_failed" });
    assert.equal(runs, 1);
    // 失败不写入 sent：产物仍是 dry_run，同一 previewId 可由用户再次显式确认重试。
    assert.equal(await readPreviewMode(dir), "dry_run");

    const retried = await bridge.pushCard({ confirm: true, previewId });
    assert.ok(retried.ok);
    assert.equal(retried.ok && retried.preview.mode, "sent");
    assert.equal(runs, 2);
    assert.equal(await readPreviewMode(dir), "sent");
  });
});

test("push confirm timeout is push_uncertain: preview stays consumed, unsent, and cannot be re-confirmed", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "甲科技今日博客" })]);
    let runs = 0;
    // code=null 模拟超时/进程异常：消息可能已送达，结果未知。
    const runner: CommandRunner = async () => { runs += 1; return { code: null, stdout: "" }; };
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, run: runner, env: PUSH_ENV });
    const preview = await bridge.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";

    assert.deepEqual(await bridge.pushCard({ confirm: true, previewId }), { ok: false, error: "push_uncertain" });
    assert.equal(runs, 1);
    assert.equal(await readPreviewMode(dir), "dry_run", "结果未知不写 sent");
    // 同一 previewId 不可再确认：防止超时后重试导致发两遍。
    assert.deepEqual(await bridge.pushCard({ confirm: true, previewId }), { ok: false, error: "preview_consumed" });
    assert.equal(runs, 1, "未知结果后的重复确认绝不触达 dws");
  });
});

test("concurrent confirms of the same preview reach dws exactly once", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "甲科技今日博客" })]);
    let release: (value: { code: number | null; stdout: string }) => void = () => {};
    const gate = new Promise<{ code: number | null; stdout: string }>((resolve) => { release = resolve; });
    let runs = 0;
    // 首调阻塞在 gate；若实现有缺陷让第二个确认也进到 dws，它会立即"成功"并暴露为断言失败。
    const runner: CommandRunner = () => {
      runs += 1;
      return runs === 1 ? gate : Promise.resolve({ code: 0, stdout: '{"ok":true}' });
    };
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, run: runner, env: PUSH_ENV });
    const preview = await bridge.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";

    const first = bridge.pushCard({ confirm: true, previewId }).then((result) => ({ index: 0, result }));
    const second = bridge.pushCard({ confirm: true, previewId }).then((result) => ({ index: 1, result }));
    // 赢家阻塞在 gate 上无法结束，先结束的必然是被拒的那一个。
    const loser = await Promise.race([first, second]);
    assert.deepEqual(loser.result, { ok: false, error: "push_in_progress" });
    assert.equal(runs, 1);

    release({ code: 0, stdout: '{"ok":true}' });
    const winner = await (loser.index === 0 ? second : first);
    assert.ok(winner.result.ok);
    assert.equal(winner.result.ok && winner.result.preview.mode, "sent");
    assert.equal(runs, 1, "dws must be invoked exactly once for concurrent confirms");
  });
});

test("a consumed preview id is refused even if a stale dry-run read slips through", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "甲科技今日博客" })]);
    let runs = 0;
    const runner: CommandRunner = async () => { runs += 1; return { code: 0, stdout: "" }; };
    const bridge = createOpsBridge({ cacheDir: dir, now: () => NOW, run: runner, env: PUSH_ENV });
    const preview = await bridge.pushCard({ dryRun: true });
    assert.ok(preview.ok);
    const previewId = preview.ok ? preview.preview.previewId : "";
    const dryArtifact = await readFile(join(dir, "ops-push-preview.json"), "utf-8");
    assert.ok((await bridge.pushCard({ confirm: true, previewId })).ok);
    assert.equal(runs, 1);

    // 模拟并发请求在 sent 落盘前读到的旧 dry-run 产物：桥内已消费标记仍须拦截。
    await writeFile(join(dir, "ops-push-preview.json"), dryArtifact);
    assert.deepEqual(await bridge.pushCard({ confirm: true, previewId }), { ok: false, error: "preview_consumed" });
    assert.equal(runs, 1);
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

test("router enforces the push two-step confirm protocol", async () => {
  await withCache(async (dir) => {
    await writeOpsDigest(dir, [item({ id: "blog:today", sourceType: "blog", title: "今日博客" })]);
    const opsBridge = createOpsBridge({
      cacheDir: dir, now: () => NOW,
      run: () => Promise.resolve({ code: 0, stdout: "" }),
      env: {
        OPS_DINGTALK_PUSH_ENABLED: "1",
        OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID: "receiverOpenId123",
      },
    });
    const router = createLocalRouter({ port: 8000, opsBridge });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };
    const post = (body?: unknown) => router(new Request("http://127.0.0.1:8000/local/ops/push", {
      method: "POST",
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

    // 无 body / 缺 previewId → 400 preview_required（绝不静默发送）。
    const bare = await post();
    assert.equal(bare.status, 400);
    assert.equal(((await bare.json()) as { error: string }).error, "preview_required");
    const malformed = await post({ confirm: true });
    assert.equal(malformed.status, 400);

    // dry-run → 202 + previewId；错误/过期 previewId → 409。
    const dry = await post({ dryRun: true });
    assert.equal(dry.status, 202);
    const dryBody = (await dry.json()) as { data: { mode: string; previewId: string } };
    assert.equal(dryBody.data.mode, "dry_run");
    assert.match(dryBody.data.previewId, /^[0-9a-f]{16}$/);

    const stale = await post({ confirm: true, previewId: "0000000000000000" });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: string }).error, "preview_stale");

    // 正确 previewId + confirm → 200 sent；重放同一 previewId → 409。
    const dryArtifact = await readFile(join(dir, "ops-push-preview.json"), "utf-8");
    const sent = await post({ confirm: true, previewId: dryBody.data.previewId });
    assert.equal(sent.status, 200);
    assert.equal(((await sent.json()) as { data: { mode: string } }).data.mode, "sent");
    const replay = await post({ confirm: true, previewId: dryBody.data.previewId });
    assert.equal(replay.status, 409);

    // 已消费的 previewId（即使读到旧 dry-run 产物）→ 409 preview_consumed。
    await writeFile(join(dir, "ops-push-preview.json"), dryArtifact);
    const consumed = await post({ confirm: true, previewId: dryBody.data.previewId });
    assert.equal(consumed.status, 409);
    assert.equal(((await consumed.json()) as { error: string }).error, "preview_consumed");
  });
});
