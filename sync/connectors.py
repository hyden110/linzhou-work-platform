"""Connector contracts for future authenticated sync implementations.

This module intentionally contains no credentials or network calls. Implementations must
keep credentials on-device and return metadata, summaries and bounded citations only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Protocol

YUNQI_CONTENT_TYPES = frozenset({"forum", "exhibitor", "subscription", "summary"})


@dataclass(frozen=True)
class SyncCursor:
    updated_after: datetime | None = None
    continuation_token: str | None = None


@dataclass(frozen=True)
class ConnectorDocument:
    external_id: str
    title: str
    updated_at: datetime
    source_url: str
    content_type: str
    metadata: Mapping[str, Any]


class Connector(Protocol):
    source_id: str

    def iter_changes(self, cursor: SyncCursor) -> Iterable[ConnectorDocument]:
        """Yield authorized metadata changes after the supplied cursor."""


class DingTalkOwnedDocumentConnector(Protocol):
    """钉钉接口约束：仅返回 owner_user_id == current_user_id 且当前仍可访问的文档。"""

    source_id: str
    current_user_id: str

    def iter_owned_documents(self, cursor: SyncCursor) -> Iterable[ConnectorDocument]:
        """Return only documents created by the signed-in user; never return attachments."""


class QianwenYunqiJsonConnector(Protocol):
    """qianwen CLI JSON 接口约束：读取本机 JSON，不接收或持久化 CLI 凭证。"""

    source_id: str

    def parse_json_records(self, payload: Mapping[str, Any]) -> Iterable[ConnectorDocument]:
        """Normalize forum/exhibitor/subscription/summary records with event year metadata."""


def validate_yunqi_content_type(content_type: str) -> str:
    normalized = content_type.strip().casefold()
    if normalized not in YUNQI_CONTENT_TYPES:
        allowed = ", ".join(sorted(YUNQI_CONTENT_TYPES))
        raise ValueError(f"Unsupported Yunqi content type; expected one of: {allowed}")
    return normalized
