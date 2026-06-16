from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from typing import Any, Iterable

_FAILURE_STOP_REASONS = {"error", "aborted"}


@dataclass(frozen=True)
class TranscriptFailure:
    kind: str
    message: str
    stop_reason: str | None = None
    provider: str | None = None
    model: str | None = None
    event_type: str | None = None

    def to_metadata(self) -> dict[str, str]:
        return {k: v for k, v in asdict(self).items() if isinstance(v, str) and v}

    def format(self) -> str:
        parts = []
        if self.provider or self.model:
            parts.append("/".join(p for p in (self.provider, self.model) if p))
        if self.stop_reason:
            parts.append(f"stopReason={self.stop_reason}")
        prefix = f" ({', '.join(parts)})" if parts else ""
        return f"{self.message}{prefix}"


def iter_json_events(raw: str) -> Iterable[dict[str, Any]]:
    """Yield JSON object lines from a Spell JSONL transcript.

    Harbor captures stdout and stderr into the same transcript. Stderr can contain
    plain text, so transcript consumers must tolerate non-JSON lines.
    """
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def parse_transcript(raw: str) -> tuple[str | None, dict[str, int]]:
    """Extract final assistant text + additive usage from Spell JSONL."""
    last_text: str | None = None
    usage: dict[str, int] = {}
    for event in iter_json_events(raw):
        if event.get("type") == "assistant" and isinstance(event.get("text"), str):
            last_text = event["text"]

        message = event.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            if event.get("type") == "message_end":
                text = _assistant_text(message)
                if text is not None:
                    last_text = text
                _add_usage(usage, message.get("usage"))

        _add_usage(usage, event.get("usage"))
    return last_text, usage


def parse_transcript_failure(raw: str) -> TranscriptFailure | None:
    """Return the terminal assistant/model failure recorded in a Spell transcript.

    Handles both direct assistant error/abort messages and the retry controller's
    final auto-retry failure event. The latest failure wins because transcripts
    can contain multiple failed attempts.
    """
    failure: TranscriptFailure | None = None
    for event in iter_json_events(raw):
        message = event.get("message")
        if isinstance(message, dict):
            candidate = _failure_from_message(message, str(event.get("type") or ""))
            if candidate is not None:
                failure = candidate

        if event.get("type") == "auto_retry_end" and event.get("success") is False:
            final_error = event.get("finalError") or event.get("errorMessage")
            if isinstance(final_error, str) and final_error.strip():
                failure = TranscriptFailure(
                    kind="auto_retry",
                    message=final_error.strip(),
                    stop_reason=failure.stop_reason if failure else None,
                    provider=failure.provider if failure else None,
                    model=failure.model if failure else None,
                    event_type="auto_retry_end",
                )
    return failure


def _failure_from_message(message: dict[str, Any], event_type: str) -> TranscriptFailure | None:
    if message.get("role") != "assistant":
        return None
    stop_reason = message.get("stopReason")
    if stop_reason not in _FAILURE_STOP_REASONS:
        return None
    error_message = message.get("errorMessage")
    if not isinstance(error_message, str) or not error_message.strip():
        error_message = f"Assistant stopped with {stop_reason}"
    provider = message.get("provider")
    model = message.get("model")
    return TranscriptFailure(
        kind="assistant",
        message=error_message.strip(),
        stop_reason=str(stop_reason),
        provider=provider if isinstance(provider, str) else None,
        model=model if isinstance(model, str) else None,
        event_type=event_type or None,
    )


def _assistant_text(message: dict[str, Any]) -> str | None:
    content = message.get("content")
    if not isinstance(content, list):
        return None
    chunks = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text" and isinstance(item.get("text"), str):
            chunks.append(item["text"])
    if not chunks:
        return None
    return "".join(chunks)


def _add_usage(acc: dict[str, int], candidate: Any) -> None:
    if not isinstance(candidate, dict):
        return
    for key, value in candidate.items():
        if isinstance(value, int):
            acc[key] = acc.get(key, 0) + value
