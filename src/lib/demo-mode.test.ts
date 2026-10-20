import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_MODE_DOCUMENT_CLASS,
  DEMO_MODE_STORAGE_KEY,
  applyDemoModeDocumentClass,
  readDemoMode,
  setDemoMode,
  shouldMask,
  subscribeDemoMode,
  syncDemoModeDocumentClass,
  writeDemoMode,
} from "./demo-mode.ts";

// 合成数据：本文件不接触任何真实客户名 / 金额 / 账号；存储与 document 均为注入的合成桩。

interface StorageCall {
  readonly op: "get" | "set" | "remove";
  readonly key: string;
  readonly value?: string;
}

/** 合成存储：记录全部调用，可按需抛错模拟隐私模式。 */
function storageStub(initial: Record<string, string> = {}, fail = false) {
  const store = new Map<string, string>(Object.entries(initial));
  const calls: StorageCall[] = [];
  return {
    calls,
    getItem(key: string): string | null {
      calls.push({ op: "get", key });
      if (fail) throw new Error("storage blocked");
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      calls.push({ op: "set", key, value });
      if (fail) throw new Error("storage blocked");
      store.set(key, value);
    },
    removeItem(key: string): void {
      calls.push({ op: "remove", key });
      if (fail) throw new Error("storage blocked");
      store.delete(key);
    },
    raw(): Map<string, string> {
      return store;
    },
  };
}

/** 合成 document：只实现 documentElement.classList.toggle 并记录调用。 */
function documentStub() {
  const toggles: Array<{ token: string; force?: boolean }> = [];
  return {
    toggles,
    documentElement: {
      classList: {
        toggle(token: string, force?: boolean): boolean {
          toggles.push({ token, force });
          return force === true;
        },
      },
    },
  };
}

test("shouldMask: 关闭时任何字段都不遮挡；开启时仅遮挡敏感三类", () => {
  const kinds = ["customer", "amount", "uid", "plain"] as const;
  for (const kind of kinds) {
    assert.equal(shouldMask(kind, false), false, `关闭时 ${kind} 不遮挡`);
  }
  assert.equal(shouldMask("customer", true), true, "客户名遮挡");
  assert.equal(shouldMask("amount", true), true, "金额遮挡");
  assert.equal(shouldMask("uid", true), true, "账号/UID 遮挡");
  assert.equal(shouldMask("plain", true), false, "结构、说明、日期等普通文本永不遮挡");
});

test("readDemoMode: 仅精确 \"1\" 视为开启，其余（含垃圾值/无存储/抛错）一律关闭", () => {
  assert.equal(readDemoMode(undefined), false, "无存储环境降级为关");
  assert.equal(readDemoMode(null), false, "null 存储降级为关");
  assert.equal(readDemoMode(storageStub({ [DEMO_MODE_STORAGE_KEY]: "1" })), true, "精确 1 = 开");
  for (const value of ["0", "true", "on", "yes", " ", "2", "1 "]) {
    assert.equal(
      readDemoMode(storageStub({ [DEMO_MODE_STORAGE_KEY]: value })),
      false,
      `值 ${JSON.stringify(value)} 不算开启（只认精确 "1"）`,
    );
  }
  assert.equal(readDemoMode(storageStub({}, true)), false, "存储抛错降级为关，不外抛");
});

test("writeDemoMode: 开=写 \"1\"，关=删键；存储值只有 set/unset 两种形态", () => {
  const on = storageStub();
  writeDemoMode(on, true);
  assert.equal(on.raw().get(DEMO_MODE_STORAGE_KEY), "1", "开启只写 1");
  assert.equal(readDemoMode(on), true, "写后可读回");

  const off = storageStub({ [DEMO_MODE_STORAGE_KEY]: "1" });
  writeDemoMode(off, false);
  assert.equal(off.raw().has(DEMO_MODE_STORAGE_KEY), false, "关闭删键而非写 0");

  const noop = storageStub();
  writeDemoMode(undefined, true);
  assert.deepEqual(noop.calls, [], "无存储环境静默跳过");

  const blocked = storageStub({}, true);
  assert.doesNotThrow(() => writeDemoMode(blocked, true), "隐私模式不外抛");
});

test("applyDemoModeDocumentClass: toggle 落 html 类；无 document 时静默跳过", () => {
  const doc = documentStub();
  applyDemoModeDocumentClass(true, doc);
  assert.deepEqual(doc.toggles, [{ token: DEMO_MODE_DOCUMENT_CLASS, force: true }]);

  applyDemoModeDocumentClass(false, doc);
  assert.equal(doc.toggles.length, 2, "退出演示模式会再次 toggle 移除类");
  assert.equal(doc.toggles[1]?.force, false);

  assert.doesNotThrow(() => applyDemoModeDocumentClass(true, undefined), "无 DOM 环境安全降级");
  assert.doesNotThrow(() => applyDemoModeDocumentClass(true, null), "null document 安全降级");
});

test("setDemoMode: 存取 + html 类 + 订阅广播一次完成，且只广播一次", () => {
  const storage = storageStub();
  const doc = documentStub();
  const events: boolean[] = [];
  const unsubscribe = subscribeDemoMode((enabled) => events.push(enabled));

  setDemoMode(storage, doc, true);
  assert.equal(storage.raw().get(DEMO_MODE_STORAGE_KEY), "1", "落库");
  assert.deepEqual(doc.toggles, [{ token: DEMO_MODE_DOCUMENT_CLASS, force: true }], "落 html 类");
  assert.deepEqual(events, [true], "订阅者恰收到一次 true");

  setDemoMode(storage, doc, false);
  assert.equal(storage.raw().has(DEMO_MODE_STORAGE_KEY), false, "退出删键");
  assert.equal(doc.toggles.length, 2, "退出移除 html 类");
  assert.deepEqual(events, [true, false], "订阅者再收到一次 false");

  unsubscribe();
  setDemoMode(storage, doc, true);
  assert.deepEqual(events, [true, false], "退订后不再广播");
});

test("subscribeDemoMode: 多订阅者各自收到；重复退订安全", () => {
  const first: boolean[] = [];
  const second: boolean[] = [];
  const offFirst = subscribeDemoMode((enabled) => first.push(enabled));
  const offSecond = subscribeDemoMode((enabled) => second.push(enabled));

  setDemoMode(storageStub(), documentStub(), true);
  assert.deepEqual(first, [true], "订阅者一收到");
  assert.deepEqual(second, [true], "订阅者二收到");

  offFirst();
  offFirst();
  setDemoMode(storageStub(), documentStub(), false);
  assert.deepEqual(first, [true], "退订者不再收到");
  assert.deepEqual(second, [true, false], "未退订者继续收到");
});

test("syncDemoModeDocumentClass: 浏览器环境读库同步 html 类（刷新后保持遮挡）；无 DOM 环境安全", () => {
  // node 测试环境无 localStorage/document：只断言安全降级不抛错。
  assert.doesNotThrow(() => syncDemoModeDocumentClass());
});
