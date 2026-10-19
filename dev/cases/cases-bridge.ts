import { loadCasesConfig, DEFAULT_CASES_CONFIG_PATH } from "./cases-config.ts";
import { createCasesCodeChannel } from "./cases-code.ts";
import { createDefaultCasesRunner, type CasesCommandRunner } from "./cases-cli.ts";
import { createCasesOssChannel } from "./cases-oss.ts";
import { mergeRawCases } from "./cases-model.ts";
import type {
  CasesChannelId,
  CasesChannelResult,
  CasesChannelStatus,
  CasesConfig,
  CasesOssSpec,
  CasesRepoSpec,
  CasesSnapshot,
} from "./cases-types.ts";

/**
 * Published-cases ledger bridge (F3) — read-only fan-out over the two channels.
 * Ported semantics from base/sa-workbench tools/fetch/cases_fetch.js:
 * - 缺配置 / 坏 JSON → configured:false，如实降级，不抛错、不造数据；
 * - 单渠道 CLI 缺失或失败只影响该渠道，last-error 如实放进 channel note；
 * - 只读：不写任何仓库/桶，投影白名单字段，绝不携带配置细节。
 */

export const MAX_CASES = 200;

export interface CasesBridgeOptions {
  readonly configPath?: string;
  readonly now?: () => number;
  readonly run?: CasesCommandRunner;
  readonly a1Bin?: string;
  readonly ossutilBin?: string;
}

export interface CasesBridge {
  readonly snapshot: () => Promise<CasesSnapshot>;
}

const unconfigured = (note: string): CasesChannelStatus => ({ state: "unconfigured", note, count: 0 });

function channelView(result: CasesChannelResult): CasesChannelStatus {
  return { state: result.state, note: result.note, count: result.raws.length };
}

/** 单渠道失败只影响该渠道：异常降级为该渠道的 last-error，绝不拖垮另一渠道。 */
async function safeChannel(call: () => Promise<CasesChannelResult>): Promise<CasesChannelResult> {
  try {
    return await call();
  } catch (error) {
    const note = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").trim().slice(0, 200);
    return { state: "error", note: note || "渠道执行失败", raws: [] };
  }
}

export function createCasesBridge(options: CasesBridgeOptions = {}): CasesBridge {
  const configPath = options.configPath ?? DEFAULT_CASES_CONFIG_PATH;
  const now = options.now ?? Date.now;
  const run = options.run ?? createDefaultCasesRunner();
  const a1Bin = options.a1Bin ?? process.env.A1_BIN ?? "a1";
  const ossutilBin = options.ossutilBin ?? process.env.OSSUTIL_BIN ?? "ossutil";
  const codeChannel = createCasesCodeChannel({ run, a1Bin });
  const ossChannel = createCasesOssChannel({ run, ossutilBin });

  return {
    snapshot: async (): Promise<CasesSnapshot> => {
      const fetchedAt = new Date(now()).toISOString();
      const config: CasesConfig | null = await loadCasesConfig(configPath);
      if (!config) {
        return {
          configured: false,
          cases: [],
          channels: {
            code: unconfigured("未配置 .local-cache/cases.json（参考 config/cases.json.example）"),
            oss: unconfigured("未配置 .local-cache/cases.json（参考 config/cases.json.example）"),
          },
          fetchedAt,
        };
      }
      const hasCode = config.repos.length > 0;
      const hasOss = config.oss !== null;
      if (!hasCode && !hasOss) {
        return {
          configured: false,
          cases: [],
          channels: { code: unconfigured("未配置 code.repos"), oss: unconfigured("未配置 oss.bucket") },
          fetchedAt,
        };
      }

      const [code, oss] = await Promise.all([
        hasCode
          ? safeChannel(() => codeChannel.fetch(config.repos as readonly CasesRepoSpec[], config.codeExclude))
          : Promise.resolve({ state: "unconfigured", note: "未配置 code.repos", raws: [] } satisfies CasesChannelResult),
        hasOss
          ? safeChannel(() => ossChannel.fetch(config.oss as CasesOssSpec))
          : Promise.resolve({ state: "unconfigured", note: "未配置 oss.bucket", raws: [] } satisfies CasesChannelResult),
      ]);

      return {
        configured: true,
        cases: mergeRawCases([...code.raws, ...oss.raws], config.aliases, config.custAliases).slice(0, MAX_CASES),
        channels: { code: channelView(code), oss: channelView(oss) } satisfies Record<CasesChannelId, CasesChannelStatus>,
        fetchedAt,
      };
    },
  };
}
