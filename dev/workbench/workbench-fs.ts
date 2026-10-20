import { access, lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 只读文件系统端口（npm run init / doctor 专用）：
 * exists / list 只回答存在性与元数据（名字、类型、权限位），readFile 仅用于
 * 读取仓库内清单（package.json）。.env.local、.local-cache/ 下个人文件的
 * 内容一律不读——检查行只报「存在 / 已设置」，绝不出现值。
 */

export interface WorkbenchEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
  /** 原始 mode；权限检查只使用 & 0o777 的部分。 */
  readonly mode: number;
}

export interface WorkbenchFs {
  readonly exists: (path: string) => Promise<boolean>;
  readonly readFile: (path: string) => Promise<string>;
  /** 列目录条目（不递归、不读内容）；目录不存在或不可读时抛错。 */
  readonly list: (dir: string) => Promise<readonly WorkbenchEntry[]>;
}

/** 默认实现：包一层 node:fs/promises，供 CLI 入口与缺省参数使用；测试注入假实现。 */
export function createNodeWorkbenchFs(): WorkbenchFs {
  return {
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (path) => readFile(path, "utf-8"),
    list: async (dir) => {
      const dirents = await readdir(dir, { withFileTypes: true });
      return Promise.all(
        dirents.map(async (dirent): Promise<WorkbenchEntry> => {
          const stats = await lstat(join(dir, dirent.name));
          const kind = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
          return { name: dirent.name, kind, mode: stats.mode };
        }),
      );
    },
  };
}
