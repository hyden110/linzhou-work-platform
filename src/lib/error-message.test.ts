import assert from "node:assert/strict";
import test from "node:test";

import { composeErrorMessage } from "./error-message.ts";

test("空详情原样返回 base", () => {
  assert.equal(composeErrorMessage("本地桥未启动。", ""), "本地桥未启动。");
  assert.equal(composeErrorMessage("本地桥未启动。", null), "本地桥未启动。");
  assert.equal(composeErrorMessage("本地桥未启动。", undefined), "本地桥未启动。");
  assert.equal(composeErrorMessage("本地桥未启动。", "   "), "本地桥未启动。");
});

test("首句相同的桥消息去重，只留 base（profile_no_session / confirm_mismatch 口径）", () => {
  const base = "尚未配置 BUC 会话：请先到「个人中心」粘贴 Cookie 后重试。";
  const detail = "尚未配置 BUC 会话：请先到「个人中心」填写工号并粘贴 Cookie";
  assert.equal(composeErrorMessage(base, detail), base);

  const sendBase = "人工确认未完成：本次没有发送任何消息。请在弹窗中逐条确认后重试。";
  const sendDetail = "人工确认未完成：confirm 必须严格等于候选 id（页面弹窗逐条确认后才发送）。本次未执行任何发送。";
  assert.equal(composeErrorMessage(sendBase, sendDetail), sendBase);
});

test("首句不同时追加详情，信息不丢", () => {
  const base = "OKR 快照刷新失败（CRD 拉取或会话问题），详情见错误信息。";
  const detail = "CRD 返回 401：会话已过期。";
  assert.equal(composeErrorMessage(base, detail), `${base} ${detail}`);
});

test("互为包含时不重复拼接", () => {
  const base = "钉钉发送失败：请到钉钉核对该消息是否已发出，勿盲目重发。";
  assert.equal(composeErrorMessage(base, "钉钉发送失败"), base);
  assert.equal(composeErrorMessage("发送失败", base), "发送失败");
});
