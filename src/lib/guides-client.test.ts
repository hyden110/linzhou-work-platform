import assert from "node:assert/strict";
import test from "node:test";

import {
  GuidesClientError,
  actGuideStep,
  checkGuideStep,
  fetchGuides,
  guidesErrorMessage,
} from "./guides-client.ts";

// 合成数据：指引/步骤/命令均为合成值；敌意字段用于验证白名单投影。

function defsPayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      version: "2026-10-17",
      guides: [
        {
          id: "dws", t: "钉钉 DWS 接入", d: "总前置", kind: "base",
          steps: [
            { id: "bin", kind: "check", t: "检测 dws CLI", check: { type: "bin", name: "dws" }, fix: { cmd: "", terminal: true, label: "随 Qoder 安装" } },
            { id: "auth", kind: "action", t: "钉钉授权登录", action: { type: "terminal", cmd: "dws auth login" }, secret: "hostile-synthetic" },
            { id: "done", kind: "done", t: "接入完成" },
          ],
        },
        {
          id: "aitable-leads", t: "拓新雷达", d: "建表", kind: "aitable", schemas: ["leads"], cap: "leads",
          steps: [
            { id: "provision", kind: "action", t: "一键建表", action: { type: "aitable-provision", schemas: ["leads"] }, needConfirm: true, confirm: "将创建表。继续？" },
          ],
        },
      ],
    },
  };
}

test("fetchGuides GETs /local/guides and projects steps onto the whitelist", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(defsPayload());
  };
  const view = await fetchGuides(fetchImpl);
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "http://localhost/local/guides");
  assert.equal(view.version, "2026-10-17");
  assert.equal(view.guides.length, 2);
  const dws = view.guides[0]!;
  assert.deepEqual(dws.steps.map((s) => s.id), ["bin", "auth", "done"]);
  assert.equal(dws.steps[1]?.action?.cmd, "dws auth login");
  assert.equal(dws.steps[1]?.action?.type, "terminal");
  const provision = view.guides[1]!.steps[0]!;
  assert.equal(provision.needConfirm, true);
  assert.match(provision.confirm, /继续？/);
  assert.deepEqual(provision.action?.schemas, ["leads"]);
  assert.ok(!JSON.stringify(view).includes("hostile-synthetic"), "白名单投影必须丢弃多余字段");
});

test("checkGuideStep POSTs {guide,step} and projects the check result", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: { guide: "aitable-leads", step: "verify", state: "fail", detail: "leads：缺少接入配置", results: [{ id: "leads", ok: false, note: "缺少接入配置 leads.json" }] },
    });
  };
  const result = await checkGuideStep("aitable-leads", "verify", fetchImpl);
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.url, "http://localhost/local/guide/check");
  assert.deepEqual(JSON.parse(await (captured?.text() ?? "{}")) as unknown, { guide: "aitable-leads", step: "verify" });
  assert.equal(result.state, "fail");
  assert.equal(result.results?.[0]?.ok, false);

  const badState: typeof fetch = async () => Response.json({ ok: true, data: { guide: "g", step: "s", state: "maybe", detail: "" } });
  await assert.rejects(
    () => checkGuideStep("g", "s", badState),
    (error: unknown) => error instanceof GuidesClientError && error.code === "invalid_response",
  );
});

test("actGuideStep: terminal command echo; provision confirm strictly opt-in; confirm_required surfaced with text", async () => {
  let captured: Request | undefined;
  const terminalFetch: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true, data: { ok: true, terminal: true, command: "dws auth login", note: "请在本机终端执行后回来点「重新检测」" } });
  };
  const result = await actGuideStep("dws", "auth", {}, terminalFetch);
  assert.equal(captured?.url, "http://localhost/local/guide/act");
  assert.deepEqual(JSON.parse(await (captured?.text() ?? "{}")) as unknown, { guide: "dws", step: "auth" });
  assert.equal(result.terminal, true);
  assert.equal(result.command, "dws auth login");
  assert.match(result.note, /重新检测/);

  // 未勾选确认 → 请求体不带 confirm:true；桥回 400 confirm_required（含确认文案）。
  const confirmFetch: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(
      { ok: false, error: { code: "guides_confirm_required", message: "需要二次确认", needConfirm: true, confirm: "将创建表。继续？" } },
      { status: 400 },
    );
  };
  await assert.rejects(
    () => actGuideStep("aitable-leads", "provision", {}, confirmFetch),
    (error: unknown) => {
      if (!(error instanceof GuidesClientError)) return false;
      assert.equal(error.code, "guides_confirm_required");
      assert.match(error.confirmText, /继续？/);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(await (captured?.text() ?? "{}")) as unknown, { guide: "aitable-leads", step: "provision" });

  // 勾选确认 → 请求体带严格布尔 confirm:true；provision 结果白名单投影。
  const provisionFetch: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: {
        ok: true,
        provision: {
          ok: true, baseId: "basSynthetic01", baseName: "SA 工作台数据",
          plan: [{ schemaId: "leads", tableName: "拓新企业清单", action: "created-with-base" }],
          configs: [{ id: "leads", file: "leads.json", tableCount: 1, missing: [] }],
          token: "hostile-synthetic-token",
        },
      },
    });
  };
  const provisioned = await actGuideStep("aitable-leads", "provision", { confirm: true }, provisionFetch);
  assert.deepEqual(JSON.parse(await (captured?.text() ?? "{}")) as unknown, { guide: "aitable-leads", step: "provision", confirm: true });
  assert.equal(provisioned.provision?.baseId, "basSynthetic01");
  assert.equal(provisioned.provision?.configs[0]?.file, "leads.json");
  assert.ok(!JSON.stringify(provisioned).includes("hostile-synthetic-token"));
  assert.match(guidesErrorMessage(new GuidesClientError("guides_busy")), /正在进行/);
});
