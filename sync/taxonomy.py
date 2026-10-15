#!/usr/bin/env python3
"""Derive solution-track, customer and event facets for indexed knowledge documents.

The three facets are orthogonal: one document can be a Qoder track material, a 海信
customer case and 云栖大会 material at the same time. Rules are mined from the real
directory inventory rather than invented, and every facet falls back to an explicit
"unclassified" label so the workbench never silently drops a document.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

UNCLASSIFIED_TRACK = "未归类方案"
UNCLASSIFIED_CUSTOMER = "未标注客户"
NO_EVENT = "非活动材料"

MAX_TRACKS = 3
MAX_CUSTOMERS = 3
MAX_EVENTS = 3


@dataclass(frozen=True)
class FacetRule:
    """A facet rule. `tokens` are ASCII and boundary-matched; `terms` are substrings."""

    label: str
    tokens: tuple[str, ...] = ()
    terms: tuple[str, ...] = ()
    patterns: tuple[str, ...] = ()


SOLUTION_TRACK_RULES: tuple[FacetRule, ...] = (
    FacetRule("Qoder", tokens=("qoder", "qmind", "autowonder")),
    FacetRule(
        "AI Coding 与 Harness",
        tokens=("aicoding", "harness", "coding"),
        terms=("ai coding", "ai原生研发", "spec-driven", "智能编码", "码力"),
    ),
    FacetRule(
        "千问办公",
        tokens=("qwenwork", "workbuddy"),
        terms=("千问办公", "先锋营"),
    ),
    FacetRule(
        "QoderWork 与数字员工",
        tokens=("qoderwork", "qoderwake", "waker"),
        terms=("数字员工",),
    ),
    FacetRule(
        "智能体平台与多 Agent",
        tokens=("openclaw", "hiclaw", "agentcore", "agentloop", "agentlopp", "agentscope", "starops"),
        terms=("智能体平台", "多agent", "多 agent", "agent建设", "智能体建设"),
    ),
    FacetRule(
        "大数据与数据智能",
        tokens=("dataworks", "dlf", "fluss", "maxcompute"),
        terms=("大数据", "数仓", "湖仓", "数据中台", "数据分析"),
    ),
    FacetRule(
        "算力与加速卡",
        tokens=("ppu", "apg", "opentrek", "m890p"),
        terms=("ai stack", "ai-gateway", "加速卡", "算力", "智算"),
    ),
    FacetRule(
        "GPU 性能评测",
        tokens=("mu",),
        terms=("压测", "昇腾", "910b", "h20", "性能对比", "推理性能"),
    ),
    FacetRule(
        "多模态与内容生成",
        tokens=("aigc",),
        terms=(
            "多模态",
            "漫剧",
            "文生视频",
            "视频生成",
            "视频:图",
            "qwen-image",
            "文生图",
            "图像生成",
            "happyhorse",
            "语音",
            "ai玩具",
            "图生视频",
        ),
    ),
    FacetRule(
        "智能终端与 AIOS",
        tokens=("aios", "vidaa"),
        terms=("智慧家庭", "智能电视", "ai电视", "摄像头", "ipc"),
    ),
    FacetRule("具身智能", terms=("具身", "机器人")),
    FacetRule(
        "云基础设施与运维",
        tokens=("aiops",),
        terms=("上云", "搬栈", "搬站", "容灾", "迁移方案", "智能运维", "运维指南", "可观测性"),
    ),
    FacetRule("安全与合规", terms=("安全", "合规", "风控", "隐私")),
    FacetRule(
        "百炼与模型服务",
        tokens=("bailian", "dashscope", "qwen"),
        terms=("百炼", "通义", "零码", "模型服务"),
    ),
    FacetRule("知识管理与 RAG", terms=("知识管理", "知识库")),
    FacetRule("AI 组织转型", terms=("组织转型", "ai转型", "研发变革", "ai 变革")),
    FacetRule(
        "行业解决方案",
        terms=(
            "行业白皮书",
            "新零售",
            "零售行业",
            "白酒行业",
            "制造业",
            "连锁门店",
            "物流行业",
            "医疗行业",
            "行业方案",
        ),
    ),
    FacetRule(
        "工作坊与培训",
        tokens=("workshop",),
        terms=("工作坊", "培训", "实操手册", "方法论"),
    ),
)

CUSTOMER_RULES: tuple[FacetRule, ...] = (
    FacetRule("海信", terms=("海信",)),
    FacetRule("聚好看", terms=("聚好看",)),
    FacetRule("海尔", terms=("海尔", "三翼鸟", "智慧家庭")),
    FacetRule("睿创微纳", terms=("睿创微纳",)),
    FacetRule("歌尔", terms=("歌尔",)),
    FacetRule("高德", terms=("高德",)),
    FacetRule("义乌小商品城", terms=("义乌",)),
    FacetRule("迪安诊断", terms=("迪安",)),
    FacetRule("众阳健康", terms=("众阳",)),
    FacetRule("理想汽车", terms=("理想汽车",)),
    FacetRule("菜鸟", terms=("菜鸟",)),
    FacetRule("京东", terms=("京东",)),
    FacetRule("傅利叶", terms=("傅利叶",)),
    FacetRule("瑞幸", terms=("瑞幸",)),
    FacetRule("三一重工", terms=("三一",)),
    FacetRule("携程", terms=("携程",)),
    FacetRule("满帮", terms=("满帮",)),
    FacetRule("伊利", terms=("伊利",)),
    FacetRule("固生堂", terms=("固生堂",)),
    FacetRule("大润发", terms=("大润发",)),
    FacetRule("家家悦", terms=("家家悦",)),
    FacetRule("森马", terms=("森马",)),
    FacetRule("用友", terms=("用友",)),
    FacetRule("申通快递", terms=("申通",)),
    FacetRule("百威", terms=("百威",)),
    FacetRule("聚水潭", terms=("聚水潭",)),
    FacetRule("莲荷", terms=("莲荷",)),
    FacetRule("西门子", terms=("西门子",)),
    FacetRule("货拉拉", terms=("货拉拉",)),
    FacetRule("雅迪", terms=("雅迪",)),
    FacetRule("华大基因", terms=("华大",)),
    FacetRule("五粮液", terms=("五粮液",)),
    FacetRule("小红书", terms=("小红书",)),
    FacetRule("智慧家", patterns=(r"智慧家(?!庭)",)),
)

EVENT_RULES: tuple[FacetRule, ...] = (
    FacetRule("云栖大会", terms=("云栖",)),
    FacetRule("海信码力大赛", terms=("码力大赛", "ai智能体大赛")),
    FacetRule("海信 AI 先锋营", terms=("先锋营",)),
    FacetRule("阿里云峰会", terms=("阿里云峰会",)),
    FacetRule("AI Native 闭门会", terms=("闭门会",)),
    FacetRule("Maaster KO 大会", terms=("ko大会",)),
)

_TOKEN_CACHE: dict[str, re.Pattern[str]] = {}
_PATTERN_CACHE: dict[tuple[str, ...], tuple[re.Pattern[str], ...]] = {}


def _token_pattern(token: str) -> re.Pattern[str]:
    cached = _TOKEN_CACHE.get(token)
    if cached is None:
        cached = re.compile(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])")
        _TOKEN_CACHE[token] = cached
    return cached


def _rule_patterns(rule: FacetRule) -> tuple[re.Pattern[str], ...]:
    cached = _PATTERN_CACHE.get(rule.patterns)
    if cached is None:
        cached = tuple(re.compile(pattern) for pattern in rule.patterns)
        _PATTERN_CACHE[rule.patterns] = cached
    return cached


def build_haystack(relative_path: str, title: str = "") -> str:
    """Join path segments and title into one casefolded search surface.

    Segments are space-separated so ASCII token boundaries work across `/`.
    """
    segments = [part for part in relative_path.split("/") if part]
    return (" " + " ".join(segments) + " " + title + " ").casefold()


def matches(rule: FacetRule, haystack: str) -> bool:
    if any(term.casefold() in haystack for term in rule.terms):
        return True
    if any(_token_pattern(token.casefold()).search(haystack) for token in rule.tokens):
        return True
    return any(pattern.search(haystack) for pattern in _rule_patterns(rule))


def infer_facet(
    rules: Sequence[FacetRule],
    haystack: str,
    *,
    limit: int,
) -> list[str]:
    return [rule.label for rule in rules if matches(rule, haystack)][:limit]


def classify(relative_path: str, title: str = "") -> dict[str, list[str]]:
    haystack = build_haystack(relative_path, title)
    return {
        "solutionTracks": infer_facet(SOLUTION_TRACK_RULES, haystack, limit=MAX_TRACKS),
        "customers": infer_facet(CUSTOMER_RULES, haystack, limit=MAX_CUSTOMERS),
        "events": infer_facet(EVENT_RULES, haystack, limit=MAX_EVENTS),
    }


def facet_labels(document: Mapping[str, Any], key: str, fallback: str) -> list[str]:
    values = [str(item) for item in document.get(key, []) if str(item).strip()]
    return values or [fallback]


def facet_rows(
    documents: Sequence[Mapping[str, Any]],
    key: str,
    fallback: str,
) -> list[dict[str, Any]]:
    """Count a facet across documents, always including the fallback bucket."""
    counter: Counter[str] = Counter()
    for document in documents:
        counter.update(facet_labels(document, key, fallback))
    return [
        {"name": name, "count": count}
        for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    ]


FACET_FALLBACKS = {
    "solutionTracks": UNCLASSIFIED_TRACK,
    "customers": UNCLASSIFIED_CUSTOMER,
    "events": NO_EVENT,
}


def all_facet_rows(documents: Sequence[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    return {
        "bySolutionTrack": facet_rows(documents, "solutionTracks", UNCLASSIFIED_TRACK),
        "byCustomer": facet_rows(documents, "customers", UNCLASSIFIED_CUSTOMER),
        "byEvent": facet_rows(documents, "events", NO_EVENT),
    }
