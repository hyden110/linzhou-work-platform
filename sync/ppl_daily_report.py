#!/usr/bin/env python3
"""PPL 每日巡检：拉取钉钉日报（dws report outbox list，只读）并做 PPL 候选分析。

铁律（与 docs/ppl-inspection-plan.md §2 一致）：
- 只读采集：dws 仅允许 `report outbox list` 白名单命令（flag 全校验），不发任何消息；
- 分析只基于本地快照 crm-snapshot.json 与日报文本，绝不外发；
- 金额等关键字段缺失 → 标记 blocked，绝不猜测；日报按客户分段抽取，
  无法可靠分段 → blocked(segment_uncertain)，绝不跨段取值；
- 本模块不含任何创建调用（无浏览器自动化、无创建 skill、无外部平台写入请求）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from .local_indexer import atomic_write_json
except ImportError:
    from local_indexer import atomic_write_json

SCHEMA_VERSION = 1
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / ".local-cache"
SNAPSHOT_PATH = CACHE_DIR / "crm-snapshot.json"
OUTPUT_DIR = CACHE_DIR / "ppl-inspection"

DWS_BASE = ("report", "outbox", "list")
DWS_FLAGS: Mapping[str, Any] = {
    "--cursor": lambda value: bool(re.fullmatch(r"\d{1,6}", value)),
    "--size": lambda value: bool(re.fullmatch(r"\d{1,2}", value)) and 1 <= int(value) <= 20,
    "--start": lambda value: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}", value)),
    "--end": lambda value: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}", value)),
    "--format": lambda value: value == "json",
}
DWS_TIMEOUT_SECONDS = 120
REPORT_MAX_CHARS = 6000
MAX_REPORTS = 60
SNAPSHOT_MAX_AGE_DAYS = 7.0

TZ = timezone(timedelta(hours=8))

# 机会点类型映射（plan §6：关键词 → 固定下拉 6 项；无匹配 → 其他）
OPPORTUNITY_KEYWORDS: Sequence[tuple[str, str]] = (
    ("gpu", "智算-GPU"), ("ppu", "智算-GPU"), ("算力", "智算-GPU"), ("l20", "智算-GPU"), ("h20", "智算-GPU"),
    ("敏态", "敏态应用上云"),
    ("sfoa", "SFOA"), ("sf oa", "SFOA"),
    ("七大件", "七大件"),
    ("大数据", "大数据上云"),
    ("qoder", "智算-通义"), ("千问办公", "智算-通义"), ("百炼", "智算-通义"), ("qwen", "智算-通义"),
    ("模型", "智算-通义"), ("agent", "智算-通义"), ("aios", "智算-通义"),
)
OPPORTUNITY_FALLBACK = "其他"

# 金额抽取：万元/元/万/w/W 结尾的数字（含千分位），取区间上限
AMOUNT_PATTERN = re.compile(
    r"(\d[\d,，]*(?:\.\d+)?)\s*(万元|万|w|W|元)(?!/)", re.I
)

# 节标题（短行 + 序号顿号/点号）：出现即重置当前客户归属
SECTION_HEADER = re.compile(r"^[一二三四五六七八九十\d]{1,4}\s*[、.．]")
# 子弹分隔：真实日报为单行长段落，条目以「- 」内联分隔（行首/空白/标点后的「- 」）
BULLET_SPLIT = re.compile(r"(?:(?<!\S)|(?<=[：:，,。；;、]))-\s+")
# 日报尾部元数据（图片/附件占位）不进入客户段落
TRAILING_META = re.compile(
    r"[；;，,]?\s*图片：?\s*\[[^\]]*\]\s*(?:[；;]\s*附件：?\s*\[[^\]]*\])?\s*$"
)


class SourceError(RuntimeError):
    def __init__(self, status: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def run_dws_report(arguments: Sequence[str]) -> Mapping[str, Any]:
    """执行白名单内的 dws report outbox list 命令（只读）。"""
    command = tuple(arguments)
    if command[:3] != DWS_BASE:
        raise SourceError("error", "command_not_allowed")
    index = 3
    while index < len(command):
        flag = command[index]
        if flag not in DWS_FLAGS or index + 1 >= len(command) or not DWS_FLAGS[flag](command[index + 1]):
            raise SourceError("error", "command_not_allowed")
        index += 2
    executable = shutil.which("dws")
    if not executable:
        raise SourceError("error", "dws_missing")
    completed = subprocess.run(
        [executable, *command], check=False, capture_output=True, text=True,
        timeout=DWS_TIMEOUT_SECONDS, shell=False,
    )
    if completed.returncode == 0:
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise SourceError("error", "invalid_json") from error
        if not isinstance(payload, Mapping):
            raise SourceError("error", "unexpected_shape")
        return payload
    reason = "dws_exit_" + str(completed.returncode)
    for line in (completed.stderr or completed.stdout).splitlines():
        if "auth" in line.lower() or "login" in line.lower() or "token" in line.lower():
            reason = "dws_auth"
            break
    raise SourceError("error", reason)


def parse_reports(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """投影日报列表：只留分析所需字段，内容截断防超量。"""
    rows = payload.get("result")
    if rows is None:
        rows = payload.get("items", [])
    if not isinstance(rows, list):
        raise SourceError("error", "unexpected_shape")
    reports: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        content = str(row.get("日志内容") or "")
        title = str(row.get("标题") or "")
        date = str(row.get("日期") or "")
        if not content.strip():
            continue
        reports.append({
            "title": title[:120],
            "date": date[:40],
            "content": content[:REPORT_MAX_CHARS],
        })
    return reports[:MAX_REPORTS]


def fetch_daily_reports(window_days: int = 3) -> tuple[list[dict[str, Any]], str | None]:
    """拉取最近 window_days 天的日报（dws 默认窗口即最近 20 天；这里显式传窗）。"""
    end = datetime.now(TZ)
    start = end - timedelta(days=window_days)
    payload = run_dws_report([
        "report", "outbox", "list",
        "--cursor", "0", "--size", "20",
        "--start", start.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "--end", end.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "--format", "json",
    ])
    return parse_reports(payload), None


# ---------------- 分析引擎 ----------------

def normalize_name(value: str) -> str:
    """归一化：去空格/全半角/括号引号/FY 前缀/日期串，小写。"""
    text = value.strip()
    text = re.sub(r"[\s\u3000]+", "", text)
    # 括号/引号成对噪声直接删除（【】「」等包裹词不参与匹配）
    text = text.translate(str.maketrans("", "", "（）［］【】「」『』“”‘’()[]\"'"))
    text = re.sub(r"FY\d{2}[-_ ]?Q[1-4]?[-_ ]?", "", text, flags=re.I)
    text = re.sub(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", "", text)
    text = re.sub(r"[-_/]+", "", text)
    return text.lower()


def load_snapshot(path: Path = SNAPSHOT_PATH) -> tuple[dict[str, Any] | None, str | None]:
    """读本地快照（只读）；返回 (snapshot|None, error|None)。"""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, "snapshot_unreadable"
    if not isinstance(raw, Mapping) or raw.get("schemaVersion") != 1:
        return None, "snapshot_invalid"
    return raw, None


def snapshot_staleness(snapshot: Mapping[str, Any], now: datetime | None = None) -> tuple[bool, str]:
    """快照新鲜度：generatedAt 超 7 天 → stale（不静默）。"""
    generated_at = str(snapshot.get("generatedAt") or "")
    if not generated_at:
        return True, "unknown"
    try:
        moment = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError:
        return True, "unknown"
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(TZ)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=TZ)
    age_days = (reference - moment).total_seconds() / 86400
    return age_days > SNAPSHOT_MAX_AGE_DAYS, generated_at


def map_opportunity(text: str) -> str:
    lowered = text.lower()
    for keyword, label in OPPORTUNITY_KEYWORDS:
        if keyword in lowered:
            return label
    return OPPORTUNITY_FALLBACK


def extract_amount_yuan(text: str) -> float | None:
    """抽取金额并折算为元；找不到 → None（绝不猜）。"""
    matches = AMOUNT_PATTERN.findall(text)
    if not matches:
        return None
    numbers: list[float] = []
    for raw, unit in matches:
        value = float(raw.replace(",", "").replace("，", ""))
        unit_l = unit.lower()
        if unit_l in ("万元", "万", "w"):
            value *= 10000
        numbers.append(value)
    return max(numbers)


# 行政/组织后缀：客户全名去掉这些词得到可匹配的别名（日报常写简称，如「海信」）
CUSTOMER_SUFFIX_NOISE = (
    "股份有限公司", "有限责任公司", "有限公司", "集团公司", "集团", "科技公司",
    "数字科技", "信息技术", "技术", "科技", "控股", "股份",
)
REGION_PREFIX = ("青岛", "山东", "北京", "烟台", "威海", "杭州", "上海", "济南")


def customer_aliases(name: str) -> list[str]:
    """全名 → 别名集（含原归一化名；去区域前缀与行政后缀的短名需 ≥2 字符）。"""
    normalized = normalize_name(name)
    aliases = {normalized}
    stripped = normalized
    changed = True
    while changed:
        changed = False
        for noise in CUSTOMER_SUFFIX_NOISE:
            if stripped.endswith(noise) and len(stripped) - len(noise) >= 2:
                stripped = stripped[: -len(noise)]
                changed = True
        for region in REGION_PREFIX:
            if stripped.startswith(region) and len(stripped) - len(region) >= 2:
                stripped = stripped[len(region):]
                changed = True
    if len(stripped) >= 2:
        aliases.add(stripped)
    return sorted(aliases, key=len, reverse=True)


def match_customers(text: str, customers: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """文本中出现的客户（全名或别名归一化比对，长别名优先防误配）。"""
    lowered = normalize_name(text)
    hits: list[dict[str, Any]] = []
    for customer in customers:
        name = str(customer.get("name") or "")
        if not name:
            continue
        for alias in customer_aliases(name):
            if alias in lowered:
                hits.append({"cid": customer.get("cid"), "name": name, "matchedAlias": alias})
                break
    return hits


def dedupe_status(
    suggested_name: str,
    cid: str | None,
    customer_name: str,
    projects: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """三分态判重：已建 / 疑似已建 / 未建（附证据）。"""
    normalized_suggestion = normalize_name(suggested_name)
    normalized_customer = normalize_name(customer_name)
    exact: dict[str, Any] | None = None
    suspected: list[dict[str, Any]] = []
    for project in projects:
        project_name = str(project.get("name") or "")
        normalized_project = normalize_name(project_name)
        evidence = {"projectId": project.get("id"), "projectName": project_name, "cid": project.get("cid")}
        # a) 项目名与建议名/客户名强匹配（客户名 + 主题词都在项目名里）
        if normalized_suggestion and normalized_suggestion in normalized_project:
            exact = evidence
            break
        if normalized_customer and normalized_customer in normalized_project:
            # 同客户下项目：主题词是否重合（建议名去掉客户名后的部分）
            theme = normalized_suggestion.replace(normalized_customer, "")
            if not theme or theme in normalized_project:
                exact = evidence
                break
            suspected.append(evidence)
        elif cid and str(project.get("cid") or "") == cid:
            suspected.append(evidence)
    if exact:
        return {"status": "exists", "evidence": exact}
    if suspected:
        return {"status": "suspected", "evidence": suspected[:5]}
    return {"status": "new", "evidence": None}


def _is_name_only_cell(cell: str, alias: str) -> bool:
    """cell 是否基本只含客户名（「- 客户名 - 内容」风格）：去掉别名后仅剩标点/区域前缀。"""
    residue = normalize_name(cell).replace(normalize_name(alias), "", 1)
    for region in REGION_PREFIX:
        if residue.startswith(region):
            residue = residue[len(region):]
            break
    return len(residue) <= 2


def segment_by_customer(
    content: str,
    customers: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """日报按客户锚点切段（返工 #1）：
    - 内容先按换行、再按「- 」子弹分隔切 cell（真实日报为单行长段落、条目内联分隔）；
    - 单客户 cell = 该客户段锚点（同一客户的多个锚点 cell 合并）；「- 客户名 - 内容」
      风格时，紧随其后的无客户 cell 视为该客户内容；
    - 一个 cell 多客户 = 歧义，不归属任何客户；节标题 cell 重置归属；缩进续行归属当前客户；
    - 出现过但无归属段的客户 → uncertain（宁可 blocked 不跨段取值）。
    """
    segments: dict[str, list[str]] = {}
    mentioned: dict[str, dict[str, Any]] = {}
    current: str | None = None
    attach_next = False
    for raw_line in content.splitlines():
        indented = raw_line[:1] in (" ", "\t", "\u3000")
        for raw_cell in BULLET_SPLIT.split(raw_line):
            cell = TRAILING_META.sub("", raw_cell.strip()).strip()
            if not cell:
                continue
            hits = match_customers(cell, customers)
            if hits:
                for hit in hits:
                    mentioned.setdefault(str(hit["name"]), hit)
                if len(hits) == 1:
                    current = str(hits[0]["name"])
                    segments.setdefault(current, []).append(cell)
                    attach_next = _is_name_only_cell(cell, str(hits[0]["matchedAlias"]))
                else:
                    current = None  # 一个 cell 多客户：歧义，不归属任何人
                    attach_next = False
                continue
            if len(cell) <= 16 and SECTION_HEADER.match(cell):
                current = None  # 节标题：归属重置
                attach_next = False
                continue
            if current is not None and (attach_next or indented):
                segments.setdefault(current, []).append(cell)  # 「客户名-内容」续段或缩进续行
            attach_next = False
    result: list[dict[str, Any]] = []
    for name, hit in mentioned.items():
        cells = segments.get(name) or []
        result.append({
            "cid": hit.get("cid"),
            "name": name,
            "segment": "\n".join(cells),
            "uncertain": not cells,
        })
    result.sort(key=lambda item: str(item["name"]))
    return result


def recommendation_id(cid: str | None, report_date: str, suggested_name: str) -> str:
    """稳定 ID（返工 #2）：CID + 报告日期 + 建议项目名（归一化）内容派生。"""
    base = f"{cid or 'no-cid'}|{report_date}|{normalize_name(suggested_name)}"
    return "r" + hashlib.sha256(base.encode("utf-8")).hexdigest()[:10]


def recommendation_fingerprint(cid: str | None, suggested_name: str, amount_yuan: float | None) -> str:
    """推荐指纹（返工 #2）：CID + 建议项目名 + 金额；决策读取时指纹不符视为新待处理。"""
    amount = f"{amount_yuan:g}" if amount_yuan is not None else "na"
    base = f"{cid or 'no-cid'}|{normalize_name(suggested_name)}|{amount}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:12]


def build_recommendations(
    reports: Sequence[Mapping[str, Any]],
    snapshot: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """按客户分段抽取 PPL 候选（机会点/金额/摘要只取本客户段落）→ 判重 → 推荐。"""
    projects = [p for p in (snapshot.get("projects") or []) if isinstance(p, Mapping)]
    customers = [c for c in (snapshot.get("customers") or []) if isinstance(c, Mapping)]
    # 跨日报聚合：同客户同机会点合并段落（金额取段内最大，摘要取首段）
    aggregates: dict[tuple[str, str], dict[str, Any]] = {}
    for report in reports:
        content = str(report.get("content") or "")
        date = str(report.get("date") or "")
        for hit in segment_by_customer(content, customers):
            customer_name = str(hit["name"])
            cid = hit.get("cid")
            segment = str(hit.get("segment") or "")
            if hit.get("uncertain"):
                # 无法可靠分段：宁可 blocked，绝不跨段取值（返工 #1）
                opportunity = OPPORTUNITY_FALLBACK
                clean = False
            else:
                opportunity = map_opportunity(segment)
                clean = True
            suggested_name = f"FY27-Q3-{customer_name}-{opportunity}"
            key = (normalize_name(customer_name), normalize_name(opportunity))
            aggregate = aggregates.get(key)
            if aggregate is None:
                aggregates[key] = {
                    "customerName": customer_name,
                    "cid": cid,
                    "opportunity": opportunity,
                    "suggestedName": suggested_name,
                    "segments": [segment] if clean else [],
                    "uncertainOnly": not clean,
                    "date": date,
                }
            elif clean:
                aggregate["segments"].append(segment)
                aggregate["uncertainOnly"] = False
                if date > str(aggregate["date"]):
                    aggregate["date"] = date
    # 已有可靠段落的客户，其歧义提及不再生成额外 blocked 条目
    clean_customers = {
        normalize_name(str(aggregate["customerName"]))
        for aggregate in aggregates.values()
        if not aggregate["uncertainOnly"]
    }
    recommendations: list[dict[str, Any]] = []
    for aggregate in aggregates.values():
        customer_name = str(aggregate["customerName"])
        if aggregate["uncertainOnly"] and normalize_name(customer_name) in clean_customers:
            continue
        cid = aggregate["cid"]
        opportunity = str(aggregate["opportunity"])
        suggested_name = str(aggregate["suggestedName"])
        segments_text = "\n".join(str(part) for part in aggregate["segments"])
        if aggregate["uncertainOnly"]:
            amount = None
            blocked = True
            block_reason = "segment_uncertain"
            note = None
        else:
            amount = extract_amount_yuan(segments_text)
            blocked = amount is None
            block_reason = None if amount is not None else "amount_missing"
            note = segments_text[:140] or None
        recommendations.append({
            "id": recommendation_id(cid, str(aggregate["date"]), suggested_name),
            "fingerprint": recommendation_fingerprint(cid, suggested_name, amount),
            "sourceReportDate": str(aggregate["date"]),
            "customerName": customer_name,
            "cid": cid,
            "suggestedProjectName": suggested_name,
            "opportunityType": opportunity,
            "amountYuan": amount,
            "blocked": blocked,
            "blockReason": block_reason,
            "dedupe": dedupe_status(suggested_name, cid, customer_name, projects),
            "changeNote": note,
            "state": "pending",
        })
    return recommendations


def build_inspection(
    reports: Sequence[Mapping[str, Any]],
    snapshot: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    reference = now or datetime.now(TZ)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=TZ)
    stale, generated_at = snapshot_staleness(snapshot, reference)
    recommendations = build_recommendations(reports, snapshot)
    pending = [r for r in recommendations if r["state"] == "pending"]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": reference.astimezone(TZ).isoformat(timespec="seconds"),
        "snapshotGeneratedAt": generated_at,
        "snapshotStale": stale,
        "reportCount": len(reports),
        "recommendations": recommendations,
        "summary": {
            "total": len(recommendations),
            "pending": len(pending),
            "exists": sum(1 for r in recommendations if r["dedupe"]["status"] == "exists"),
            "suspected": sum(1 for r in recommendations if r["dedupe"]["status"] == "suspected"),
            "new": sum(1 for r in recommendations if r["dedupe"]["status"] == "new"),
            "blocked": sum(1 for r in recommendations if r["blocked"]),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="只读拉取钉钉日报并生成 PPL 巡检推荐（不外发、不创建）")
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--window-days", type=int, default=3)
    parser.add_argument("--now", type=str, default=None, help="ISO 时间（测试用）")
    args = parser.parse_args()

    os.umask(0o077)
    now = datetime.fromisoformat(args.now) if args.now else None
    snapshot, snapshot_error = load_snapshot()
    envelope: dict[str, Any]
    if snapshot is None:
        envelope = {
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": (now or datetime.now(TZ)).astimezone(TZ).isoformat(timespec="seconds"),
            "state": "failed",
            "error": snapshot_error,
            "reportCount": 0,
            "recommendations": [],
            "summary": {"total": 0, "pending": 0, "exists": 0, "suspected": 0, "new": 0, "blocked": 0},
        }
    else:
        try:
            reports, _ = fetch_daily_reports(args.window_days)
        except SourceError as error:
            envelope = {
                "schemaVersion": SCHEMA_VERSION,
                "generatedAt": (now or datetime.now(TZ)).astimezone(TZ).isoformat(timespec="seconds"),
                "state": "failed",
                "error": error.reason,
                "reportCount": 0,
                "recommendations": [],
                "summary": {"total": 0, "pending": 0, "exists": 0, "suspected": 0, "new": 0, "blocked": 0},
            }
        else:
            inspection = build_inspection(reports, snapshot, now)
            inspection["state"] = "ok"
            envelope = inspection
    envelope["snapshotGeneratedAt"] = envelope.get("snapshotGeneratedAt")
    day = (now or datetime.now(TZ)).astimezone(TZ).strftime("%Y-%m-%d")
    atomic_write_json(args.output_dir / f"{day}.json", envelope)
    atomic_write_json(args.output_dir / "latest.json", envelope)
    print(json.dumps({
        "state": envelope.get("state"),
        "error": envelope.get("error"),
        "reports": envelope.get("reportCount"),
        "recommendations": envelope["summary"]["total"],
        "summary": envelope["summary"],
    }, ensure_ascii=False))
    return 0 if envelope.get("state") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
