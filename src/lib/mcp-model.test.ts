import assert from "node:assert/strict";
import test from "node:test";

import {
  auditActionLabel,
  checkStatusMeta,
  connectorHeadline,
  connectorOpLabel,
  keyStatusOf,
  MCP_SCOPE_OPTIONS,
  prettyJsonOrNull,
  serviceHeadline,
  transportLabel,
  type McpConnectorItem,
  type McpKeyViewItem,
  type McpServiceSnapshot,
} from "./mcp-model.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：key 名一律 synth-*、hashPrefix 只用合成十六进制；零 I/O 纯函数断言。
// ---------------------------------------------------------------------------

function synthKey(overrides: Partial<McpKeyViewItem> = {}): McpKeyViewItem {
  return {
    id: 1,
    name: "synth-key",
    hashPrefix: "0123abcd",
    scopes: ["meta"],
    createdAt: "2026-10-20T02:30:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    note: "",
    ...overrides,
  };
}

function synthService(overrides: Partial<McpServiceSnapshot> = {}): McpServiceSnapshot {
  return {
    enabled: false,
    tools: 4,
    toolNames: ["mcp_service_state", "mcp_key_list", "mcp_connector_list", "mcp_audit_tail"],
    scopes: ["service", "keys", "connectors", "meta"],
    keys: { active: 2, revoked: 1 },
    keyViews: [synthKey()],
    auditTail: [],
    rpcMounted: false,
    ...overrides,
  };
}

function synthConnector(overrides: Partial<McpConnectorItem> = {}): McpConnectorItem {
  return {
    name: "synth-stdio",
    transport: "stdio",
    disabled: false,
    valid: true,
    effective: true,
    sources: ["workbench"],
    command: "~/bin/synth-node",
    args: ["synth-server.js", "--port", "0"],
    exists: true,
    ...overrides,
  };
}

test("MCP_SCOPE_OPTIONS mirrors the bridge whitelist order", () => {
  assert.deepEqual(MCP_SCOPE_OPTIONS.map((o) => o.value), ["service", "keys", "connectors", "meta"]);
  for (const opt of MCP_SCOPE_OPTIONS) {
    assert.ok(opt.label && opt.hint, "每个 scope 都有可展示 label 与 hint");
  }
});

test("checkStatusMeta maps the seven statuses to honest labels and tones", () => {
  assert.deepEqual(checkStatusMeta("ok"), { label: "正常", tone: "mint" });
  assert.deepEqual(checkStatusMeta("down"), { label: "不可达", tone: "danger" });
  assert.deepEqual(checkStatusMeta("error"), { label: "异常", tone: "danger" });
  assert.deepEqual(checkStatusMeta("unauthorized"), { label: "未授权", tone: "amber" });
  assert.deepEqual(checkStatusMeta("disabled"), { label: "已禁用", tone: "dim" });
  assert.deepEqual(checkStatusMeta("unconfigured"), { label: "未配置", tone: "dim" });
  assert.deepEqual(checkStatusMeta("skipped"), { label: "未体检", tone: "dim" });
  const unknown = checkStatusMeta("synth-weird");
  assert.equal(unknown.label, "synth-weird", "未知枚举原样回显（诚实，不猜）");
  assert.equal(unknown.tone, "dim");
});

test("auditActionLabel translates known actions and echoes unknown ones", () => {
  assert.equal(auditActionLabel("key_created"), "创建 key");
  assert.equal(auditActionLabel("key_revoked"), "吊销 key");
  assert.equal(auditActionLabel("service_toggle"), "服务开关");
  assert.equal(auditActionLabel("connector_write"), "连接器写入");
  assert.equal(auditActionLabel("connector_check"), "连接器体检");
  assert.equal(auditActionLabel("rpc_call"), "RPC 调用");
  assert.equal(auditActionLabel("synth_unknown"), "synth_unknown", "未知动作原样回显");
  assert.equal(auditActionLabel(""), "未知动作");
});

test("transportLabel and connectorOpLabel cover every enum value", () => {
  assert.equal(transportLabel("stdio"), "stdio（本地进程）");
  assert.equal(transportLabel("http"), "HTTP");
  assert.equal(transportLabel("sse"), "SSE");
  assert.equal(transportLabel("unknown"), "未知");
  assert.equal(transportLabel("synth-x"), "synth-x");
  assert.equal(connectorOpLabel("set"), "写入定义");
  assert.equal(connectorOpLabel("enable"), "启用");
  assert.equal(connectorOpLabel("disable"), "禁用");
  assert.equal(connectorOpLabel("remove"), "移除");
  assert.equal(connectorOpLabel("synth-x"), "synth-x");
});

test("keyStatusOf only trusts revokedAt", () => {
  assert.equal(keyStatusOf(synthKey()), "active");
  assert.equal(keyStatusOf(synthKey({ revokedAt: "2026-10-20T03:00:00.000Z" })), "revoked");
});

test("serviceHeadline states enabled/tools/keys honestly", () => {
  assert.equal(serviceHeadline(synthService()), "服务已关闭 · 4 个只读工具 · 2 个有效 key（1 已吊销）");
  assert.equal(
    serviceHeadline(synthService({ enabled: true, keys: { active: 0, revoked: 0 } })),
    "服务已开启 · 4 个只读工具 · 0 个有效 key（0 已吊销）",
  );
});

test("connectorHeadline shows masked command or url per transport", () => {
  assert.equal(connectorHeadline(synthConnector()), "stdio · ~/bin/synth-node synth-server.js --port");
  assert.equal(
    connectorHeadline(synthConnector({ transport: "sse", command: undefined, args: undefined, url: "https://mcp.synth.example/sse/***" })),
    "sse · https://mcp.synth.example/sse/***",
  );
  assert.equal(
    connectorHeadline(synthConnector({ transport: "unknown", command: undefined, args: undefined })),
    "未知 · 定义不完整（缺 command / url）",
  );
});

test("prettyJsonOrNull pretty-prints valid JSON and never fabricates", () => {
  assert.equal(prettyJsonOrNull(null), null);
  assert.equal(prettyJsonOrNull('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJsonOrNull("not-json"), "not-json", "解析失败原样回显（诚实）");
});
