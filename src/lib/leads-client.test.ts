import assert from "node:assert/strict";
import test from "node:test";

import {
  LeadsClientError,
  fetchLeadsSnapshot,
  leadsAgeHours,
  leadsErrorMessage,
  refreshLeads,
  type LeadsSnapshot,
} from "./leads-client.ts";

// 合成数据：企业「甲科技有限公司 / 乙股份有限公司」等均为合成线索，
// 绝无真实 baseId/tableId、真实企业与任何联系人/凭据信息。

function snapshotPayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      configured: true,
      hasData: true,
      configNote: "",
      note: "",
      fetchedAt: "2026-10-20T02:00:00.000Z",
      tableName: "拓新企业清单",
      url: "https://alidocs.dingtalk.com/i/nodes/example-base?entrance=data&sheetId=example-table",
      radarAt: "2026-10-19T22:00:00.000Z",
      radarCmd: "",
      priorityProvinces: ["北京", "山东"],
      total: 2,
      rows: [
        {
          id: "rec-1",
          name: "甲科技有限公司",
          legal: "甲科技（合成）有限公司",
          crmName: "甲科技",
          tierLabel: "A",
          tier: "A",
          crmState: "A-试点",
          score: 82,
          priority: "P1",
          province: "北京",
          city: "北京",
          track: "AI Infra/算力",
          trackRaw: "算力调度",
          summary: "GPU 调度方案进入试点，一句话概述。",
          signal: "融资",
          round: "A+轮",
          amount: "2亿元",
          investors: "合成资本",
          maas: "高",
          maasWhy: "训练算力需求明确",
          maasProduct: "百炼",
          agent: "中",
          agentWhy: "客服场景",
          risk: "竞品已进入",
          aliRel: "已有专有云合作",
          sales: "合成跟进人",
          team: "合成团队",
          uids: 3,
          cid: "CID-SYN-001",
          ecid: "ECID-SYN-001",
          mentions: 5,
          signalAt: "2026-10-19",
          radarAt: "2026-10-19T22:00:00.000Z",
          news: { t: "合成资讯标题", u: "https://example.com/news" },
          sources: "雷达",
          founded: "2019-01-01",
          regCap: "1000万",
          address: "合成市合成路 1 号",
          founder: "合成创始人",
          website: "https://jia-synthetic.example.com",
          entStatus: "存续",
          isPriority: true,
        },
        {
          id: "rec-2",
          name: "乙股份有限公司",
          legal: "",
          crmName: "",
          tierLabel: "pending",
          tier: "pending",
          crmState: "未导入",
          score: null,
          priority: "",
          province: "浙江",
          city: "杭州",
          track: "Agent/智能体",
          trackRaw: "智能体平台",
          summary: "",
          signal: "",
          round: "",
          amount: "",
          investors: "",
          maas: "",
          maasWhy: "",
          maasProduct: "",
          agent: "",
          agentWhy: "",
          risk: "",
          aliRel: "",
          sales: "",
          team: "",
          uids: null,
          cid: "CID-SYN-002",
          ecid: "",
          mentions: null,
          signalAt: "2026-10-18",
          radarAt: "",
          news: null,
          sources: "",
          founded: "",
          regCap: "",
          address: "",
          founder: "",
          website: "",
          entStatus: "",
          isPriority: false,
        },
      ],
    },
  };
}

test("fetchLeadsSnapshot GETs /local/leads and projects rows onto the whitelist shape", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(snapshotPayload());
  };

  const snapshot: LeadsSnapshot = await fetchLeadsSnapshot(fetchImpl);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.hasData, true);
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.tableName, "拓新企业清单");
  assert.equal(snapshot.fetchedAt, "2026-10-20T02:00:00.000Z");
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0]!.name, "甲科技有限公司");
  assert.equal(snapshot.rows[0]!.tier, "A");
  assert.equal(snapshot.rows[0]!.score, 82);
  assert.equal(snapshot.rows[0]!.news?.t, "合成资讯标题");
  assert.equal(snapshot.rows[1]!.tier, "pending");
  assert.equal(snapshot.rows[1]!.score, null);
  assert.equal(snapshot.rows[1]!.isPriority, false);
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "http://localhost/local/leads");
  assert.ok(captured?.signal instanceof AbortSignal, "requests carry a timeout signal");

  // 白名单投影：上行多带的联系人字段（电话/邮箱/法定代表人）与 apiKey 物理不可达结果对象。
  const payload = snapshotPayload() as { data: { rows: Array<Record<string, unknown>> } };
  payload.data.rows[0]!.电话 = "13800001111";
  payload.data.rows[0]!.邮箱 = "leak@example.com";
  payload.data.rows[0]!.法定代表人 = "泄漏人";
  payload.data.rows[0]!.apiKey = "sk-sentinel-should-not-leak-0123456789";
  const leaked: typeof fetch = async () => Response.json(payload);
  const guarded = await fetchLeadsSnapshot(leaked);
  const serialized = JSON.stringify(guarded);
  assert.equal(serialized.includes("13800001111"), false, "联系人字段不得进入客户端结果");
  assert.equal(serialized.includes("leak@example.com"), false, "邮箱字段不得进入客户端结果");
  assert.equal(serialized.includes("sk-sentinel-should-not-leak"), false, "白名单投影丢弃未知字段");

  // 未配置机器：configured:false 照常返回，引导文案随行。
  const unconfigured: typeof fetch = async () => Response.json({
    ok: true,
    data: {
      configured: false, hasData: false,
      configNote: "未配置 .local-cache/leads.json（参考 config/leads.json.example）",
      note: "", fetchedAt: "", tableName: "", url: "", radarAt: "", radarCmd: "",
      priorityProvinces: [], total: 0, rows: [],
    },
  });
  const empty = await fetchLeadsSnapshot(unconfigured);
  assert.equal(empty.configured, false);
  assert.match(empty.configNote, /leads\.json/);

  // 坏形状（rows 缺失）→ invalid_response，绝不半真半假。
  const malformed: typeof fetch = async () => Response.json({ ok: true, data: { configured: true } });
  await assert.rejects(
    () => fetchLeadsSnapshot(malformed),
    (error: unknown) => error instanceof LeadsClientError && error.code === "invalid_response",
  );
});

test("refreshLeads POSTs /local/leads/refresh and surfaces unconfigured, guardrail and upstream codes", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: {
        summary: { total: 2, open: 1, radarAt: "2026-10-19T22:00:00.000Z", fetchedAt: "2026-10-20T03:00:00.000Z" },
        snapshot: snapshotPayload().data,
      },
    });
  };

  const result = await refreshLeads(fetchImpl);
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.url, "http://localhost/local/leads/refresh");
  assert.equal(result.summary.total, 2);
  assert.equal(result.snapshot.rows.length, 2);

  const post = (status: number, body: unknown): typeof fetch => async () => Response.json(body, { status });
  await assert.rejects(
    () => refreshLeads(post(400, { ok: false, error: "leads_unconfigured" })),
    (error: unknown) => error instanceof LeadsClientError && error.code === "leads_unconfigured",
  );
  // 护栏拒绝：409 + 稳定错误码如实透传（带 message 供面板展示）。
  await assert.rejects(
    () => refreshLeads(post(409, { ok: false, error: "leads_shrink", message: "AI 表格记录数由 12 降至 3，拒绝覆盖旧快照" })),
    (error: unknown) => error instanceof LeadsClientError && error.code === "leads_shrink",
  );
  await assert.rejects(
    () => refreshLeads(post(502, { ok: false, error: "leads_unavailable" })),
    (error: unknown) => error instanceof LeadsClientError && error.code === "leads_unavailable",
  );
  // 未知错误码不透传，降级为 unavailable。
  await assert.rejects(
    () => refreshLeads(post(500, { ok: false, error: "totally_unknown" })),
    (error: unknown) => error instanceof LeadsClientError && error.code === "unavailable",
  );
});

test("offline bridge degrades to safe codes with guidance copy, and leadsAgeHours flags stale snapshots", async () => {
  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => fetchLeadsSnapshot(offline),
    (error: unknown) => error instanceof LeadsClientError && error.code === "unavailable",
  );
  try {
    await fetchLeadsSnapshot(offline);
    assert.fail("must reject");
  } catch (error) {
    assert.match(leadsErrorMessage(error), /本地桥未启动/);
    assert.match(leadsErrorMessage(error), /npm run dev:function/);
  }
  assert.match(
    leadsErrorMessage(new LeadsClientError("leads_unconfigured")),
    /\.local-cache\/leads\.json/,
  );
  assert.match(leadsErrorMessage(new LeadsClientError("leads_shrink")), /拒绝覆盖/);
  assert.match(leadsErrorMessage(new LeadsClientError("leads_unavailable")), /拓新/);

  // 24h 过旧提示：纯函数给出小时龄，坏时间返回 null（不猜）。
  assert.equal(leadsAgeHours("2026-10-19T02:00:00.000Z", Date.parse("2026-10-20T02:00:00.000Z")), 24);
  assert.equal(leadsAgeHours("", Date.parse("2026-10-20T02:00:00.000Z")), null);
  assert.equal(leadsAgeHours("not-a-date", Date.parse("2026-10-20T02:00:00.000Z")), null);
});
