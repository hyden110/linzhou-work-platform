/**
 * 数据源注册表 · 派生层（纯函数）。
 *
 * 数据本体在 datasource-data.ts（TS 移植自 base/sa-workbench datasource-model.js）。
 * 本文件只做只读派生：按 id 查找、按刷新组/通道聚合、健康键展开。
 * 全部函数为纯函数 + 不可变返回，不含 IO、不含凭据值。
 */

import {
  caps,
  channels,
  envSections,
  groups,
  healthGroups,
  sources,
  DATASOURCE_MODEL_VERSION,
  type Capability,
  type Channel,
  type ChannelId,
  type DataSource,
  type EnvSection,
  type HealthGroup,
  type RefreshGroup,
} from "./datasource-data.ts";

export {
  caps,
  channels,
  envSections,
  groups,
  healthGroups,
  sources,
  DATASOURCE_MODEL_VERSION,
};
export type {
  Capability,
  Channel,
  ChannelId,
  ChannelMgmt,
  DataSource,
  EnvLink,
  EnvPlatform,
  EnvSection,
  HealthGroup,
  RefreshGroup,
} from "./datasource-data.ts";

/* ---------- 查找 ---------- */

export function channelOf(id: ChannelId): Channel | undefined {
  return channels.find((c) => c.id === id);
}

export function groupOf(id: string | null | undefined): RefreshGroup | undefined {
  if (!id) return undefined;
  return groups.find((g) => g.id === id);
}

export function capOf(id: string | null | undefined): Capability | undefined {
  if (!id) return undefined;
  return caps.find((c) => c.id === id);
}

export function sourceOf(sys: string): DataSource | undefined {
  return sources.find((s) => s.sys === sys);
}

/* ---------- 聚合派生 ---------- */

/** 全部刷新组 id（含「无组」源所属的 null 不在其中）。 */
export function groupIds(): readonly string[] {
  return groups.map((g) => g.id);
}

/** 全部通道 id，按注册表顺序。 */
export function channelIds(): readonly ChannelId[] {
  return channels.map((c) => c.id);
}

/** 某刷新组内的源（保持注册表顺序）。groupId 为 null 表示「无组」源。 */
export function sourcesOfGroup(groupId: string | null): readonly DataSource[] {
  return sources.filter((s) => s.grp === groupId);
}

/** 某通道涉及的源（ch 数组包含该通道）。 */
export function sourcesOfChannel(channelId: ChannelId): readonly DataSource[] {
  return sources.filter((s) => s.ch.includes(channelId));
}

/** 注册表里出现过的全部健康键（hk 展开、去重、保持出现顺序）。 */
export function healthKeys(): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    for (const k of s.hk ?? []) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/** 某源的健康键（无 hk 即空数组）。 */
export function healthKeysOf(source: DataSource): readonly string[] {
  return source.hk ?? [];
}

/** 某源引用的能力（cap 为 null 或未登记即 undefined）。 */
export function capabilityOf(source: DataSource): Capability | undefined {
  return capOf(source.cap);
}

/* ---------- 校验（开发期自检，供测试使用） ---------- */

export interface RegistryIssue {
  readonly kind: "unknown-group" | "unknown-capability" | "unknown-channel" | "duplicate-sys";
  readonly where: string;
  readonly detail: string;
}

/**
 * 注册表一致性检查：grp/cap/ch 引用的 id 必须已登记、sys 不得重复。
 * 返回空数组即注册表自洽。
 */
export function registryIssues(): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const groupSet = new Set(groups.map((g) => g.id));
  const capSet = new Set(caps.map((c) => c.id));
  const channelSet = new Set<ChannelId>(channels.map((c) => c.id));
  const seenSys = new Set<string>();
  for (const s of sources) {
    if (seenSys.has(s.sys)) {
      issues.push({ kind: "duplicate-sys", where: s.sys, detail: "sys 重复登记" });
    }
    seenSys.add(s.sys);
    if (s.grp !== null && !groupSet.has(s.grp)) {
      issues.push({ kind: "unknown-group", where: s.sys, detail: `刷新组 ${s.grp} 未登记` });
    }
    if (s.cap !== null && !capSet.has(s.cap)) {
      issues.push({ kind: "unknown-capability", where: s.sys, detail: `能力 ${s.cap} 未登记` });
    }
    for (const ch of s.ch) {
      if (!channelSet.has(ch)) {
        issues.push({ kind: "unknown-channel", where: s.sys, detail: `通道 ${ch} 未登记` });
      }
    }
  }
  return issues;
}

/** 环境入口分区数（应为 5）。 */
export function envSectionCount(): number {
  return envSections.length;
}

/** 健康分组数（应为 5：cli/mcp/cookie/agents/skills）。 */
export function healthGroupCount(): number {
  return healthGroups.length;
}

/** 只读汇总，供 UI 顶部指标条使用。 */
export interface RegistrySummary {
  readonly version: string;
  readonly sourceCount: number;
  readonly groupCount: number;
  readonly channelCount: number;
  readonly capCount: number;
  readonly healthGroupCount: number;
}

export function registrySummary(): RegistrySummary {
  return {
    version: DATASOURCE_MODEL_VERSION,
    sourceCount: sources.length,
    groupCount: groups.length,
    channelCount: channels.length,
    capCount: caps.length,
    healthGroupCount: healthGroups.length,
  };
}

/** envSections 里出现过的平台健康键（hkey 非空，去重保序）。 */
export function envHealthKeys(): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sec of envSections) {
    for (const p of sec.platforms) {
      if (p.hkey && !seen.has(p.hkey)) {
        seen.add(p.hkey);
        out.push(p.hkey);
      }
    }
  }
  return out;
}

/* ---------- env 平台配置存在性（只报 set/unset，绝不显值） ---------- */

/**
 * env 平台存在性判定结果：
 *   set         探测行 state=ok（CLI 在位 / env 已设置 / 桥就绪）
 *   unset       探测行 state=unconfigured|missing（未配置 / 未安装）
 *   probe-error 探测行 state=error|unknown（探测失败，不猜）
 *   unprobed    尚无体检快照，或快照里没有该健康键的行（v2 未接探测通道）
 *   no-key      该平台未登记健康键（无独立探测项）
 */
export type EnvPresence = "set" | "unset" | "probe-error" | "unprobed" | "no-key";

/** 体检快照行的最小结构（cli / caps / bridges 三组行都满足）。 */
export interface PresenceRowLike {
  readonly name: string;
  readonly state: string;
}

/**
 * 由体检快照行派生 env 平台配置存在性。rows 为 null 表示尚未探测。
 * 纯函数：只消费行 state 字符串，任何凭据值物理不经过这里。
 */
export function envPresence(hkey: string | null, rows: readonly PresenceRowLike[] | null): EnvPresence {
  if (hkey === null) return "no-key";
  if (rows === null) return "unprobed";
  const row = rows.find((r) => r.name === hkey);
  if (!row) return "unprobed";
  if (row.state === "ok") return "set";
  if (row.state === "unconfigured" || row.state === "missing") return "unset";
  return "probe-error";
}
