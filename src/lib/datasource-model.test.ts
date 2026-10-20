import assert from "node:assert/strict";
import test from "node:test";

import {
  DATASOURCE_MODEL_VERSION,
  caps,
  channelIds,
  channelOf,
  capOf,
  envHealthKeys,
  envPresence,
  envSectionCount,
  groupIds,
  groupOf,
  healthGroupCount,
  healthKeys,
  registryIssues,
  registrySummary,
  sourceOf,
  sources,
  sourcesOfChannel,
  sourcesOfGroup,
} from "./datasource-model.ts";

test("registry: 51 sources / 17 groups / 8 channels / 23 caps / 5 env sections / 5 health groups", () => {
  assert.equal(sources.length, 51);
  assert.equal(groupIds().length, 17);
  assert.equal(channelIds().length, 8);
  assert.equal(caps.length, 23);
  assert.equal(envSectionCount(), 5);
  assert.equal(healthGroupCount(), 5);
  const sum = registrySummary();
  assert.equal(sum.version, DATASOURCE_MODEL_VERSION);
  assert.equal(sum.sourceCount, 51);
});

test("registry is self-consistent (no unknown grp/cap/ch, no duplicate sys)", () => {
  assert.deepEqual(registryIssues(), []);
});

test("lookups: channelOf / groupOf / capOf / sourceOf", () => {
  assert.equal(channelOf("cookie")?.short, "Cookie 直连");
  assert.equal(channelOf("static")?.cls, "tbd");
  assert.equal(groupOf("cust")?.d, "客户池 GAAP 盘面 ＋ ECID 画像（每户 5 请求）");
  assert.equal(groupOf(null), undefined);
  assert.equal(groupOf("nope"), undefined);
  assert.equal(capOf("cust")?.t, "客户池与画像");
  assert.equal(capOf(null), undefined);
  assert.equal(capOf("nope"), undefined);
  const crm = sourceOf("鲲鹏 CRM · devata「我的客户」");
  assert.ok(crm);
  assert.deepEqual(crm.ch, ["cookie"]);
  assert.deepEqual(crm.hk, ["devata"]);
  assert.equal(sourceOf("不存在的源"), undefined);
});

test("sourcesOfGroup keeps registry order and covers grouped sources", () => {
  const cust = sourcesOfGroup("cust");
  assert.ok(cust.length >= 1);
  for (const s of cust) assert.equal(s.grp, "cust");
  const ids = cust.map((s) => s.sys);
  assert.equal(ids.length, new Set(ids).size);

  // 全部源按 grp 分桶后总数不变（含 null 组）
  let total = 0;
  for (const g of [...groupIds(), null]) total += sourcesOfGroup(g).length;
  assert.equal(total, sources.length);
});

test("sourcesOfChannel filters by channel membership", () => {
  const cookieSources = sourcesOfChannel("cookie");
  assert.equal(cookieSources.length, 8);
  for (const s of cookieSources) assert.ok(s.ch.includes("cookie"));
  const statics = sourcesOfChannel("static");
  assert.equal(statics.length, 4);
  assert.deepEqual(
    statics.map((s) => s.sys),
    ["生命周期方法模型", "健康检测项与凭据托管清单", "环境入口目录", "无本地直连源的快照继承"],
  );
});

test("healthKeys expands hk arrays, deduped, in first-seen order", () => {
  const keys = healthKeys();
  assert.equal(keys.length, new Set(keys).size);
  assert.ok(keys.includes("dws"));
  assert.ok(keys.includes("a1"));
  const first = keys[0];
  const firstSourceWithHk = sources.find((s) => s.hk && s.hk.length > 0);
  assert.ok(firstSourceWithHk?.hk?.includes(first));
});

test("envHealthKeys collects platform hkeys, deduped", () => {
  const keys = envHealthKeys();
  assert.equal(keys.length, new Set(keys).size);
  assert.ok(keys.every((k) => typeof k === "string" && k.length > 0));
});

test("envPresence maps health rows to set/unset/probe-error/unprobed without exposing values", () => {
  const rows = [
    { name: "a1", state: "ok" },
    { name: "dws", state: "missing" },
    { name: "ossutil", state: "error" },
    { name: "qodercli", state: "unknown" },
    { name: "DASHSCOPE_API_KEY", state: "unconfigured" },
  ];
  assert.equal(envPresence("a1", rows), "set");
  assert.equal(envPresence("dws", rows), "unset");
  assert.equal(envPresence("DASHSCOPE_API_KEY", rows), "unset");
  assert.equal(envPresence("ossutil", rows), "probe-error");
  assert.equal(envPresence("qodercli", rows), "probe-error");
  assert.equal(envPresence("crd", rows), "unprobed"); // 快照里没有该键的行
  assert.equal(envPresence(null, rows), "no-key"); // 平台未登记健康键
  assert.equal(envPresence("a1", null), "unprobed"); // 尚未探测
  assert.equal(envPresence("a1", []), "unprobed");
  // 第一个匹配行生效（三组行拼接时按拼接顺序）
  assert.equal(envPresence("a1", [{ name: "a1", state: "unconfigured" }, ...rows]), "unset");
});
