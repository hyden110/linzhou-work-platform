import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalRouter } from "./local-router.ts";
import { createMaasBridge } from "./maas-bridge.ts";

const NOW = new Date("2026-10-18T12:00:00").getTime();

async function withCache(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "maas-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 合成客户/项目名，不含任何真实客户信息。 */
function writeSnapshot(dir: string): Promise<void> {
  return writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-10-18T02:00:00Z",
    sources: {},
    customers: [
      { cid: "c001", name: "示例智造" },
      { cid: "c002", name: "合成大模型科技" },
      { cid: "c003", name: "样例云服务" },
      { cid: "c004", name: "样例混合云集团" },
    ],
    projects: [
      { id: "p1", name: "百炼模型服务落地", cid: "c002", customerName: "合成大模型科技", cate: "混合云" },
      { id: "p2", name: "推理平台扩容", cid: null, customerName: "样例云服务", cate: "公有云" },
      { id: "p3", name: "混合云交付项目", cid: "c004", customerName: "样例混合云集团", cate: "混合云" },
      { id: "p4", name: "示例 ERP 扩容", cid: "c001", customerName: "示例智造", cate: null },
      { id: "p5", name: "大模型陌生客户项目", cid: null, customerName: "不存在的客户", cate: null },
    ],
  }));
}

test("candidates keyword-screen names only, conserve customer ids and never use cate", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir);
    const bridge = createMaasBridge({ cacheDir: dir, now: () => NOW });
    const file = await bridge.candidates();
    assert.ok(file);
    // 守恒：候选 ⊆ 快照客户，且只标「疑似 maas」。
    assert.equal(file.totalCustomers, 4);
    assert.deepEqual(file.candidates.map((candidate) => candidate.cid), ["c002", "c003"]);
    assert.ok(file.candidates.every((candidate) => candidate.suggestion === "maas"));
    const c002 = file.candidates[0]!;
    assert.equal(c002.customerName, "合成大模型科技");
    assert.deepEqual(c002.evidence[0], { source: "customer", name: "合成大模型科技", keywords: ["大模型"] });
    assert.deepEqual(
      c002.evidence[1],
      { source: "project", name: "百炼模型服务落地", keywords: ["模型服务", "百炼"] },
    );
    // cate（混合云/公有云）不参与：c004 只有混合云口径，不得成为候选；陌生客户项目被丢弃。
    assert.ok(!file.candidates.some((candidate) => candidate.cid === "c004"));
    // 产物 0600 落盘。
    assert.equal((await stat(join(dir, "maas-candidates.json"))).mode & 0o777, 0o600);
    assert.equal(file.readOnly, true);
    assert.equal(file.generatedAt, new Date(NOW).toISOString());
  });
});

test("maas-bridge source never references cate in code (static assertion)", async () => {
  const source = await readFile(new URL("./maas-bridge.ts", import.meta.url), "utf-8");
  // 只查代码：剥离注释后不得出现 cate（混合云/公有云/国际禁止参与 MaaS 初筛）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  assert.ok(!/\bcate\b/.test(code), "cate must not participate in MaaS candidate screening");
});

test("candidates returns undefined for a missing or invalid snapshot", async () => {
  await withCache(async (dir) => {
    const bridge = createMaasBridge({ cacheDir: dir, now: () => NOW });
    assert.equal(await bridge.candidates(), undefined);
    await writeFile(join(dir, "crm-snapshot.json"), "{not json");
    assert.equal(await bridge.candidates(), undefined);
    await writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({ schemaVersion: 2, customers: [] }));
    assert.equal(await bridge.candidates(), undefined);
  });
});

test("overrides prefer the local file, fall back honestly and sanitize values", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({ cPub: "maas" }));
    const bridge = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });

    // 本机缺失 → 回退 public 静态表。
    assert.deepEqual(await bridge.overrides(), { cPub: "maas" });

    // 本机存在 → 优先本机，非法值（cBad）被清洗丢弃。
    await writeFile(join(dir, "maas-overrides.json"), JSON.stringify({ cLoc: "non_maas", cBad: "yes" }));
    assert.deepEqual(await bridge.overrides(), { cLoc: "non_maas" });

    // 本机非法 JSON → 回退 public；public 也坏 → 空表。
    await writeFile(join(dir, "maas-overrides.json"), "{oops");
    assert.deepEqual(await bridge.overrides(), { cPub: "maas" });
    await writeFile(publicPath, "{oops");
    assert.deepEqual(await bridge.overrides(), {});
  });
});

test("setOverride writes the local file 0600, supports clearing and never touches public", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    const bridge = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });

    const saved = await bridge.setOverride("c002", "non_maas");
    assert.ok(saved.ok);
    assert.deepEqual(saved.ok && saved.overrides, { c002: "non_maas" });
    assert.equal((await stat(join(dir, "maas-overrides.json"))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(publicPath, "utf-8")), {}, "public file must never receive real overrides");

    // 覆盖后再写另一个 cid，两个都在。
    await bridge.setOverride("c003", "maas");
    // unconfirmed = 清除覆盖。
    await bridge.setOverride("c002", "unconfirmed");
    assert.deepEqual(await bridge.overrides(), { c003: "maas" });

    // 非法输入如实拒绝。
    assert.deepEqual(await bridge.setOverride("", "maas"), { ok: false, error: "invalid_cid" });
    assert.deepEqual(await bridge.setOverride("a b", "maas"), { ok: false, error: "invalid_cid" });
    assert.deepEqual(await bridge.setOverride("c001", "martist" as never), { ok: false, error: "invalid_status" });

    // 新实例（=刷新后）读取到已保存的覆盖。
    const reloaded = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });
    assert.deepEqual(await reloaded.overrides(), { c003: "maas" });
  });
});

test("router exposes maas candidate and override routes", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    const maasBridge = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });
    const router = createLocalRouter({ port: 8000, maasBridge });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };

    // 无快照 → 404。
    const missing = await router(new Request("http://127.0.0.1:8000/local/crm/maas-candidates", { headers }));
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: string }).error, "snapshot_unavailable");

    await writeSnapshot(dir);
    const candidates = await router(new Request("http://127.0.0.1:8000/local/crm/maas-candidates", { headers }));
    assert.equal(candidates.status, 200);
    const candidatesBody = (await candidates.json()) as {
      data: { totalCustomers: number; candidates: { cid: string; suggestion: string }[] };
    };
    assert.equal(candidatesBody.data.totalCustomers, 4);
    assert.deepEqual(candidatesBody.data.candidates.map((candidate) => candidate.cid), ["c002", "c003"]);

    // 覆盖表：public {} 起步 → POST 非法 400 → POST 合法 200 → 回读一致。
    const initial = await router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", { headers }));
    assert.deepEqual(((await initial.json()) as { data: { overrides: unknown } }).data.overrides, {});

    const invalid = await router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "c002", status: "yes" }),
    }));
    assert.equal(invalid.status, 400);

    const blankCid = await router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "  ", status: "maas" }),
    }));
    assert.equal(blankCid.status, 400);

    const saved = await router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "c002", status: "non_maas" }),
    }));
    assert.equal(saved.status, 200);
    assert.deepEqual(
      ((await saved.json()) as { data: { overrides: Record<string, string> } }).data.overrides,
      { c002: "non_maas" },
    );

    const reread = await router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", { headers }));
    assert.deepEqual(
      ((await reread.json()) as { data: { overrides: Record<string, string> } }).data.overrides,
      { c002: "non_maas" },
    );

    // 本机覆盖文件 0600；public 文件保持 {}，从未被写入。
    assert.equal((await stat(join(dir, "maas-overrides.json"))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(publicPath, "utf-8")), {});
  });
});

// ---------------------------------------------------------------------------
// 返工（独立评审 P1/P2/P3）：串行写队列、损坏覆盖表拒写、候选写盘失败不改结果、控制字符拒绝。
// 合成数据：甲科技/乙股份、9900 开头合成 cid，不含任何真实客户信息。
// ---------------------------------------------------------------------------

const CID_A = "9900000001";
const CID_B = "9900000002";

function writeSyntheticSnapshot(dir: string): Promise<void> {
  return writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({
    schemaVersion: 1,
    customers: [
      { cid: CID_A, name: "甲科技" },
      { cid: CID_B, name: "乙股份" },
    ],
    projects: [{ id: "p1", name: "甲科技大模型推理", cid: CID_A, customerName: "甲科技" }],
  }));
}

test("concurrent setOverride on different cids are serialized so both survive, without tmp leftovers", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    const bridge = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });

    const results = await Promise.all([
      bridge.setOverride(CID_A, "maas"),
      bridge.setOverride(CID_B, "non_maas"),
    ]);
    assert.ok(results.every((result) => result.ok));
    const expected = { [CID_A]: "maas", [CID_B]: "non_maas" };
    assert.deepEqual(JSON.parse(await readFile(join(dir, "maas-overrides.json"), "utf-8")), expected);
    assert.deepEqual(await bridge.overrides(), expected);
    assert.equal((await stat(join(dir, "maas-overrides.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), [], "原子写不得残留 tmp");
  });
});

test("a failed override write does not poison the write queue", async () => {
  await withCache(async (root) => {
    const cacheDir = join(root, "cache");
    const publicPath = join(root, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    // cacheDir 位置被普通文件占用 → mkdir 失败，本次写入如实 reject。
    await writeFile(cacheDir, "occupied");
    const bridge = createMaasBridge({ cacheDir, publicOverridesPath: publicPath, now: () => NOW });
    await assert.rejects(() => bridge.setOverride(CID_A, "maas"));

    await rm(cacheDir, { force: true });
    const saved = await bridge.setOverride(CID_B, "non_maas");
    assert.deepEqual(saved, { ok: true, overrides: { [CID_B]: "non_maas" } }, "失败后的下一次写入照常执行");
  });
});

test("corrupt local overrides are reported and setOverride refuses to write, keeping bytes intact", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    const localPath = join(dir, "maas-overrides.json");
    const bridge = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });

    // 本机缺失 → public；本机合法 → local。
    assert.deepEqual(await bridge.overridesState(), { overrides: {}, source: "public" });
    await writeFile(localPath, JSON.stringify({ [CID_A]: "maas" }));
    assert.deepEqual(await bridge.overridesState(), { overrides: { [CID_A]: "maas" }, source: "local" });

    for (const corrupt of [`{"${CID_A}": "maas", `, "[]", "null"]) {
      await writeFile(localPath, corrupt);
      const before = await readFile(localPath);
      assert.deepEqual(await bridge.overridesState(), { overrides: {}, source: "corrupt" });
      assert.deepEqual(await bridge.setOverride(CID_B, "non_maas"), { ok: false, error: "overrides_corrupt" });
      assert.deepEqual(await bridge.setOverride(CID_A, "unconfirmed"), { ok: false, error: "overrides_corrupt" });
      assert.ok(before.equals(await readFile(localPath)), "损坏文件字节在写尝试后保持不变");
    }
  });
});

test("setOverride rejects cids containing control characters instead of stripping them", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    const bridge = createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW });
    for (const cid of [`${CID_A}\u0000`, `99\u000700001`, `${CID_A}\u007f`, `\u001b${CID_A}`]) {
      assert.deepEqual(await bridge.setOverride(cid, "maas"), { ok: false, error: "invalid_cid" });
    }
    assert.deepEqual(await bridge.overrides(), {}, "被拒绝的 cid 一个都没有落盘");
  });
});

test("candidates still returns the computed file when persisting the artifact fails", async () => {
  await withCache(async (dir) => {
    await writeSyntheticSnapshot(dir);
    // 产物路径被目录占用 → rename 失败；结果照常返回，失败交给 onPersistError 记录。
    await mkdir(join(dir, "maas-candidates.json"));
    const persistErrors: unknown[] = [];
    const bridge = createMaasBridge({ cacheDir: dir, now: () => NOW, onPersistError: (error) => persistErrors.push(error) });
    const file = await bridge.candidates();
    assert.ok(file);
    assert.deepEqual(file.candidates.map((candidate) => candidate.cid), [CID_A]);
    assert.equal(persistErrors.length, 1);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), [], "失败的原子写清理 tmp");

    const router = createLocalRouter({ port: 8000, maasBridge: bridge });
    const response = await router(new Request("http://127.0.0.1:8000/local/crm/maas-candidates", {
      headers: { host: "127.0.0.1:8000" },
    }));
    assert.equal(response.status, 200, "写盘失败不得把已算结果变成 500");
  });
});

test("router maps corrupt overrides to 409, exposes the source and rejects control-char cids", async () => {
  await withCache(async (dir) => {
    const publicPath = join(dir, "public-overrides.json");
    await writeFile(publicPath, JSON.stringify({}));
    const localPath = join(dir, "maas-overrides.json");
    const router = createLocalRouter({
      port: 8000,
      maasBridge: createMaasBridge({ cacheDir: dir, publicOverridesPath: publicPath, now: () => NOW }),
    });
    const headers = { host: "127.0.0.1:8000", "content-type": "application/json" };
    const post = (body: unknown) => router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }));

    const control = await post({ cid: `${CID_A}\u0001`, status: "maas" });
    assert.equal(control.status, 400);
    assert.equal(((await control.json()) as { error: string }).error, "invalid_request");

    await writeFile(localPath, "{oops");
    const state = await router(new Request("http://127.0.0.1:8000/local/crm/maas-overrides", { headers }));
    assert.deepEqual(((await state.json()) as { data: unknown }).data, { overrides: {}, source: "corrupt" });

    const refused = await post({ cid: CID_A, status: "maas" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "overrides_corrupt");
    assert.equal(await readFile(localPath, "utf-8"), "{oops");
  });
});
