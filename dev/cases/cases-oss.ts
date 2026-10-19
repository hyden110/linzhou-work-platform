import { cliErrorNote, type CasesCommandRunner } from "./cases-cli.ts";
import { caseKey, encodePath, fileTitle, groupUnits, safeEntryUrl } from "./cases-model.ts";
import type { CasesChannelResult, CasesOssSpec, RawCase } from "./cases-types.ts";

/**
 * OSS 渠道（bin:ossutil，只读）：`ossutil ls -r` 拉发布桶文件清单，按一级目录
 * 分组为案例，入口 URL = publicBase + 编码后路径（对外可分享范围，红线提示
 * 由 UI 层固定展示）。绝不读对象正文 —— 最近发布取文件 mtime，标题取文件名归一。
 */

const LS_TIMEOUT_MS = 120_000;
const OSSUTIL_NOT_FOUND = "ossutil CLI 不可用（未安装或不在 PATH）";

/* 参考实现同一正则：日期 时间 时区 大小 etag oss://bucket/key */
const LS_LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) \S+\s+(\d+)\s+\S+\s+([0-9A-Fa-f-]+)\s+oss:\/\/[^/\s]+\/(.+)$/;

export interface OssListedFile {
  readonly path: string;
  readonly mtime: string;
}

export function parseOssLs(text: string): OssListedFile[] {
  const out: OssListedFile[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = LS_LINE.exec(line.trim());
    if (match && !match[7]!.endsWith("/")) {
      out.push({ path: match[7]!, mtime: `${match[1]}T${match[2]}${match[3]}:${match[4]}` });
    }
  }
  return out;
}

export interface CasesOssChannelOptions {
  readonly run: CasesCommandRunner;
  readonly ossutilBin: string;
}

export function createCasesOssChannel(options: CasesOssChannelOptions) {
  const { run, ossutilBin } = options;
  return {
    id: "oss" as const,
    fetch: async (spec: CasesOssSpec): Promise<CasesChannelResult> => {
      const result = await run(ossutilBin, ["ls", `oss://${spec.bucket}`, "-r"], { timeoutMs: LS_TIMEOUT_MS });
      if (result.code === "ENOENT") throw new Error(OSSUTIL_NOT_FOUND);
      if (result.code !== 0 && result.code !== null) throw new Error(`ossutil ls 失败：${cliErrorNote(result)}`);
      const listed = parseOssLs(result.stdout).filter((file) => /\.html?$/i.test(file.path));
      if (!listed.length) throw new Error("ossutil ls 未解析到 html（输出格式变化？）");
      const units = groupUnits(listed, { mode: "collection", exclude: spec.exclude });
      const publicBase = spec.publicBase || `https://${spec.bucket}.oss-cn-beijing.aliyuncs.com`;
      const raws: RawCase[] = units.map((unit) => ({
        key: caseKey(unit.name),
        name: unit.name,
        title: fileTitle(unit.entry.path) || unit.name,
        updatedAt: unit.updatedAt,
        url: safeEntryUrl(`${publicBase}/${encodePath(unit.entry.path)}`),
        src: "oss",
        pageCount: unit.files.length,
      }));
      return { state: "ok", note: "", raws };
    },
  };
}
