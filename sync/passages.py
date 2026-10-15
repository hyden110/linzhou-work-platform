"""Select bounded, evenly distributed passages from extracted document segments."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence

_CITE_BLOCK = re.compile(r"<cite>.*?</cite>", re.DOTALL | re.IGNORECASE)
_HTML_TAG = re.compile(r"</?[A-Za-z][^>]{0,80}>")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LOCAL_LINK = re.compile(r"\[([^\]]*)\]\((?:file://|#)[^)]*\)")
_BARE_FILE_URL = re.compile(r"file://\S+")
_SENTENCE_END = re.compile(r"(?<=[。！？；!?;\n])")
_TOC_LOCATOR = re.compile(r"(?:^|/)\s*(?:目录|table of contents|contents)\s*$", re.IGNORECASE)
MIN_PASSAGE_CHARACTERS = 4


@dataclass(frozen=True)
class Passage:
    locator_kind: str
    locator: str
    text: str


@dataclass(frozen=True)
class _Section:
    locator_kind: str
    locator: str
    text: str


def clean_text(value: str) -> str:
    text = _CITE_BLOCK.sub(" ", value)
    text = _IMAGE.sub(" ", text)
    text = _LOCAL_LINK.sub(r"\1", text)
    text = _BARE_FILE_URL.sub(" ", text)
    text = _HTML_TAG.sub(" ", text)
    lines = (re.sub(r"[ \t\u3000]+", " ", line).strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line and line not in {"-", "*", "|"})


def _is_table_of_contents(locator: str, text: str) -> bool:
    if _TOC_LOCATOR.search(locator):
        return True
    lines = text.split("\n")
    numbered = sum(1 for line in lines if re.match(r"^\d+[.、]\s*\S{1,20}$", line))
    return len(lines) >= 4 and numbered / len(lines) > 0.8


def _merged_sections(segments: Iterable[object]) -> list[_Section]:
    sections: list[_Section] = []
    for segment in segments:
        kind = str(getattr(segment, "locator_kind", "") or "")
        locator = str(getattr(segment, "locator", "") or "")
        text = clean_text(str(getattr(segment, "text", "") or ""))
        if not kind or not locator or not text:
            continue
        if sections and (sections[-1].locator_kind, sections[-1].locator) == (kind, locator):
            sections = [*sections[:-1], _Section(kind, locator, f"{sections[-1].text}\n{text}")]
        else:
            sections = [*sections, _Section(kind, locator, text)]
    return [
        section for section in sections
        if len(section.text) >= MIN_PASSAGE_CHARACTERS and not _is_table_of_contents(section.locator, section.text)
    ]


def _windows(text: str, limit: int, count: int) -> list[str]:
    windows: list[str] = []
    current = ""
    for sentence in (part for part in _SENTENCE_END.split(text) if part.strip()):
        pieces = [sentence[index : index + limit] for index in range(0, len(sentence), limit)]
        for piece in pieces:
            if current and len(current) + len(piece) > limit:
                windows = [*windows, current.strip()]
                current = ""
                if len(windows) == count:
                    return windows
            current += piece
    if current.strip() and len(windows) < count:
        windows = [*windows, current.strip()]
    return [window for window in windows if len(window) >= MIN_PASSAGE_CHARACTERS]


def _even_indices(total: int, wanted: int) -> list[int]:
    if total <= wanted:
        return list(range(total))
    return sorted({round(position * (total - 1) / (wanted - 1)) for position in range(wanted)})


def select_passages(
    segments: Sequence[object],
    *,
    max_passages: int,
    max_characters: int,
    max_windows_per_section: int,
) -> list[Passage]:
    sections = _merged_sections(segments)
    windows = [_windows(section.text, max_characters, max_windows_per_section) for section in sections]
    usable = [index for index, items in enumerate(windows) if items]
    chosen = {index: 1 for index in (usable[position] for position in _even_indices(len(usable), max_passages))}
    for depth in range(1, max_windows_per_section):
        for index in usable:
            if sum(chosen.values()) >= max_passages:
                break
            if index in chosen and len(windows[index]) > depth and chosen[index] == depth:
                chosen = {**chosen, index: depth + 1}
    return [
        Passage(sections[index].locator_kind, sections[index].locator, window)
        for index in sorted(chosen)
        for window in windows[index][: chosen[index]]
    ]


def summary_text(segments: Sequence[object], limit: int) -> str:
    parts = [section.text for section in _merged_sections(segments)]
    return "\n\n".join(parts)[:limit].strip()
