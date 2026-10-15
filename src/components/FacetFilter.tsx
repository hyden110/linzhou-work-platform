import { useMemo, useState } from "react";
import { Layers3, Search, Users, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ALL_CUSTOMERS, ALL_TRACKS } from "../data/facets";
import type { CountRow } from "../types";
import { StatusBadge } from "./shared";

export interface DocumentFacets {
  track: string;
  customer: string;
  trackRows: CountRow[];
  customerRows: CountRow[];
  trackTotal: number;
  customerTotal: number;
  onTrackChange: (value: string) => void;
  onCustomerChange: (value: string) => void;
}

const CHIP_LIMIT = 10;

interface FacetRowProps {
  label: string;
  icon: LucideIcon;
  placeholder: string;
  allLabel: string;
  allCount: number;
  rows: CountRow[];
  value: string;
  onChange: (value: string) => void;
}

function FacetRow({ label, icon: Icon, placeholder, allLabel, allCount, rows, value, onChange }: FacetRowProps) {
  const [keyword, setKeyword] = useState("");
  const [expanded, setExpanded] = useState(false);
  const normalized = keyword.trim().toLocaleLowerCase("zh-CN");

  const visible = useMemo(() => {
    const matched = normalized
      ? rows.filter((row) => row.name.toLocaleLowerCase("zh-CN").includes(normalized))
      : rows;
    const base = expanded || normalized ? matched : matched.slice(0, CHIP_LIMIT);
    const selected = rows.find((row) => row.name === value);
    return selected && !base.some((row) => row.name === selected.name) ? [selected, ...base] : base;
  }, [expanded, normalized, rows, value]);

  const collapsible = !normalized && rows.length > CHIP_LIMIT;

  return (
    <div className="facet-row">
      <div className="facet-row__label">
        <Icon size={14} />
        <span>{label}</span>
        <b>{rows.length} 组</b>
      </div>
      <label className="facet-row__search">
        <Search size={13} />
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={placeholder}
          aria-label={`搜索${label}分组`}
        />
        {keyword && (
          <button type="button" onClick={() => setKeyword("")} aria-label={`清除${label}分组搜索`}>
            <X size={12} />
          </button>
        )}
      </label>
      <div className="facet-row__chips">
        <button
          type="button"
          className={value === allLabel ? "is-active" : ""}
          aria-pressed={value === allLabel}
          onClick={() => onChange(allLabel)}
        >
          {allLabel}<b>{allCount.toLocaleString("zh-CN")}</b>
        </button>
        {visible.map((row) => (
          <button
            key={row.name}
            type="button"
            className={value === row.name ? "is-active" : ""}
            aria-pressed={value === row.name}
            title={`${row.name} · ${row.count.toLocaleString("zh-CN")} 份`}
            onClick={() => onChange(value === row.name ? allLabel : row.name)}
          >
            {row.name}<b>{row.count.toLocaleString("zh-CN")}</b>
          </button>
        ))}
        {visible.length === 0 && <p className="facet-row__empty">没有匹配的{label}分组，试试更短的关键词。</p>}
      </div>
      {collapsible && (
        <button type="button" className="facet-row__more" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起分组" : `展开全部 ${rows.length} 组`}
        </button>
      )}
    </div>
  );
}

export function DocumentFacetFilter({ facets }: { facets: DocumentFacets }) {
  const { track, customer, trackRows, customerRows, trackTotal, customerTotal, onTrackChange, onCustomerChange } = facets;
  const classified = track !== ALL_TRACKS || customer !== ALL_CUSTOMERS;

  const reset = () => {
    onTrackChange(ALL_TRACKS);
    onCustomerChange(ALL_CUSTOMERS);
  };

  return (
    <section className="panel facet-filter" aria-label="分类筛选">
      <div className="panel__header">
        <div>
          <span className="eyebrow">CLASSIFY</span>
          <h2>按场景与客户拆分</h2>
        </div>
        {classified
          ? <button className="text-button" onClick={reset}><X size={13} /> 清除分类</button>
          : <StatusBadge tone="muted">未启用分类</StatusBadge>}
      </div>
      <FacetRow
        label="场景"
        icon={Layers3}
        placeholder="搜索场景，如 Qoder、千问办公…"
        allLabel={ALL_TRACKS}
        allCount={trackTotal}
        rows={trackRows}
        value={track}
        onChange={onTrackChange}
      />
      <FacetRow
        label="客户"
        icon={Users}
        placeholder="搜索客户，如 海信、海尔…"
        allLabel={ALL_CUSTOMERS}
        allCount={customerTotal}
        rows={customerRows}
        value={customer}
        onChange={onCustomerChange}
      />
      <footer className="facet-filter__note">
        场景沿用方案线规则，一份资料可同时属于多个场景；未命中规则时分别归入“未归类方案”和“未标注客户”。计数随顶部搜索、来源与类型筛选实时联动。
      </footer>
    </section>
  );
}
