import assert from "node:assert/strict";
import test from "node:test";

import {
  OPS_WECHAT_BATCH_MAX,
  OpsClientError,
  opsErrorMessage,
  previewOpsPush,
  registerOpsWechatLinks,
  sendOpsPush,
  shouldDiscardPushPreview,
} from "./ops-client.ts";

// 全部为合成数据：不出现真实链接、接收人 ID 或密钥。
const PREVIEW = {
  mode: "dry_run",
  generatedAt: "2026-10-18T04:00:00.000Z",
  date: "2026-10-18",
  cardTitle: "运营推广日报 · 2026-10-18",
  cardText: "## 运营推广日报 · 2026-10-18\n\n今日共 1 条运营讯息。",
  entryCount: 1,
  receiverConfigured: true,
  previewId: "0123456789abcdef",
  note: "dry-run 预览：未实际发送。",
};

test("previewOpsPush posts an explicit dry-run and never sends", async () => {
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
    return Response.json({ ok: true, data: PREVIEW }, { status: 202 });
  };
  const preview = await previewOpsPush(fetchImpl);
  assert.equal(preview.mode, "dry_run");
  assert.equal(preview.previewId, "0123456789abcdef");
  assert.match(seen[0]!.url, /\/local\/ops\/push$/);
  assert.equal(seen[0]!.method, "POST");
  assert.deepEqual(JSON.parse(seen[0]!.body!), { dryRun: true }, "dry-run must never carry confirm");
});

test("sendOpsPush posts confirm with the minted previewId", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), body: String(init?.body) });
    return Response.json({ ok: true, data: { ...PREVIEW, mode: "sent" } }, { status: 200 });
  };
  const sent = await sendOpsPush("0123456789abcdef", fetchImpl);
  assert.equal(sent.mode, "sent");
  assert.match(seen[0]!.url, /\/local\/ops\/push$/);
  assert.deepEqual(
    JSON.parse(seen[0]!.body),
    { confirm: true, previewId: "0123456789abcdef" },
    "real sends must echo confirm + the dry-run previewId",
  );
});

test("push errors surface as safe readable codes", async () => {
  const cases: ReadonlyArray<{ status: number; error: string; message: string }> = [
    { status: 400, error: "preview_required", message: "缺少确认参数" },
    { status: 409, error: "preview_stale", message: "预览已过期" },
    { status: 400, error: "push_disabled", message: "总开关未开启" },
    { status: 400, error: "recipient_not_configured", message: "未配置接收人" },
    { status: 500, error: "push_failed", message: "推送命令执行失败" },
    { status: 502, error: "push_uncertain", message: "结果未知" },
    { status: 409, error: "push_in_progress", message: "正在发送中" },
    { status: 409, error: "preview_consumed", message: "已被确认发送过" },
  ];
  for (const { status, error, message } of cases) {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: false, error }, { status });
    await assert.rejects(() => sendOpsPush("0123456789abcdef", fetchImpl), (thrown: unknown) => {
      assert.ok(thrown instanceof OpsClientError);
      assert.equal(thrown.code, error);
      assert.match(opsErrorMessage(thrown), new RegExp(message));
      return true;
    });
  }
});

test("registerOpsWechatLinks posts every given url once (no dedupe of its own) and keeps partial failures isolated", async () => {
  const posts: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { url: string };
    posts.push(`${init?.method} ${url} ${body.url}`);
    if (!url.includes("/local/ops/wechat-links")) {
      // 任何指向非本机登记端点的请求都视为测试失败。
      return Response.json({ ok: false, error: "unexpected_external_request" }, { status: 599 });
    }
    if (body.url === "https://mp.weixin.qq.com/s/broken1") {
      return Response.json({ ok: false, error: "invalid_url" }, { status: 400 });
    }
    return Response.json({
      ok: true,
      data: {
        id: `w-${posts.length}`,
        url: body.url,
        registeredAt: "2026-10-18T04:00:00.000Z",
        status: "registered",
        note: "仅登记",
        title: null,
      },
    }, { status: 201 });
  };

  const raw = [
    "https://mp.weixin.qq.com/s/okOne1",
    "https://mp.weixin.qq.com/s/okOne1", // 重复 → 只登记一次
    "https://mp.weixin.qq.com/s/broken1",
  ].join("\n");
  const entries = await registerOpsWechatLinks(["https://mp.weixin.qq.com/s/okOne1", "https://mp.weixin.qq.com/s/okOne1", "https://mp.weixin.qq.com/s/broken1"], fetchImpl);
  assert.equal(entries.length, 3, "input order preserved; dedupe is splitWechatLinks' job, the loop registers every entry given");
  assert.ok(entries[0]!.link && entries[1]!.link);
  assert.equal(entries[2]!.link, null);
  assert.match(entries[2]!.error ?? "", /链接格式无效/);
  // 只调用了本机登记端点：3 个输入 → 3 次 POST（重复 url 也各调一次），没有任何外部请求。
  assert.equal(posts.length, 3);
  assert.ok(posts.every((post) => post.includes("/local/ops/wechat-links")));

  // splitWechatLinks 负责去重：批量入口只对去重后的列表逐条调用。
  const { valid, invalid } = await import("./ops-model.ts").then((model) => model.splitWechatLinks(raw));
  assert.deepEqual(valid, ["https://mp.weixin.qq.com/s/okOne1", "https://mp.weixin.qq.com/s/broken1"]);
  assert.deepEqual(invalid, []);
});

test("shouldDiscardPushPreview drops the local preview only for stale, consumed or outcome-unknown previews", () => {
  assert.equal(shouldDiscardPushPreview(new OpsClientError("preview_stale")), true);
  assert.equal(shouldDiscardPushPreview(new OpsClientError("preview_consumed")), true);
  // 超时结果未知：同一预览不可再确认，丢弃以强制重新预览。
  assert.equal(shouldDiscardPushPreview(new OpsClientError("push_uncertain")), true);
  // 发送失败/在途/配置问题：预览仍有效，保留以便用户显式重试或排查。
  for (const code of ["push_failed", "push_in_progress", "push_disabled", "recipient_not_configured", "unavailable"]) {
    assert.equal(shouldDiscardPushPreview(new OpsClientError(code)), false, code);
  }
  assert.equal(shouldDiscardPushPreview(new Error("preview_stale")), false);
});

function syntheticLinks(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://mp.weixin.qq.com/s/jiaKeji${index}`);
}

test("registerOpsWechatLinks refuses batches over the cap before sending any request", async () => {
  assert.equal(OPS_WECHAT_BATCH_MAX, 50);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
  };
  await assert.rejects(() => registerOpsWechatLinks(syntheticLinks(OPS_WECHAT_BATCH_MAX + 1), fetchImpl), (thrown: unknown) => {
    assert.ok(thrown instanceof OpsClientError);
    assert.equal(thrown.code, "batch_too_large");
    assert.match(opsErrorMessage(thrown), /单次最多登记 50 条/);
    return true;
  });
  assert.equal(calls, 0, "an oversized batch must not hit the local endpoint at all");
});

test("registerOpsWechatLinks accepts exactly the cap", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { url: string };
    return Response.json({
      ok: true,
      data: { id: `w-${calls}`, url: body.url, registeredAt: "2026-10-18T04:00:00.000Z", status: "registered", note: "仅登记", title: null },
    }, { status: 201 });
  };
  const entries = await registerOpsWechatLinks(syntheticLinks(OPS_WECHAT_BATCH_MAX), fetchImpl);
  assert.equal(entries.length, OPS_WECHAT_BATCH_MAX);
  assert.equal(calls, OPS_WECHAT_BATCH_MAX);
  assert.ok(entries.every((entry) => entry.link !== null));
});
