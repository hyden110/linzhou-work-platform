import assert from "node:assert/strict";
import test from "node:test";

import {
  HealthClientError,
  fetchHealthSnapshot,
  healthErrorMessage,
  type HealthSnapshot,
} from "./health-client.ts";

// 合成数据：CLI 名、计数与布尔均为合成值，绝无真实凭据。

function snapshotPayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      ok: true,
      fetchedAt: "2026-10-20T02:00:00.000Z",
      bridges: [
        { name: "crm", state: "ok", detail: "快照就绪" },
        { name: "cases", state: "unconfigured", detail: "未配置 .local-cache/cases.json" },
      ],
      cli: [
        { name: "a1", state: "missing", version: "", note: "未安装。修法：a1 auth login" },
        { name: "qodercli", state: "ok", version: "1.2.3", note: "" },
      ],
      caps: [
        { name: "DASHSCOPE_API_KEY", state: "ok", set: true, note: "已设置（值不入快照）" },
        { name: "OPS_DINGTALK_PUSH_ENABLED", state: "unconfigured", set: false, note: "未设置" },
      ],
    },
  };
}

test("fetchHealthSnapshot GETs /local/health and projects rows onto the whitelist shape", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(snapshotPayload());
  };

  const snapshot: HealthSnapshot = await fetchHealthSnapshot(fetchImpl);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.fetchedAt, "2026-10-20T02:00:00.000Z");
  assert.equal(snapshot.bridges.length, 2);
  assert.equal(snapshot.bridges[0]!.name, "crm");
  assert.equal(snapshot.bridges[0]!.state, "ok");
  assert.equal(snapshot.cli[0]!.state, "missing");
  assert.match(snapshot.cli[0]!.note, /a1 auth login/);
  assert.equal(snapshot.cli[1]!.version, "1.2.3");
  assert.equal(snapshot.caps[0]!.set, true);
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "http://localhost/local/health");
  assert.ok(captured?.signal instanceof AbortSignal, "requests carry a timeout signal");

  // 白名单投影：上行多带的 apiKey 字段物理不可达结果对象。
  const leaked: typeof fetch = async () => Response.json({
    ok: true,
    data: {
      ok: true,
      fetchedAt: "2026-10-20T02:00:00.000Z",
      bridges: [],
      cli: [],
      caps: [{ name: "DASHSCOPE_API_KEY", state: "ok", set: true, note: "", apiKey: "sk-sentinel-should-not-leak" }],
    },
  });
  const guarded = await fetchHealthSnapshot(leaked);
  assert.equal(JSON.stringify(guarded).includes("sk-sentinel-should-not-leak"), false, "whitelist projection drops unknown fields");

  // 坏形状（三组缺失）→ invalid_response，不产出半真半假的面板数据。
  const malformed: typeof fetch = async () => Response.json({ ok: true, data: { ok: true, bridges: [] } });
  await assert.rejects(
    () => fetchHealthSnapshot(malformed),
    (error: unknown) => error instanceof HealthClientError && error.code === "invalid_response",
  );
});

test("bridge 500 and offline degrade to safe codes with honest guidance copy", async () => {
  const serverError: typeof fetch = async () => Response.json({ ok: false, error: "health_unavailable" }, { status: 502 });
  await assert.rejects(
    () => fetchHealthSnapshot(serverError),
    (error: unknown) => error instanceof HealthClientError && error.code === "health_unavailable",
  );

  const unknownError: typeof fetch = async () => Response.json({ ok: false }, { status: 503 });
  await assert.rejects(
    () => fetchHealthSnapshot(unknownError),
    (error: unknown) => error instanceof HealthClientError && error.code === "unavailable",
  );

  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => fetchHealthSnapshot(offline),
    (error: unknown) => error instanceof HealthClientError && error.code === "unavailable",
  );

  try {
    await fetchHealthSnapshot(offline);
    assert.fail("must reject");
  } catch (error) {
    assert.match(healthErrorMessage(error), /本地桥未启动/);
    assert.match(healthErrorMessage(error), /npm run dev:function/);
  }
  assert.match(healthErrorMessage(new HealthClientError("health_unavailable")), /体检/);
  assert.match(healthErrorMessage(new Error("boom")), /本地桥未启动/);
});

test("unknown row states are rejected so the panel never renders fabricated status", async () => {
  const badState: typeof fetch = async () => Response.json({
    ok: true,
    data: {
      ok: true,
      fetchedAt: "2026-10-20T02:00:00.000Z",
      bridges: [{ name: "crm", state: "fabulous", detail: "" }],
      cli: [],
      caps: [],
    },
  });
  await assert.rejects(
    () => fetchHealthSnapshot(badState),
    (error: unknown) => error instanceof HealthClientError && error.code === "invalid_response",
  );
});
