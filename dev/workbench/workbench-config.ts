import { join } from "node:path";

import { checkRow, type CheckRow } from "./workbench-types.ts";
import type { WorkbenchFs } from "./workbench-fs.ts";

/**
 * 配置存在性检查（npm run init / doctor）：.env.local、config/*.json.example
 * 模板、config/ 下误放的个人 JSON、.local-cache/ 目录与各个人配置。
 * 全程只报存在性，绝不读取任何个人文件的内容（.env.local / .local-cache/**）。
 * 语义对应静态版 init.js hintConfigTemplates：配置模板不自动铺设，
 * 缺失 = 未配置 = 对应功能隐藏，行内给「复制 .example」修法提示。
 */

export const CONFIG_DIR = "config";
export const LOCAL_CACHE_DIR = ".local-cache";

const ENV_LOCAL = ".env.local";
const ENV_EXAMPLE = ".env.example";
const TEMPLATE_SUFFIX = ".json.example";

interface ConfigListing {
  readonly readable: boolean;
  /** 模板名去后缀（agents、cases…），即个人配置区列表。 */
  readonly templates: readonly string[];
  /** config/ 下非模板的 *.json——个人配置误放（config/ 会随 git 入库）。 */
  readonly stray: readonly string[];
}

async function readConfigListing(rootDir: string, fs: WorkbenchFs): Promise<ConfigListing> {
  try {
    const entries = await fs.list(join(rootDir, CONFIG_DIR));
    const names = entries.map((entry) => entry.name);
    const templates = names
      .filter((name) => name.endsWith(TEMPLATE_SUFFIX))
      .map((name) => name.slice(0, -TEMPLATE_SUFFIX.length))
      .sort();
    const stray = names.filter((name) => name.endsWith(".json")).sort();
    return { readable: true, templates, stray };
  } catch {
    return { readable: false, templates: [], stray: [] };
  }
}

function envLocalRow(exists: boolean): CheckRow {
  return exists
    ? checkRow("config", ENV_LOCAL, "ok", "已存在（内容不读取）")
    : checkRow(
        "config",
        ENV_LOCAL,
        "info",
        `未创建。修法：复制 ${ENV_EXAMPLE} 为 ${ENV_LOCAL} 后按需填写（已 gitignore；也可直接在终端 export 同名变量）`,
      );
}

function templatesRow(listing: ConfigListing): CheckRow {
  if (!listing.readable) {
    return checkRow("config", "config/*.json.example", "error", `${CONFIG_DIR}/ 目录不可读（仓库模板缺失？）`);
  }
  if (listing.templates.length === 0) {
    return checkRow("config", "config/*.json.example", "error", `${CONFIG_DIR}/ 下没有 *${TEMPLATE_SUFFIX} 模板`);
  }
  const shown = listing.templates.slice(0, 8).join("、") + (listing.templates.length > 8 ? " 等" : "");
  return checkRow("config", "config/*.json.example", "ok", `已入库模板 ${listing.templates.length} 个（${shown}）`);
}

function strayRow(listing: ConfigListing): CheckRow {
  if (listing.stray.length === 0) {
    return checkRow("config", "config/*.json", "ok", `无个人配置误放（${CONFIG_DIR}/ 仅 *${TEMPLATE_SUFFIX} 模板，个人配置放 ${LOCAL_CACHE_DIR}/）`);
  }
  return checkRow(
    "config",
    "config/*.json",
    "warn",
    `${CONFIG_DIR}/ 下有 ${listing.stray.length} 个非模板 JSON（${CONFIG_DIR}/ 会随 git 入库，个人配置请移到 ${LOCAL_CACHE_DIR}/）：${listing.stray.join("、")}`,
  );
}

function cacheDirRow(exists: boolean): CheckRow {
  return exists
    ? checkRow("config", `${LOCAL_CACHE_DIR}/`, "ok", "目录存在（内容不读取，权限见 security 组）")
    : checkRow("config", `${LOCAL_CACHE_DIR}/`, "info", "目录不存在（对应功能首次写入本地缓存时自动创建）");
}

async function areaRow(rootDir: string, area: string, fs: WorkbenchFs): Promise<CheckRow> {
  const target = join(rootDir, LOCAL_CACHE_DIR, `${area}.json`);
  if (await fs.exists(target)) {
    return checkRow("config", `${LOCAL_CACHE_DIR}/${area}.json`, "ok", "已配置（内容不读取）");
  }
  return checkRow(
    "config",
    `${LOCAL_CACHE_DIR}/${area}.json`,
    "info",
    `未配置（可选）。修法：复制 ${CONFIG_DIR}/${area}${TEMPLATE_SUFFIX} 为 ${LOCAL_CACHE_DIR}/${area}.json，按本人情况填写（${LOCAL_CACHE_DIR}/ 已 gitignore）`,
  );
}

export async function configRows(rootDir: string, fs: WorkbenchFs): Promise<readonly CheckRow[]> {
  const listing = await readConfigListing(rootDir, fs);
  const cacheDir = cacheDirRow(await fs.exists(join(rootDir, LOCAL_CACHE_DIR)));
  const head = [envLocalRow(await fs.exists(join(rootDir, ENV_LOCAL))), templatesRow(listing)];
  if (!listing.readable) {
    // 目录不可读：误放检查与个人配置区无法回答，如实跳过（不冒充「无」）。
    return [...head, cacheDir];
  }
  const areas = await Promise.all(listing.templates.map((area) => areaRow(rootDir, area, fs)));
  return [...head, strayRow(listing), cacheDir, ...areas];
}
