import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  AGENTLOOP_TICKET_HOST,
  AGENTLOOP_TICKET_TTL_SEC,
  buildResource,
  buildStringToSign,
  maskAccessKey,
  maskTicket,
  sanitizeUpstreamDetail,
  signHmacSha1,
  validateCredentials,
} from "./agentloop-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：AK/SK/票据一律合成串（synthAk* / synthSk* / synth-ticket-*），
// 日期固定 FIXED_DATE（2026-10-20T02:30:00Z 的 GMT 形态）；零网络、零子进程。
// 签名黄金向量由 node:crypto 独立预计算后写死（见各用例注释），防签名口径漂移。
// ---------------------------------------------------------------------------

const FIXED_DATE = "Tue, 20 Oct 2026 02:30:00 GMT";
const SYNTH_AK = "LTAIsynthAk0001";
const SYNTH_SK = "synthSk0000000000000000000001";

// ---------------------------------------------------------------------------
// 1. 掩码口径（donor maskAk：≤8 位留前 2，其余前 4 + **** + 后 4）
// ---------------------------------------------------------------------------

test("maskAccessKey follows donor maskAk shape and never leaks the middle", () => {
  assert.equal(maskAccessKey(SYNTH_AK), "LTAI****0001");
  assert.equal(maskAccessKey("LTAI1234567890abcd"), "LTAI****abcd");
  assert.equal(maskAccessKey("ab123456"), "ab****", "8 位短 AK 只留前 2");
  assert.equal(maskAccessKey("abc"), "ab****", "更短也不整串透出");
  assert.equal(maskAccessKey(""), "****", "空值安全");
  assert.ok(!maskAccessKey(SYNTH_AK).includes("synth"), "掩码不含中段原文");
});

test("maskTicket keeps only head 4 + tail 4", () => {
  assert.equal(maskTicket("synth-ticket-value-0001"), "synth-ticket-value-0001".length > 8 ? "synt****0001" : "synt****0001");
  assert.equal(maskTicket("abcdefgh12345678"), "abcd****5678");
  assert.equal(maskTicket("short"), "sh****", "短票只留前 2");
  assert.equal(maskTicket(""), "****");
});

// ---------------------------------------------------------------------------
// 2. 凭据形态校验（donor validate：AK 10–64 字母数字，SK 24–64 字母数字）
// ---------------------------------------------------------------------------

test("validateCredentials accepts donor-shaped pairs and rejects everything else", () => {
  assert.equal(validateCredentials(SYNTH_AK, SYNTH_SK), "", "合法对通过");
  assert.equal(validateCredentials("LTAI5tAbCdEf1234", "abcdefghij0123456789ABCDEF"), "");
  assert.ok(validateCredentials("synth-ak-0001", SYNTH_SK).length > 0, "带连字符的 AK 不合法（donor 口径）");
  assert.ok(validateCredentials("short", SYNTH_SK).includes("AccessKey ID"), "AK 过短报 AK 原因");
  assert.ok(validateCredentials(SYNTH_AK, "tooshort").includes("AccessKey Secret"), "SK 过短报 SK 原因");
  assert.ok(validateCredentials(SYNTH_AK, "synth-sk-with-dashes-000001").includes("AccessKey Secret"));
  assert.ok(validateCredentials("", "").includes("AccessKey ID"));
  assert.ok(validateCredentials(null, undefined).includes("AccessKey ID"), "非字符串如实拒绝");
  assert.ok(validateCredentials("A".repeat(65), SYNTH_SK).includes("AccessKey ID"), "超 64 位拒绝");
  assert.ok(!validateCredentials(SYNTH_AK, SYNTH_SK).length, "合法时无原因文案");
  // 原因文案绝不回显输入值
  const reason = validateCredentials("synth-ak-0001", "bad synth secret");
  assert.ok(!reason.includes("synth-ak-0001"));
  assert.ok(!reason.includes("bad synth secret"));
});

// ---------------------------------------------------------------------------
// 3. 资源串与待签串（donor slsFetch：键排序 + encodeURIComponent；canonical headers 固定两行）
// ---------------------------------------------------------------------------

test("buildResource sorts query keys and encodes values", () => {
  assert.equal(buildResource("/tickets", { expirationTime: AGENTLOOP_TICKET_TTL_SEC }), "/tickets?expirationTime=86400");
  assert.equal(buildResource("/logstores"), "/logstores", "无查询不带 ?");
  assert.equal(buildResource("/x", { b: "2", a: "1" }), "/x?a=1&b=2", "键排序");
  assert.equal(buildResource("/x", { q: "a b&c=d" }), "/x?q=a%20b%26c%3Dd", "值编码");
});

test("buildStringToSign matches donor canonical form (golden vectors)", () => {
  // 黄金向量：node:crypto 独立预计算（见任务记录），任何口径漂移都会在此断言失败。
  const ticketSts = buildStringToSign({
    method: "POST",
    date: FIXED_DATE,
    resource: "/tickets?expirationTime=86400",
  });
  assert.equal(
    ticketSts,
    "POST\n\n\nTue, 20 Oct 2026 02:30:00 GMT\nx-log-apiversion:0.6.0\nx-log-signaturemethod:hmac-sha1\n/tickets?expirationTime=86400",
  );
  const listSts = buildStringToSign({ method: "GET", date: FIXED_DATE, resource: "/logstores" });
  assert.equal(
    listSts,
    "GET\n\n\nTue, 20 Oct 2026 02:30:00 GMT\nx-log-apiversion:0.6.0\nx-log-signaturemethod:hmac-sha1\n/logstores",
  );
  // 带 body/contentType 时 md5 参与（donor 口径），此处只验装配位置正确
  const withBody = buildStringToSign({
    method: "POST",
    date: FIXED_DATE,
    resource: "/x",
    body: "{}",
    contentType: "application/json",
  });
  const lines = withBody.split("\n");
  assert.equal(lines[0], "POST");
  assert.equal(lines[1], "99914b932bd37a50b983c5e7c90ae93b", "第二行是 body 的 md5 hex（{} 的固定值）");
  assert.equal(lines[2], "application/json");
  assert.equal(lines[3], FIXED_DATE);
});

test("signHmacSha1 produces the pinned golden signatures", () => {
  const ticketSts =
    "POST\n\n\nTue, 20 Oct 2026 02:30:00 GMT\nx-log-apiversion:0.6.0\nx-log-signaturemethod:hmac-sha1\n/tickets?expirationTime=86400";
  const listSts =
    "GET\n\n\nTue, 20 Oct 2026 02:30:00 GMT\nx-log-apiversion:0.6.0\nx-log-signaturemethod:hmac-sha1\n/logstores";
  assert.equal(signHmacSha1(ticketSts, SYNTH_SK), "zbzi09cfd46GvZp+ZVMjotFiwDk=");
  assert.equal(signHmacSha1(listSts, SYNTH_SK), "eeeZdZ1TH+xKdW6E/ep74CmlvWg=");
  // 与 node:crypto 现算一致（交叉验证）
  assert.equal(signHmacSha1(ticketSts, SYNTH_SK), createHmac("sha1", SYNTH_SK).update(ticketSts).digest("base64"));
});

// ---------------------------------------------------------------------------
// 4. 上游详情脱敏截断（凭据形态串不出桥）
// ---------------------------------------------------------------------------

test("sanitizeUpstreamDetail redacts credential-shaped text and bounds length", () => {
  const detail = sanitizeUpstreamDetail(`AccessKeyId=LTAI5tRealish0001 secret ${SYNTH_SK} 出错了`);
  assert.ok(!detail.includes("LTAI5tRealish0001"), "AK 形态串被脱敏");
  assert.ok(!detail.includes(SYNTH_SK), "SK 形态串被脱敏");
  assert.ok(detail.includes("出错了"), "普通原因保留");
  assert.equal(sanitizeUpstreamDetail("字".repeat(500)).length, 200, "默认截 200 字");
  assert.equal(sanitizeUpstreamDetail("字".repeat(50), 10).length, 10);
  assert.equal(sanitizeUpstreamDetail("a".repeat(50)), "aa****", "≥24 位连续字母数字按 SK 形态脱敏");
  assert.equal(sanitizeUpstreamDetail("  多行\n  空白\t折叠 "), "多行 空白 折叠", "折空白");
  assert.equal(sanitizeUpstreamDetail(""), "", "空输入安全");
});

// ---------------------------------------------------------------------------
// 5. 常量口径（donor 对齐）
// ---------------------------------------------------------------------------

test("constants pin donor SLS semantics", () => {
  assert.equal(AGENTLOOP_TICKET_HOST, "cn-shanghai.log.aliyuncs.com");
  assert.equal(AGENTLOOP_TICKET_TTL_SEC, 86_400);
});
