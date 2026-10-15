#!/usr/bin/env python3
"""Extract the Yunqi highlights page into local-only structured content.

Reads the user's own HTML digest and writes a bounded JSON structure that the
local Function can serve. The source file is never modified or uploaded, and the
output stays in .local-cache so it cannot reach public/ or dist/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Sequence

SCHEMA_VERSION = 1
SOURCE_ID = "yunqi-2026-highlights"
MAX_LIST_ITEMS = 12
MAX_TALKS_PER_FORUM = 40
MAX_TEXT_CHARS = 1200
MAX_NOTE_CHARS = 600

DEFAULT_SOURCE = Path(
    "/Users/linzhou/Documents/场景/云栖大会/2026/"
    "2026云栖大会-从产业范式到 Agentic Cloud 底座的六层趋势、观点与方案整理.html"
)
DEFAULT_ROOT = Path("/Users/linzhou/Documents/场景")

VOID_TAGS = frozenset({"br", "hr", "img", "meta", "link", "input", "source", "area", "base", "col"})


class YunqiHighlightsError(RuntimeError):
    """Raised when the highlights source cannot be read or parsed safely."""


def _valid_text(value: str) -> str:
    return value.encode("utf-16", errors="surrogatepass").decode("utf-16", errors="replace")


def utc_iso(timestamp: float | None = None) -> str:
    instant = datetime.now(timezone.utc) if timestamp is None else datetime.fromtimestamp(timestamp, timezone.utc)
    return instant.isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class Node:
    tag: str
    attrs: dict[str, str]
    children: list["Node"]
    text: str = ""

    @property
    def classes(self) -> frozenset[str]:
        return frozenset(self.attrs.get("class", "").split())

    def has_class(self, name: str) -> bool:
        return name in self.classes


class TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("#document", {}, [])
        self.stack: list[Node] = [self.root]

    def handle_starttag(self, tag: str, attrs: Sequence[tuple[str, str | None]]) -> None:
        node = Node(tag, {key: (value or "") for key, value in attrs}, [])
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: Sequence[tuple[str, str | None]]) -> None:
        self.stack[-1].children.append(Node(tag, {key: (value or "") for key, value in attrs}, []))

    def handle_endtag(self, tag: str) -> None:
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data: str) -> None:
        if not data:
            return
        self.stack[-1].children.append(Node("#text", {}, [], data))


def parse_html(markup: str) -> Node:
    builder = TreeBuilder()
    builder.feed(markup)
    builder.close()
    return builder.root


def find_all(node: Node, *, tag: str | None = None, class_name: str | None = None) -> list[Node]:
    found: list[Node] = []
    for child in node.children:
        if child.tag == "#text":
            continue
        if (tag is None or child.tag == tag) and (class_name is None or child.has_class(class_name)):
            found.append(child)
        found.extend(find_all(child, tag=tag, class_name=class_name))
    return found


def find_first(node: Node, *, tag: str | None = None, class_name: str | None = None) -> Node | None:
    matches = find_all(node, tag=tag, class_name=class_name)
    return matches[0] if matches else None


def text_of(node: Node | None) -> str:
    if node is None:
        return ""
    parts: list[str] = []
    for child in node.children:
        if child.tag == "#text":
            parts.append(child.text)
        elif child.tag == "br":
            parts.append("\n")
        else:
            parts.append(text_of(child))
    joined = "".join(parts).replace("\r", "").replace("\n", " ⏎ ")
    collapsed = re.sub(r"[ \t\u3000]+", " ", joined)
    collapsed = re.sub(r"\s*⏎\s*", " ⏎ ", collapsed).strip(" ⏎").strip()
    return _valid_text(collapsed)


def one_line(node: Node | None, *, limit: int = MAX_TEXT_CHARS) -> str:
    value = re.sub(r"\s*⏎\s*", " · ", text_of(node))
    value = re.sub(r"\s*·\s*(·\s*)+", " · ", value).strip(" ·").strip()
    return value[:limit]


def split_lines(node: Node | None) -> list[str]:
    return [line.strip(" ·").strip() for line in text_of(node).split("⏎") if line.strip(" ·").strip()]


def list_items(container: Node | None, *, limit: int = MAX_LIST_ITEMS) -> list[str]:
    if container is None:
        return []
    items = [one_line(item, limit=400) for item in find_all(container, tag="li")]
    return [item for item in items if item][:limit]


def evidence_links(container: Node | None) -> list[dict[str, str]]:
    if container is None:
        return []
    links: list[dict[str, str]] = []
    for anchor in find_all(container, tag="a"):
        href = anchor.attrs.get("href", "")
        label = one_line(anchor, limit=120)
        if not label:
            continue
        entry = {"label": label}
        if href.startswith("#"):
            entry["anchor"] = href[1:][:64]
        elif href.startswith("https://"):
            entry["url"] = href[:300]
        links.append(entry)
    return links[:MAX_LIST_ITEMS]


def tag_labels(container: Node | None) -> list[str]:
    if container is None:
        return []
    return [one_line(tag, limit=80) for tag in find_all(container, class_name="tag") if one_line(tag, limit=80)]


def section_by_id(root: Node, section_id: str) -> Node | None:
    for section in find_all(root, tag="section"):
        if section.attrs.get("id") == section_id:
            return section
    return None


def ordered_sections(root: Node) -> list[Node]:
    return [section for section in find_all(root, tag="section") if section.attrs.get("id")]


def parse_talk(node: Node) -> dict[str, Any]:
    header = find_first(node, class_name="talk-h")
    body = find_first(node, class_name="talk-b")
    blocks = [block for block in (body.children if body else []) if block.tag == "div"]
    first_items = list_items(blocks[0], limit=1) if blocks else []
    return {
        "id": node.attrs.get("id", "")[:64],
        "who": one_line(find_first(header, class_name="who") if header else None, limit=160),
        "role": one_line(find_first(header, class_name="role") if header else None, limit=160),
        "title": one_line(find_first(header, class_name="title") if header else None, limit=200),
        "tags": tag_labels(header),
        "headline": first_items[0] if first_items else "",
        "key": "key" in node.classes,
    }


def parse_forum(node: Node, layer_id: str) -> dict[str, Any]:
    meta = find_first(node, class_name="forum-meta")
    mainline = find_first(node, class_name="mainline")
    tri = find_first(node, class_name="tri")
    sections: list[dict[str, Any]] = []
    for block in [item for item in (tri.children if tri else []) if item.tag == "div"]:
        heading = one_line(find_first(block, tag="h4"), limit=80)
        items = list_items(block)
        if heading or items:
            sections.append({"heading": heading or "要点", "items": items})
    talks = [parse_talk(talk) for talk in find_all(node, class_name="talk")][:MAX_TALKS_PER_FORUM]
    gaps = [one_line(card, limit=400) for card in find_all(node, class_name="gap-card")]
    return {
        "id": node.attrs.get("id", "")[:32],
        "layerId": layer_id,
        "title": one_line(find_first(node, tag="h2"), limit=200),
        "meta": [one_line(span, limit=200) for span in (find_all(meta, tag="span") if meta else [])][:8],
        "lead": one_line(find_first(mainline, class_name="lead") if mainline else None, limit=MAX_TEXT_CHARS),
        "sections": sections,
        "notes": [one_line(note, limit=MAX_NOTE_CHARS) for note in find_all(node, class_name="tnote")][:4],
        "talkCount": len(find_all(node, class_name="talk")),
        "talks": talks,
        "gapNotes": [gap for gap in gaps if gap][:MAX_LIST_ITEMS],
    }


def parse_forum_table(layer_section: Node) -> list[dict[str, str]]:
    table = find_first(layer_section, tag="table")
    if table is None:
        return []
    rows = [row for row in find_all(table, tag="tr") if find_all(row, tag="td")]
    forums: list[dict[str, str]] = []
    for row in rows[:MAX_LIST_ITEMS]:
        cells = [split_lines(cell) for cell in find_all(row, tag="td")]
        if len(cells) < 2:
            continue
        anchor = find_first(cells_node(row, 0), tag="a")
        when_lines = cells[1] if len(cells) > 1 else []
        forums.append(
            {
                "id": (anchor.attrs.get("href", "#")[1:] if anchor else "")[:32],
                "title": cells[0][0][:200] if cells[0] else "",
                "agenda": " ".join(cells[0][1:])[:80] if len(cells[0]) > 1 else "",
                "when": when_lines[0][:200] if when_lines else "",
                "where": when_lines[1][:200] if len(when_lines) > 1 else "",
                "positioning": " ".join(cells[2])[:400] if len(cells) > 2 else "",
                "releases": " ".join(cells[3])[:400] if len(cells) > 3 else "",
                "cases": " ".join(cells[4])[:400] if len(cells) > 4 else "",
            }
        )
    return forums


def cells_node(row: Node, index: int) -> Node | None:
    cells = find_all(row, tag="td")
    return cells[index] if index < len(cells) else None


def parse_layer(node: Node, order: int) -> dict[str, Any]:
    divider = find_first(node, class_name="divider")
    return {
        "id": node.attrs.get("id", "")[:16],
        "order": order,
        "label": one_line(find_first(divider, class_name="lv") if divider else None, limit=80),
        "title": one_line(find_first(divider, tag="h2") if divider else None, limit=200),
        "summary": one_line(find_first(divider, tag="p") if divider else None, limit=MAX_TEXT_CHARS),
        "forums": parse_forum_table(node),
    }


def parse_overview(root: Node) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    overview = section_by_id(root, "overview")
    if overview is None:
        raise YunqiHighlightsError("missing overview section")
    synthesis_block = find_first(overview, class_name="mainline")
    thesis = {
        "tag": one_line(find_first(synthesis_block, class_name="tag") if synthesis_block else None, limit=80),
        "statement": one_line(find_first(synthesis_block, class_name="thesis") if synthesis_block else None, limit=400),
        "note": one_line(find_first(synthesis_block, class_name="thesis-sub") if synthesis_block else None, limit=MAX_TEXT_CHARS),
    }
    judgments = [
        {
            "index": index + 1,
            "title": one_line(find_first(card, tag="h3"), limit=200),
            "body": one_line(find_first(card, tag="p"), limit=MAX_TEXT_CHARS),
            "evidence": evidence_links(find_first(card, class_name="ev")),
        }
        for index, card in enumerate(find_all(overview, class_name="insight"))
    ]

    trends: list[dict[str, Any]] = []
    layer_position = 0
    group: dict[str, str] = {}
    for child in overview.children:
        if child.tag != "div":
            continue
        if child.has_class("layer-h"):
            layer_position += 1
            group = {
                "badge": one_line(find_first(child, class_name="lv"), limit=16),
                "heading": one_line(find_first(child, tag="h3"), limit=160),
                "note": one_line(find_first(child, tag="p"), limit=200),
            }
        elif child.has_class("ov-grid"):
            layer_id = f"l{layer_position}"
            for card in find_all(child, class_name="ov"):
                label = one_line(find_first(card, class_name="n"), limit=32)
                digits = re.search(r"(\d+)", label)
                trends.append(
                    {
                        "id": f"trend-{digits.group(1)}" if digits else f"trend-{len(trends) + 1}",
                        "index": int(digits.group(1)) if digits else len(trends) + 1,
                        "layerId": layer_id,
                        "groupBadge": group.get("badge", ""),
                        "groupHeading": group.get("heading", ""),
                        "groupNote": group.get("note", ""),
                        "title": one_line(find_first(card, tag="h3"), limit=200),
                        "body": one_line(find_first(card, tag="p"), limit=MAX_TEXT_CHARS),
                        "evidence": evidence_links(find_first(card, class_name="ev")),
                    }
                )
    return thesis, judgments, trends


def parse_method(root: Node) -> dict[str, Any]:
    method = section_by_id(root, "method")
    if method is None:
        return {"sections": [], "gaps": []}
    container = find_first(method, class_name="method") or method
    headings = find_all(container, tag="h3")
    sections: list[dict[str, Any]] = []
    for heading in headings:
        scope = container if heading in container.children else method
        if heading not in scope.children:
            continue
        paragraphs: list[str] = []
        rows: list[str] = []
        position = scope.children.index(heading)
        for following in scope.children[position + 1 :]:
            if following.tag == "h3":
                break
            if following.tag == "p":
                paragraphs.append(one_line(following, limit=MAX_TEXT_CHARS))
            elif following.tag == "table":
                for row in find_all(following, tag="tr"):
                    cells = [one_line(cell, limit=400) for cell in find_all(row, tag="td")]
                    if cells:
                        rows.append(" ｜ ".join(cells)[:600])
            elif following.tag == "ul":
                rows.extend(item for item in list_items(following, limit=MAX_LIST_ITEMS) if item)
        sections.append(
            {
                "heading": one_line(heading, limit=160),
                "body": " ".join(paragraphs)[:2000],
                "rows": rows[:MAX_LIST_ITEMS],
            }
        )
    gaps = [one_line(card, limit=400) for card in find_all(method, class_name="gap-card")]
    return {"sections": sections, "gaps": [gap for gap in gaps if gap][:MAX_LIST_ITEMS]}


def build_highlights(*, source_path: Path, root: Path) -> dict[str, Any]:
    resolved_source = source_path.resolve()
    resolved_root = root.resolve()
    if not resolved_source.is_file():
        raise YunqiHighlightsError("highlights source is not a readable file")
    if resolved_source.is_symlink():
        raise YunqiHighlightsError("highlights source must not be a symbolic link")
    try:
        resolved_source.relative_to(resolved_root)
    except ValueError as error:
        raise YunqiHighlightsError("highlights source must stay within the scenario root") from error

    markup = resolved_source.read_text(encoding="utf-8", errors="replace")
    document = parse_html(markup)
    title_node = find_first(document, tag="h1")
    thesis, judgments, trends = parse_overview(document)

    layers: list[dict[str, Any]] = []
    forums: list[dict[str, Any]] = []
    current_layer = ""
    layer_order = 0
    for section in ordered_sections(document):
        section_id = section.attrs.get("id", "")
        if re.fullmatch(r"l\d+", section_id):
            layer_order += 1
            layers.append(parse_layer(section, layer_order))
            current_layer = section_id
        elif section_id in {"overview", "method"}:
            continue
        elif current_layer:
            forums.append(parse_forum(section, current_layer))

    trend_by_layer: dict[str, list[str]] = {}
    for trend in trends:
        trend_by_layer.setdefault(trend["layerId"], []).append(trend["id"])
    for layer in layers:
        layer["trendIds"] = trend_by_layer.get(layer["id"], [])
        layer["forumIds"] = [forum["id"] for forum in forums if forum["layerId"] == layer["id"]]

    method = parse_method(document)
    stat = resolved_source.stat()
    digest = hashlib.sha256(resolved_source.read_bytes()).hexdigest()[:16]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "mode": "local-content-highlights",
        "label": "云栖大会重点内容",
        "generatedAt": utc_iso(),
        "source": {
            "id": SOURCE_ID,
            "title": _valid_text(one_line(title_node, limit=200)) or resolved_source.stem,
            "origin": "本机文件 · 场景库",
            "relativePath": _valid_text(resolved_source.relative_to(resolved_root).as_posix()),
            "absolutePath": _valid_text(str(resolved_source)),
            "type": resolved_source.suffix[1:].upper(),
            "bytes": stat.st_size,
            "modifiedAt": utc_iso(stat.st_mtime),
            "digest": f"sha256:{digest}",
        },
        "thesis": thesis,
        "synthesis": judgments,
        "layers": layers,
        "trends": trends,
        "forums": forums,
        "method": method,
        "stats": {
            "layers": len(layers),
            "trends": len(trends),
            "synthesis": len(judgments),
            "forums": len(forums),
            "talks": sum(forum["talkCount"] for forum in forums),
            "gaps": sum(len(forum["gapNotes"]) for forum in forums) + len(method["gaps"]),
            "methodSections": len(method["sections"]),
        },
    }


def atomic_write_json(output_path: Path, payload: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            json.dump(payload, temporary, ensure_ascii=False, separators=(",", ":"))
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, output_path)
    finally:
        if temporary_name and Path(temporary_name).exists():
            Path(temporary_name).unlink()


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="生成云栖大会重点内容的本机结构化副本")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="云栖重点内容 HTML 源文件")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="允许的来源根目录")
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / ".local-cache/yunqi-highlights.json",
        help="本机结构化输出路径，禁止指向 public 或 dist",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output: Path = args.output
    if any(part in {"public", "dist"} for part in output.parts):
        raise YunqiHighlightsError("highlights output must stay out of public and dist")
    highlights = build_highlights(source_path=args.source, root=args.root)
    atomic_write_json(output, highlights)
    stats = highlights["stats"]
    print(
        "云栖重点内容完成："
        f"{stats['layers']} 层 / {stats['trends']} 条趋势 / {stats['synthesis']} 条综合判断 / "
        f"{stats['forums']} 场论坛 / {stats['talks']} 张讲者卡"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
