import { checkRow, type CheckRow } from "./workbench-types.ts";

/**
 * 环境变量检查：env 只报「已设置 / 未设置」，值物理上不进入任何行。
 * 检查集来自 .env.example 的启用规则：DASHSCOPE_API_KEY（本地 AI，缺失自动
 * 降级为仅关键词召回）与 Qoder Cloud Agents 四键（四者齐备才启用，
 * 否则回退百炼通道）。CLI 入口用 --env-file-if-exists=.env.local 启动，
 * 因此这里看到的口径与 npm run dev:function 实际运行时一致。
 */

export type EnvView = Readonly<Record<string, string | undefined>>;

export const QODER_CHANNEL_KEYS: readonly string[] = [
  "QODER_PAT",
  "QODER_AGENT_ID",
  "QODER_AGENT_VERSION",
  "QODER_ENVIRONMENT_ID",
];

const DASHSCOPE_KEY = "DASHSCOPE_API_KEY";
const QODER_CHANNEL_ROW = "Qoder Cloud Agents 通道";

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function dashscopeRow(env: EnvView): CheckRow {
  if (isSet(env[DASHSCOPE_KEY])) {
    return checkRow("env", DASHSCOPE_KEY, "ok", "已设置（值不显示）");
  }
  return checkRow(
    "env",
    DASHSCOPE_KEY,
    "info",
    "未设置。修法：复制 .env.example 为 .env.local 后填写（缺失时 AI 问答与语义检索自动降级为仅关键词召回，不报错）",
  );
}

function qoderChannelRow(env: EnvView): CheckRow {
  const setKeys = QODER_CHANNEL_KEYS.filter((key) => isSet(env[key]));
  if (setKeys.length === QODER_CHANNEL_KEYS.length) {
    return checkRow("env", QODER_CHANNEL_ROW, "ok", `${setKeys.length}/${QODER_CHANNEL_KEYS.length} 键已设置（值不显示）`);
  }
  if (setKeys.length === 0) {
    return checkRow("env", QODER_CHANNEL_ROW, "info", "未配置（可选通道；缺失时本地 Function 回退百炼通道）");
  }
  const missing = QODER_CHANNEL_KEYS.filter((key) => !isSet(env[key]));
  return checkRow(
    "env",
    QODER_CHANNEL_ROW,
    "warn",
    `仅 ${setKeys.length}/${QODER_CHANNEL_KEYS.length} 键已设置，缺失：${missing.join("、")}`
      + `（四者齐备才启用该通道；值不显示）`,
  );
}

export function envRows(env: EnvView): readonly CheckRow[] {
  return [dashscopeRow(env), qoderChannelRow(env)];
}
