import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileRegistry, type ResolvedFile } from "./local-files.ts";
import { createLocalRouter, type LocalRouterDependencies } from "./local-router.ts";
import { seriesIdFor } from "./solution-store.ts";

interface Fixture {
  readonly root: string;
  readonly statePath: string;
  readonly highlightsPath: string;
  readonly cleanup: () => Promise<void>;
}

const DOC_ID = "aaaaaaaaaaaaaaaa";
const OUTSIDE_ID = "bbbbbbbbbbbbbbbb";
const SYMLINK_ID = "cccccccccccccccc";
const BINARY_ID = "dddddddddddddddd";
const MARKDOWN_ID = "eeeeeeeeeeeeeeee";
const HIGHLIGHTS_ID = "yunqi-2026-highlights";

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "sa-local-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(join(root, "nested"), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, "deck.pptx"), "pptx-bytes");
  await writeFile(join(root, "notes.md"), "# 标题\n\n正文");
  await writeFile(join(root, "report.pdf"), "%PDF-1.4 fake");
  await writeFile(join(outside, "secret.pdf"), "outside-bytes");
  await symlink(join(outside, "secret.pdf"), join(root, "nested", "link.pdf"));

  const statePath = join(base, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      roots: [{ id: "cases", label: "案例库", absolutePath: root }],
      documents: [
        { id: DOC_ID, source: "cases", relativePath: "deck.pptx" },
        { id: OUTSIDE_ID, source: "cases", relativePath: "../outside/secret.pdf" },
        { id: SYMLINK_ID, source: "cases", relativePath: "nested/link.pdf" },
        { id: BINARY_ID, source: "cases", relativePath: "report.pdf" },
        { id: MARKDOWN_ID, source: "cases", relativePath: "notes.md" },
        { id: "ffffffffffffffff", source: "unknown-root", relativePath: "deck.pptx" },
      ],
    }),
    "utf-8",
  );

  const highlightsPath = join(base, "highlights.json");
  await writeFile(
    highlightsPath,
    JSON.stringify({
      stats: { layers: 6 },
      source: {
        id: HIGHLIGHTS_ID,
        title: "云栖大会整理",
        relativePath: "云栖/highlights.html",
        absolutePath: join(root, "云栖/highlights.html"),
      },
    }),
    "utf-8",
  );
  await mkdir(join(root, "云栖"), { recursive: true });
  await writeFile(join(root, "云栖/highlights.html"), "<html></html>");

  return { root, statePath, highlightsPath, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function createTestRouter(fixture: Fixture, opened: ResolvedFile[] = [], extra: Partial<LocalRouterDependencies> = {}) {
  const registry = createFileRegistry({
    statePath: fixture.statePath,
    highlightsPath: fixture.highlightsPath,
  });
  const router = createLocalRouter({
    port: 8000,
    registry,
    highlightsPath: fixture.highlightsPath,
    solutionsDir: join(fixture.statePath, "..", "solutions"),
    openFile: async (resolved) => {
      opened.push(resolved);
      return { ok: true };
    },
    ...extra,
  });
  return { router, registry, opened };
}

const TRUSTED = { host: "127.0.0.1:8000" };

function get(path: string, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method: "GET", headers: { ...TRUSTED, ...headers } });
}

function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method: "POST",
    headers: { ...TRUSTED, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("rejects untrusted hosts and origins", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture);
    const rebound = await router(get("/local/status", { host: "attacker.example:8000" }));
    assert.equal(rebound.status, 403);
    assert.equal((await rebound.json() as { error: string }).error, "host_not_allowed");

    const crossOrigin = await router(get("/local/status", { origin: "https://attacker.example" }));
    assert.equal(crossOrigin.status, 403);

    const allowed = await router(get("/local/status", { origin: "http://127.0.0.1:4173" }));
    assert.equal(allowed.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("opens a registered document through its opaque id only", async () => {
  const fixture = await createFixture();
  try {
    const { router, opened } = createTestRouter(fixture);
    const response = await router(post("/local/open", { id: DOC_ID }));
    const payload = await response.json() as { ok: boolean; data: { extension: string; preview: boolean } };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.extension, "PPTX");
    assert.equal(payload.data.preview, false);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.absolutePath, join(await realpath(fixture.root), "deck.pptx"));
    assert.equal(Object.hasOwn(payload.data as object, "absolutePath"), false);
    assert.deepEqual(Object.keys(payload.data).sort(), ["bytes", "extension", "id", "preview"]);
  } finally {
    await fixture.cleanup();
  }
});

test("refuses traversal, symlinks, unknown roots and unknown ids", async () => {
  const fixture = await createFixture();
  try {
    const { router, opened } = createTestRouter(fixture);
    for (const id of [OUTSIDE_ID, SYMLINK_ID, "ffffffffffffffff", "0000000000000000", "../../etc/passwd", ""]) {
      const response = await router(post("/local/open", { id }));
      assert.ok(response.status === 404 || response.status === 400, `${id} -> ${response.status}`);
    }
    assert.equal(opened.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("previews markdown and pdf inline but refuses office formats", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture);

    const markdown = await router(get(`/local/preview?id=${MARKDOWN_ID}`));
    assert.equal(markdown.status, 200);
    assert.equal(markdown.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(markdown.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await markdown.text(), "# 标题\n\n正文");

    const pdf = await router(get(`/local/preview?id=${BINARY_ID}`));
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(new TextDecoder().decode(await pdf.arrayBuffer()), "%PDF-1.4 fake");

    const office = await router(get(`/local/preview?id=${DOC_ID}`));
    assert.equal(office.status, 415);

    const missing = await router(get("/local/preview?id=0000000000000000"));
    assert.equal(missing.status, 404);
  } finally {
    await fixture.cleanup();
  }
});

test("serves highlights without leaking the absolute source path", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture);
    const response = await router(get("/local/highlights"));
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.equal(text.includes(fixture.root), false);
    assert.equal(text.includes("absolutePath"), false);
    const payload = JSON.parse(text) as { data: { source: Record<string, unknown> } };
    assert.equal(payload.data.source.id, HIGHLIGHTS_ID);

    const opened = await router(post("/local/open", { id: HIGHLIGHTS_ID }));
    assert.equal(opened.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("rate limits bursts and rejects unsupported methods", async () => {
  const fixture = await createFixture();
  try {
    const registry = createFileRegistry({
      statePath: fixture.statePath,
      highlightsPath: fixture.highlightsPath,
    });
    let clock = 1_000;
    const router = createLocalRouter({
      port: 8000,
      registry,
      highlightsPath: fixture.highlightsPath,
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
      now: () => clock,
      openFile: async () => ({ ok: true }),
    });

    assert.equal((await router(get("/local/status"))).status, 200);
    assert.equal((await router(get("/local/status"))).status, 200);
    const limited = await router(get("/local/status"));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");

    clock += 61_000;
    assert.equal((await router(get("/local/status"))).status, 200);

    const deleted = await router(new Request("http://127.0.0.1:8000/local/status", {
      method: "DELETE",
      headers: TRUSTED,
    }));
    assert.equal(deleted.status, 405);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects oversized and non-JSON open payloads", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture);
    const huge = new Request("http://127.0.0.1:8000/local/open", {
      method: "POST",
      headers: { ...TRUSTED, "content-type": "application/json" },
      body: JSON.stringify({ id: DOC_ID, padding: "x".repeat(4096) }),
    });
    assert.equal((await router(huge)).status, 400);

    const wrongType = new Request("http://127.0.0.1:8000/local/open", {
      method: "POST",
      headers: { ...TRUSTED, "content-type": "text/plain" },
      body: DOC_ID,
    });
    assert.equal((await router(wrongType)).status, 400);
  } finally {
    await fixture.cleanup();
  }
});

test("registry cache follows state file changes", async () => {
  const fixture = await createFixture();
  try {
    const { registry } = createTestRouter(fixture);
    assert.ok(await registry.resolve(DOC_ID));

    await writeFile(fixture.statePath, JSON.stringify({ roots: [], documents: [] }), "utf-8");
    const bumped = new Date(Date.now() + 5_000);
    await utimes(fixture.statePath, bumped, bumped);

    assert.equal(await registry.resolve(DOC_ID), undefined);
  } finally {
    await fixture.cleanup();
  }
});

const SOLUTION_KEY = {
  customer: "某区域零售集团",
  industry: "零售与消费",
  goal: "建设面向门店经营的 AI 助手",
  constraints: "数据不出域",
};

const SOLUTION_PLAN = {
  engine: "qoder-cli" as const,
  title: "门店 AI 助手方案",
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
};

const SOLUTION_RETRIEVAL = {
  status: "results-only" as const,
  vectorSearch: "keyword-only" as const,
  resultCount: 12,
  queries: ["门店经营 AI 助手"],
};

function fakeAssistant(requestId: string): LocalRouterDependencies["solutionAssistant"] {
  return async () => ({
    plan: SOLUTION_PLAN,
    retrieval: SOLUTION_RETRIEVAL,
    input: { requestId, ...SOLUTION_KEY },
  });
}

function del(path: string, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method: "DELETE", headers: { ...TRUSTED, ...headers } });
}

test("archives every generated plan as a new version of its series", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture, [], { solutionAssistant: fakeAssistant("req-1") });
    const generated = await router(post("/local/assistant", { requestId: "req-1", ...SOLUTION_KEY }));
    assert.equal(generated.status, 200);

    const listed = await (await router(get("/local/solutions"))).json() as {
      data: { series: Array<{ seriesId: string; versionCount: number; title: string; customer: string }> };
    };
    assert.equal(listed.data.series.length, 1);
    assert.equal(listed.data.series[0]!.seriesId, seriesIdFor(SOLUTION_KEY));
    assert.equal(listed.data.series[0]!.versionCount, 1);
    assert.equal(listed.data.series[0]!.title, SOLUTION_PLAN.title);
    assert.equal(listed.data.series[0]!.customer, SOLUTION_KEY.customer);

    const detail = await (await router(get(`/local/solutions?series=${seriesIdFor(SOLUTION_KEY)}`))).json() as {
      data: { versions: Array<{ version: number; versionId: string; plan: { title: string } }> };
    };
    assert.equal(detail.data.versions.length, 1);
    assert.equal(detail.data.versions[0]!.version, 1);
    assert.equal(detail.data.versions[0]!.plan.title, SOLUTION_PLAN.title);
    assert.equal(detail.data.versions[0]!.versionId.length >= 8, true);

    assert.equal((await router(get("/local/solutions?series=0000000000000000"))).status, 404);
    assert.equal((await router(get("/local/solutions?series=../../etc/passwd"))).status, 404);
    assert.equal((await router(post("/local/solutions", {}))).status, 405);
  } finally {
    await fixture.cleanup();
  }
});

test("deletes a single archived version and validates its ids", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture, [], { solutionAssistant: fakeAssistant("req-2") });
    await router(post("/local/assistant", { requestId: "req-2", ...SOLUTION_KEY }));
    await router(post("/local/assistant", { requestId: "req-3", ...SOLUTION_KEY }));
    const seriesId = seriesIdFor(SOLUTION_KEY);

    const before = await (await router(get(`/local/solutions?series=${seriesId}`))).json() as {
      data: { versions: Array<{ version: number; versionId: string }> };
    };
    assert.deepEqual(before.data.versions.map((version) => version.version), [1, 2]);

    const removed = await router(del(`/local/solutions/${seriesId}/${before.data.versions[0]!.versionId}`));
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json() as { data: { remaining: number } }).data, { remaining: 1 });

    const after = await (await router(get(`/local/solutions?series=${seriesId}`))).json() as {
      data: { versions: Array<{ version: number }> };
    };
    assert.deepEqual(after.data.versions.map((version) => version.version), [1]);

    assert.equal((await router(del(`/local/solutions/not-a-series/${before.data.versions[0]!.versionId}`))).status, 400);
    assert.equal((await router(del(`/local/solutions/${seriesId}/nope`))).status, 400);
  } finally {
    await fixture.cleanup();
  }
});

test("keeps answering when the archive cannot be written", async () => {
  const fixture = await createFixture();
  try {
    const { router } = createTestRouter(fixture, [], {
      solutionAssistant: fakeAssistant("req-4"),
      solutionStore: {
        list: async () => [],
        get: async () => undefined,
        append: async () => { throw new Error("disk full"); },
        remove: async () => 0,
      },
    });
    const response = await router(post("/local/assistant", { requestId: "req-4", ...SOLUTION_KEY }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { ok: boolean; data: { title: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.data.title, SOLUTION_PLAN.title);
  } finally {
    await fixture.cleanup();
  }
});
