import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SolutionPlan } from "../src/lib/assistant-contract.ts";
import {
  MAX_VERSIONS_PER_SERIES,
  createSolutionStore,
  seriesIdFor,
  type SolutionAppendInput,
} from "./solution-store.ts";

function plan(title: string, overrides: Partial<SolutionPlan> = {}): SolutionPlan {
  return {
    engine: "qoder-cli",
    title,
    summary: "六层阿里云架构，回答绑定受控引用。",
    layers: [
      { name: "接入层", purpose: "统一入口", products: [{ name: "API 网关", role: "鉴权限流" }] },
      { name: "模型层", purpose: "生成能力", products: [{ name: "阿里云百炼", role: "检索增强问答" }] },
    ],
    flows: [{ name: "问答链路", steps: ["提问", "检索", "生成"] }],
    mapping: [{ need: "可核验", product: "阿里云百炼", reason: "回答绑定引用" }],
    risks: [{ risk: "幻觉", mitigation: "阈值不足即拒答" }],
    nextSteps: ["确认验收指标"],
    evidence: [],
    generatedAt: "2026-10-13T02:00:00.000Z",
    ...overrides,
  };
}

const KEY = {
  customer: "某区域零售集团",
  industry: "零售与消费",
  goal: "建设面向门店经营的 AI 助手",
  constraints: "数据不出域",
};

const RETRIEVAL = { status: "results-only" as const, vectorSearch: "keyword-only" as const, resultCount: 12, queries: ["门店经营 AI 助手"] };

function input(overrides: Partial<SolutionAppendInput> = {}): SolutionAppendInput {
  return { key: KEY, requestId: "req-1", plan: plan("门店 AI 助手方案"), retrieval: RETRIEVAL, ...overrides };
}

async function withStore(run: (dir: string, store: ReturnType<typeof createSolutionStore>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "sa-solutions-"));
  try {
    await run(dir, createSolutionStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let clock = Date.parse("2026-10-13T02:00:00.000Z");
const tick = () => () => new Date(clock += 60_000);

test("groups versions into one series and keeps them in order", async () => {
  await withStore(async (_dir, store) => {
    const first = await store.append(input(), tick());
    assert.equal(first?.version.version, 1);
    assert.equal(first?.series.seriesId, seriesIdFor(KEY));

    const second = await store.append(
      input({ key: { ...KEY, constraints: "改为混合云" }, plan: plan("门店 AI 助手方案 v2"), requestId: "req-2" }),
      tick(),
    );
    assert.equal(second?.series.seriesId, first?.series.seriesId, "constraints do not fork the series");
    assert.equal(second?.version.version, 2);

    const series = await store.get(first!.series.seriesId);
    assert.deepEqual(series?.versions.map((version) => version.version), [1, 2]);
    assert.equal(series?.versions[1]!.plan.title, "门店 AI 助手方案 v2");
    assert.equal(series?.versions[1]!.requestId, "req-2");
    assert.deepEqual(series?.versions[0]!.retrieval, RETRIEVAL);

    const other = await store.append(input({ key: { ...KEY, goal: "建设数据中台" } }), tick());
    assert.notEqual(other?.series.seriesId, first?.series.seriesId);
  });
});

test("lists series newest-first with a summary of the latest version", async () => {
  await withStore(async (_dir, store) => {
    await store.append(input(), tick());
    await store.append(input({ key: { ...KEY, customer: "某制造集团", goal: "建设数据中台" }, plan: plan("制造数据中台", { engine: "template", degraded: "cli-timeout" }) }), tick());

    const summaries = await store.list();
    assert.deepEqual(summaries.map((summary) => summary.customer), ["某制造集团", KEY.customer]);
    assert.equal(summaries[0]!.title, "制造数据中台");
    assert.equal(summaries[0]!.latestEngine, "template");
    assert.equal(summaries[0]!.latestDegraded, "cli-timeout");
    assert.equal(summaries[1]!.versionCount, 1);
    assert.equal(summaries[1]!.latestVersion, 1);
    assert.equal(summaries[1]!.industry, "零售与消费");
  });
});

test("caps a series and renumbers the surviving versions", async () => {
  await withStore(async (_dir, store) => {
    const total = MAX_VERSIONS_PER_SERIES + 2;
    for (let index = 0; index < total; index += 1) {
      await store.append(input({ requestId: `req-${index}`, plan: plan(`方案 ${index}`) }), tick());
    }
    const series = await store.get(seriesIdFor(KEY));
    assert.equal(series?.versions.length, MAX_VERSIONS_PER_SERIES);
    assert.deepEqual(
      series?.versions.map((version) => version.version),
      Array.from({ length: MAX_VERSIONS_PER_SERIES }, (_unused, index) => index + 1),
    );
    assert.equal(series?.versions[0]!.plan.title, `方案 ${total - MAX_VERSIONS_PER_SERIES}`);
    assert.equal(series?.versions.at(-1)!.plan.title, `方案 ${total - 1}`);
    assert.equal((await store.list())[0]!.versionCount, MAX_VERSIONS_PER_SERIES);
  });
});

test("deletes one version, renumbers the rest and drops an emptied series", async () => {
  await withStore(async (_dir, store) => {
    const seriesId = seriesIdFor(KEY);
    const kept: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      kept.push((await store.append(input({ requestId: `req-${index}` }), tick()))!.version.versionId);
    }

    assert.equal(await store.remove(seriesId, kept[1]!), 2);
    const afterDelete = await store.get(seriesId);
    assert.deepEqual(afterDelete?.versions.map((version) => version.version), [1, 2]);
    assert.deepEqual(afterDelete?.versions.map((version) => version.versionId), [kept[0]!, kept[2]!]);

    assert.equal(await store.remove(seriesId, kept[2]!), 1);
    assert.equal(await store.remove(seriesId, kept[0]!), 0);
    assert.equal(await store.get(seriesId), undefined);
    assert.deepEqual(await store.list(), []);
  });
});

test("rejects unknown ids, invalid plans and corrupt archives", async () => {
  await withStore(async (dir, store) => {
    assert.equal(await store.remove("not-a-series-id", "not-a-version"), undefined);
    assert.equal(await store.remove(seriesIdFor(KEY), "missing-version"), undefined);
    assert.equal(await store.get("../../etc/passwd"), undefined);
    assert.equal(await store.append(input({ plan: { ...plan("坏方案"), layers: [] } })), undefined);

    await writeFile(join(dir, `${seriesIdFor(KEY)}.json`), "{ not json", "utf-8");
    assert.equal(await store.get(seriesIdFor(KEY)), undefined);
    assert.deepEqual(await store.list(), []);

    const appended = await store.append(input(), tick());
    assert.equal(appended?.version.version, 1, "a corrupt archive is replaced, not merged");
  });
});
