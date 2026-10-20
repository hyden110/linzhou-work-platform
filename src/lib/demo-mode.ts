/**
 * 演示模式（设置页，V2）：遮挡判定纯函数 + localStorage 状态存取。
 *
 * 语义移植自 base/sa-workbench assets/components/demo-mode.js（只搬语义不搬代码）：
 * - 默认关；状态持久化 localStorage，刷新后保持（求值期同步落 html 类，先于首帧无闪帧）。
 * - 遮挡判定只认字段类别，不猜内容：customer / amount / uid 三类敏感，plain 永不遮挡。
 * - DOM 呈现交给 CSS（settings.css：html.demo-on 下的 .demo-mask 与 [data-demo-field] 契约），
 *   本模块只负责「要不要遮」「状态存取」与订阅广播，不重写文本、不遍历 DOM。
 * - 真值仍在 DOM（blur 不是删除）：演示期间不交出屏幕控制权（静态版同款口径）。
 */

export type DemoFieldKind = "customer" | "amount" | "uid" | "plain";

/** 敏感字段类别（演示模式下需要遮挡的三类）。 */
export const SENSITIVE_FIELD_KINDS: readonly DemoFieldKind[] = ["customer", "amount", "uid"];

/** localStorage 键：值只可能是 "1"（开）或不存在（关），绝不写入其他内容。 */
export const DEMO_MODE_STORAGE_KEY = "sa.settings.demo.v1";

/** 落在 <html> 上的开关类名：settings.css 据此对已挂钩的数据区做遮挡。 */
export const DEMO_MODE_DOCUMENT_CLASS = "demo-on";

/** 最小存储接口（与 localStorage 同形，便于测试注入合成实现）。 */
export interface DemoStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 最小 document 契约（只需 documentElement.classList.toggle）。 */
export interface DemoDocumentLike {
  documentElement: { classList: { toggle(token: string, force?: boolean): boolean } };
}

const SENSITIVE_KIND_SET: ReadonlySet<string> = new Set<string>(SENSITIVE_FIELD_KINDS);

/** 遮挡判定：关闭时一律不遮；开启时仅 customer / amount / uid 三类敏感字段遮挡。 */
export function shouldMask(fieldKind: DemoFieldKind, enabled: boolean): boolean {
  if (!enabled) return false;
  return SENSITIVE_KIND_SET.has(fieldKind);
}

/** 读取开关：只认精确 "1"；无存储 / 抛错 / 垃圾值一律按关闭处理（默认关）。 */
export function readDemoMode(storage: DemoStorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DEMO_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写入开关：开 = 写 "1"，关 = 删键（存储里只有 set/unset 两种形态，不落其他值）。 */
export function writeDemoMode(storage: DemoStorageLike | null | undefined, enabled: boolean): void {
  if (!storage) return;
  try {
    if (enabled) storage.setItem(DEMO_MODE_STORAGE_KEY, "1");
    else storage.removeItem(DEMO_MODE_STORAGE_KEY);
  } catch {
    /* 隐私模式等存储不可用：本会话内的开关状态仍由订阅广播与 React state 承载 */
  }
}

/** 把开关落到 <html> 类上（CSS 钩子的唯一开关位）；无 DOM 环境静默跳过。 */
export function applyDemoModeDocumentClass(
  enabled: boolean,
  doc: DemoDocumentLike | null | undefined,
): void {
  if (!doc) return;
  try {
    doc.documentElement.classList.toggle(DEMO_MODE_DOCUMENT_CLASS, enabled);
  } catch {
    /* 合成/异常 document：安全降级，不阻塞开关 */
  }
}

export type DemoModeListener = (enabled: boolean) => void;

/* 订阅表用不可变数组 + 重绑方式维护（不做原地增删）。 */
let listeners: readonly DemoModeListener[] = [];

/** 订阅开关变化；返回退订函数（可安全重复调用）。 */
export function subscribeDemoMode(listener: DemoModeListener): () => void {
  listeners = [...listeners, listener];
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners = listeners.filter((item) => item !== listener);
  };
}

function notifyDemoMode(enabled: boolean): void {
  for (const listener of listeners) {
    try {
      listener(enabled);
    } catch {
      /* 单个订阅者异常不拖垮广播 */
    }
  }
}

/** 总入口：落库 + 落 html 类 + 广播订阅者，一次完成（设置页开关与顶栏徽标共用）。 */
export function setDemoMode(
  storage: DemoStorageLike | null | undefined,
  doc: DemoDocumentLike | null | undefined,
  enabled: boolean,
): void {
  writeDemoMode(storage, enabled);
  applyDemoModeDocumentClass(enabled, doc);
  notifyDemoMode(enabled);
}

function browserStorage(): DemoStorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function browserDocument(): DemoDocumentLike | null {
  if (typeof document === "undefined") return null;
  return document;
}

/** 浏览器环境：读 localStorage → 同步 html 类（App 引入本模块即生效）；返回当前开关态。 */
export function syncDemoModeDocumentClass(): boolean {
  const enabled = readDemoMode(browserStorage());
  applyDemoModeDocumentClass(enabled, browserDocument());
  return enabled;
}

/* 求值期同步落 html 类：先于首帧绘制、刷新后遮挡立即生效无闪帧（静态版同款口径；
 * node 测试环境无 localStorage/document，两个 typeof 守卫使其安全跳过）。 */
syncDemoModeDocumentClass();
