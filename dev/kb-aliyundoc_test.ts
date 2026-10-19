import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAliyundocAdapter } from "./kb/kb-aliyundoc.ts";
import type { KbSource } from "./kb/kb-types.ts";

// ---------------------------------------------------------------------------
// aliyundoc 适配器：纯函数安全校验 + fetch 注入的 search/read 行为。
// 合成数据约定：全程使用「甲科技 / 乙股份」等合成名，绝无真实客户数据。
// ---------------------------------------------------------------------------

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kb-aliyundoc-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const aliyunSource: KbSource = {
  id: "aliyundoc", type: "aliyundoc", name: "阿里云官方文档", enabled: true, site: "cn", lang: "zh",
  products: [{ id: "model-studio", name: "大模型服务平台百炼" }],
};

test("aliyundoc url allowlist only accepts allowlist-host .md addresses", async () => {
  const { mdUrlOf, allowedUrl, aliyundocIndexUrl, productCodeOf } = await import("./kb/kb-aliyundoc.ts");
  assert.equal(mdUrlOf("https://help.aliyun.com/zh/ecs/doc.md"), "https://help.aliyun.com/zh/ecs/doc.md");
  assert.equal(mdUrlOf("https://evil.example.com/zh/ecs/doc.md"), "");
  assert.equal(mdUrlOf("http://help.aliyun.com/zh/ecs/doc.md"), "", "http is not https");
  assert.equal(mdUrlOf("https://help.aliyun.com/zh/ecs/doc.md?x=1"), "", "query strings are rejected");
  assert.equal(mdUrlOf("https://help.aliyun.com/zh/../secret.md"), "", "traversal is rejected");
  assert.equal(mdUrlOf("https://help.aliyun.com/zh/ecs/doc"), "", "non-.md rejected");
  assert.equal(mdUrlOf("https://help.aliyun.com/zh/" + "x".repeat(1100) + ".md"), "", "over-long urls rejected");

  assert.equal(allowedUrl("https://www.alibabacloud.com/help/en/ecs/a.md")?.hostname, "www.alibabacloud.com");
  assert.equal(allowedUrl("https://help.aliyun.com/zh/ecs/llms.txt?probe=1"), null);

  assert.equal(aliyundocIndexUrl("cn", "zh", ""), "https://help.aliyun.com/zh/llms.txt");
  assert.equal(aliyundocIndexUrl("cn", "zh", "model-studio"), "https://help.aliyun.com/zh/model-studio/llms.txt");
  assert.equal(aliyundocIndexUrl("intl", "ja", "ecs"), "https://www.alibabacloud.com/help/ja/ecs/llms.txt");
  assert.equal(productCodeOf("https://help.aliyun.com/zh/model-studio/llms.txt", "cn", "zh"), "model-studio");
  assert.equal(productCodeOf("https://help.aliyun.com/zh/llms.txt", "cn", "zh"), "");
});

test("aliyundoc index parsing and scoring follow the reference semantics", async () => {
  const { parseLlmsIndex, tokenizeQuery, scoreTextAgainst } = await import("./kb/kb-aliyundoc.ts");
  const entries = parseLlmsIndex([
    "## 指南",
    "- [大模型服务平台百炼](https://help.aliyun.com/zh/model-studio/get-started.md): 快速入门百炼",
    "- [无摘要条目](https://help.aliyun.com/zh/model-studio/other.md)",
    "not-a-list-line",
  ].join("\n"));
  assert.deepEqual(entries, [
    { title: "大模型服务平台百炼", url: "https://help.aliyun.com/zh/model-studio/get-started.md", desc: "快速入门百炼", sec: "指南" },
    { title: "无摘要条目", url: "https://help.aliyun.com/zh/model-studio/other.md", desc: "", sec: "指南" },
  ]);

  const tokens = tokenizeQuery("百炼 模型服务");
  assert.deepEqual(tokens.words, ["百炼", "模型服务"]);
  assert.ok(tokens.grams.includes("百炼") && tokens.grams.includes("模型"), "CJK bigrams generated");

  const hitScore = scoreTextAgainst("大模型服务平台百炼", "", tokenizeQuery("百炼"), 6, 2);
  assert.ok(hitScore > 0);
  // 只中一个二元组不算命中（压噪声）。
  assert.equal(scoreTextAgainst("毫无相关内容", "", tokenizeQuery("炼模"), 6, 2), 0);
  assert.ok(scoreTextAgainst("百炼概述", "百炼是面向开发者的平台", tokenizeQuery("百炼"), 6, 2) > 0);
});

test("aliyundoc search/read fetch only allowlist hosts, cache with last-good and detect html shells", async () => {
  await withTempDir(async () => {
    const rootIndex = [
      "## 产品",
      "- [大模型服务平台百炼](https://help.aliyun.com/zh/model-studio/llms.txt): 百炼产品索引",
    ].join("\n");
    const productIndex = [
      "- [百炼概述](https://help.aliyun.com/zh/model-studio/overview.md): 面向开发者的模型平台",
      "- [模型概览](https://help.aliyun.com/zh/model-studio/models.md): 百炼提供的模型列表",
    ].join("\n");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/zh/llms.txt")) return new Response(rootIndex, { status: 200 });
      if (url.endsWith("/zh/model-studio/llms.txt")) return new Response(productIndex, { status: 200 });
      if (url.endsWith("overview.md")) return new Response("<meta og:title>\n# 百炼概述\n\n百炼正文\n\n\n\n更多", { status: 200 });
      throw new Error("unexpected " + url);
    };
    const adapter = createAliyundocAdapter({ fetchImpl, now: () => Date.now() });

    const spaces = await adapter.spaces(aliyunSource);
    assert.deepEqual(spaces, [{ id: "model-studio", name: "大模型服务平台百炼", leaf: true }]);

    const hits = await adapter.search(aliyunSource, "百炼", 10);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.title, "百炼概述");
    assert.equal(hits[0]!.rank, 1);
    assert.equal(hits[0]!.space, "大模型服务平台百炼");
    assert.match(hits[0]!.snippet ?? "", /面向开发者的模型平台/);
    assert.equal(hits[0]!.url, "https://help.aliyun.com/zh/model-studio/overview");

    const doc = await adapter.read(aliyunSource, "https://help.aliyun.com/zh/model-studio/overview.md");
    assert.equal(doc.title, "百炼概述");
    assert.ok(!doc.body.includes("<meta"), "检索锚点 meta 行被剥掉");
    assert.ok(!/\n{3,}/.test(doc.body), "多余空行被压掉");
    assert.equal(doc.url, "https://help.aliyun.com/zh/model-studio/overview");

    // 读到 HTML 壳时如实拒绝，不假装是正文。
    const shellFetcher: typeof fetch = async () => new Response("<!doctype html><html><body>x</body></html>", { status: 200 });
    const shellAdapter = createAliyundocAdapter({ fetchImpl: shellFetcher, now: () => Date.now() });
    await assert.rejects(() => shellAdapter.read(aliyunSource, "https://help.aliyun.com/zh/model-studio/overview.md"), /Markdown/);

    // 非白名单/未配置地址在 fetch 层被拒（fetchImpl 抛错 → 网络错误包装）。
    await assert.rejects(() => adapter.read(aliyunSource, "https://help.aliyun.com/zh/ecs/a.md"), /网络错误/);
  });
});
