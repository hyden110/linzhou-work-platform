/**
 * 客户端错误文案组合（共享工具）。
 *
 * 背景：桥返回的 error.message 与客户端按错误码给出的友好文案，常常是同一句话的
 * 两种说法（例：profile_no_session / confirm_mismatch / dws_missing）。直接
 * `${base} ${detail}` 拼接会在页面上出现复读句。这里按「首句（第一个 。或 ：之前）
 * 相同即视为同一句」去重，只保留 base；首句不同（base 是概括、detail 是桥侧具体原因）
 * 才把 detail 追加到后面，保证信息不丢也不复读。
 */

function firstSentence(text: string): string {
  const cut = text.search(/[。：]/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

export function composeErrorMessage(base: string, detail: string | null | undefined): string {
  const trimmed = (detail ?? "").trim();
  if (!trimmed) return base;
  if (firstSentence(trimmed) === firstSentence(base)) return base;
  if (base.includes(trimmed) || trimmed.includes(base)) return base;
  return `${base} ${trimmed}`;
}
