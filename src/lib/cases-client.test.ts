import assert from "node:assert/strict";
import test from "node:test";

import {
  CasesClientError,
  casesErrorMessage,
  fetchPublishedCases,
  safeCaseUrl,
  type CasesSnapshot,
} from "./cases-client.ts";

// 合成数据：甲科技 / 乙股份，绝无真实客户数据。

function snapshotPayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      configured: true,
      fetchedAt: "2026-10-19T08:00:00.000Z",
      cases: [
        {
          id: "c0a1b2c3d4",
          name: "甲科技-门店AI",
          title: "甲科技 门店 AI 方案",
          cust: "甲科技",
          updatedAt: "2026-10-12T10:00:00+08:00",
          entryUrl: "https://deck.example.com/%E7%94%B2/index.html",
          srcs: ["oss", "code"],
          pageCount: 2,
        },
        {
          id: "c0b2c3d4e5",
          name: "乙股份-供应链",
          title: "",
          cust: "",
          updatedAt: "",
          entryUrl: "javascript:alert(1)",
          srcs: ["code"],
          pageCount: 1,
        },
      ],
      channels: {
        code: { state: "ok", note: "", count: 2 },
        oss: { state: "error", note: "ossutil CLI 不可用（未安装或不在 PATH）", count: 0 },
      },
    },
  };
}

test("fetchPublishedCases GETs /local/cases and validates the snapshot shape", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(snapshotPayload());
  };

  const snapshot: CasesSnapshot = await fetchPublishedCases(fetchImpl);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.cases.length, 2);
  assert.equal(snapshot.cases[0]!.title, "甲科技 门店 AI 方案");
  assert.equal(snapshot.cases[0]!.cust, "甲科技");
  assert.deepEqual(snapshot.cases[0]!.srcs, ["oss", "code"]);
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "http://localhost/local/cases");
  assert.ok(captured?.signal instanceof AbortSignal, "requests carry a timeout signal");
  assert.equal(snapshot.channels.code.state, "ok");
  assert.equal(snapshot.channels.oss.state, "error");
  assert.match(snapshot.channels.oss.note, /ossutil/);

  // 坏形状（cases 缺失 / channels 缺失）→ invalid_response，不产出半真半假的列表。
  const malformed: typeof fetch = async () => Response.json({ ok: true, data: { configured: true } });
  await assert.rejects(
    () => fetchPublishedCases(malformed),
    (error: unknown) => error instanceof CasesClientError && error.code === "invalid_response",
  );
});

test("bridge 500 and offline degrade to safe codes with honest guidance copy", async () => {
  const serverError: typeof fetch = async () => Response.json({ ok: false, error: "cases_unavailable" }, { status: 500 });
  await assert.rejects(
    () => fetchPublishedCases(serverError),
    (error: unknown) => error instanceof CasesClientError && error.code === "cases_unavailable",
  );

  const unknownError: typeof fetch = async () => Response.json({ ok: false }, { status: 503 });
  await assert.rejects(
    () => fetchPublishedCases(unknownError),
    (error: unknown) => error instanceof CasesClientError && error.code === "unavailable",
  );

  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => fetchPublishedCases(offline),
    (error: unknown) => error instanceof CasesClientError && error.code === "unavailable",
  );

  try {
    await fetchPublishedCases(offline);
    assert.fail("must reject");
  } catch (error) {
    assert.match(casesErrorMessage(error), /本地桥未启动/);
    assert.match(casesErrorMessage(error), /npm run dev:function/);
  }
  assert.match(casesErrorMessage(new CasesClientError("cases_unavailable")), /案例台账/);
  assert.match(casesErrorMessage(new Error("boom")), /本地桥未启动/);
});

test("safeCaseUrl only lets http(s) through", () => {
  assert.equal(safeCaseUrl("https://deck.example.com/a/index.html"), "https://deck.example.com/a/index.html");
  assert.equal(safeCaseUrl("HTTP://DECK.EXAMPLE.COM/A"), "HTTP://DECK.EXAMPLE.COM/A");
  assert.equal(safeCaseUrl("javascript:alert(1)"), "");
  assert.equal(safeCaseUrl("data:text/html,<b>x</b>"), "");
  assert.equal(safeCaseUrl(" file:///etc/passwd "), "");
  assert.equal(safeCaseUrl(""), "");
  assert.equal(safeCaseUrl(undefined as unknown as string), "");
});
