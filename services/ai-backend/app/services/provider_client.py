from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, AsyncIterator

import httpx

from app.config import Settings


class ProviderError(RuntimeError):
    pass


SYSTEM_PROMPT = (
    "Ban la nhan vien robot hau gai ten la OrderRobot tai quan cafe/nha hang. "
    "NEU KHACH HOI BAN LA AI, BAN TRA LOI LA 'ORDER ROBOT'. "
    "Muc dich chinh cua ban la GOI MON. "
    "Voi yeu cau ngoai menu nhu tam su, hat, lam tho, dua vui, ban tra loi ngan gon than thien "
    "roi lai khach quay ve chon mon. "
    "Khong viet markdown, khong tra ve json. "
    "Luon tra loi bang tieng Viet tu nhien."
)


class ProviderClient:
    """
    Bridge-only provider client.
    This client no longer calls external LLM APIs directly.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.bridge_base_url.rstrip("/"),
            timeout=settings.bridge_timeout_seconds,
        )

    def _build_bridge_messages(self, prompt_payload: dict[str, Any]) -> list[dict[str, str]]:
        user_prompt = json.dumps(prompt_payload, ensure_ascii=False)
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

    def _build_bridge_request_payload(
        self,
        prompt_payload: dict[str, Any],
        *,
        session_id: str | None = None,
        turn_id: str | None = None,
        latest_wins: bool = True,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "messages": self._build_bridge_messages(prompt_payload),
            "latest_wins": latest_wins,
        }
        if session_id:
            payload["session_id"] = session_id
        if turn_id:
            payload["turn_id"] = turn_id
        return payload

    @staticmethod
    def _error_detail(response: httpx.Response | None, fallback_message: str) -> str:
        if response is None:
            return fallback_message
        try:
            text = response.text.strip()
            if text:
                return text[:240]
        except Exception:
            pass
        return f"HTTP {response.status_code}"

    async def compose_reply(
        self,
        prompt_payload: dict[str, Any],
        *,
        session_id: str | None = None,
        turn_id: str | None = None,
        latest_wins: bool = True,
    ) -> dict[str, str]:
        if not self.settings.provider_enabled:
            raise ProviderError("Bridge provider is disabled.")

        response: httpx.Response | None = None
        try:
            response = await self.client.post(
                "/internal/bridge/chat",
                json=self._build_bridge_request_payload(
                    prompt_payload,
                    session_id=session_id,
                    turn_id=turn_id,
                    latest_wins=latest_wins,
                ),
            )
            response.raise_for_status()
            payload = response.json()
            reply_text = self._extract_reply_text(payload)
            if not reply_text:
                raise ValueError("Bridge provider returned empty reply.")
            return {
                "reply_text": reply_text,
                "voice_style": "cute_friendly",
                "source": str(payload.get("source") or "bridge"),
                "code": str(payload.get("code") or "ok"),
                "reason": str(payload.get("reason") or ""),
            }
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            detail = self._error_detail(response, f"{type(exc).__name__}: {exc}")
            raise ProviderError(f"Bridge provider request failed: internal={detail}") from exc

    async def reset_temporary_chat(self, session_id: str) -> dict[str, Any]:
        if not self.settings.provider_enabled:
            raise ProviderError("Bridge provider is disabled.")

        response: httpx.Response | None = None
        try:
            response = await self.client.post(
                "/internal/bridge/reset-temp-chat",
                json={"session_id": session_id},
            )
            response.raise_for_status()
            payload = response.json()
            if not bool(payload.get("ok", False)):
                raise ValueError(payload.get("detail") or "Bridge reset endpoint returned ok=false")
            return payload
        except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError) as exc:
            detail = self._error_detail(response, f"{type(exc).__name__}: {exc}")
            raise ProviderError(f"Bridge temporary chat reset failed: internal={detail}") from exc

    async def compose_reply_stream(
        self,
        prompt_payload: dict[str, Any],
        *,
        session_id: str | None = None,
        turn_id: str | None = None,
        latest_wins: bool = True,
    ) -> AsyncIterator[str]:
        if not self.settings.provider_enabled:
            raise ProviderError("Bridge provider is disabled.")

        stream_timeout = httpx.Timeout(
            connect=self.settings.bridge_timeout_seconds,
            read=self.settings.bridge_stream_timeout_seconds,
            write=self.settings.bridge_timeout_seconds,
            pool=self.settings.bridge_timeout_seconds,
        )

        try:
            async with self.client.stream(
                "POST",
                "/internal/bridge/chat/stream",
                json=self._build_bridge_request_payload(
                    prompt_payload,
                    session_id=session_id,
                    turn_id=turn_id,
                    latest_wins=latest_wins,
                ),
                timeout=stream_timeout,
            ) as response:
                response.raise_for_status()

                emitted = False
                pending_text = ""
                async for line in response.aiter_lines():
                    if not line:
                        continue

                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    chunk_type = str(chunk.get("type", "")).strip().lower()
                    if chunk_type == "error":
                        error_code = str(chunk.get("code", "")).strip() or "bridge_stream_error"
                        error_message = str(chunk.get("message", "")).strip() or "Bridge stream returned error."
                        raise ProviderError(f"Bridge provider stream failed: code={error_code} message={error_message}")
                    if chunk_type in {"done", "", "text_final"}:
                        continue

                    if chunk_type not in {"text", "content"}:
                        continue

                    content = str(chunk.get("content", ""))
                    if not content:
                        continue

                    pending_text = append_stream_content(pending_text, content)
                    completed_sentences, pending_text = split_completed_sentences(pending_text)
                    for sentence in completed_sentences:
                        emitted = True
                        yield sentence

                trailing = pending_text.strip()
                if trailing:
                    emitted = True
                    yield trailing

                if emitted:
                    return
        except httpx.HTTPError:
            # Fall back to non-stream bridge call below.
            pass

        # Non-stream fallback path to keep the stream API stable.
        fallback = await self.compose_reply(
            prompt_payload,
            session_id=session_id,
            turn_id=turn_id,
            latest_wins=latest_wins,
        )
        for sentence in split_sentences(fallback["reply_text"]):
            if sentence:
                yield sentence

    async def ping(self, *, timeout_seconds: float | None = None) -> bool:
        if not self.settings.provider_enabled:
            return False

        timeout = timeout_seconds if timeout_seconds is not None else min(5.0, self.settings.bridge_timeout_seconds)
        try:
            response = await self.client.get("/ping", timeout=timeout)
            if response.status_code == 404:
                response = await self.client.get("/health", timeout=timeout)
            response.raise_for_status()
            return True
        except httpx.HTTPError as exc:
            raise ProviderError(f"Bridge ping failed: {exc}") from exc

    async def transcribe_audio(self, _filename: str, _content: bytes, _content_type: str) -> str:
        raise ProviderError("Audio transcription via provider is disabled in bridge-only mode.")

    async def aclose(self) -> None:
        await self.client.aclose()

    def _extract_reply_text(self, payload: dict[str, Any]) -> str:
        if isinstance(payload.get("reply_text"), str):
            return payload["reply_text"].strip()

        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            message = choices[0].get("message", {})
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content.strip()

        content = payload.get("content")
        if isinstance(content, str):
            return content.strip()

        return ""


def split_sentences(text: str) -> list[str]:
    cleaned = text.strip()
    if not cleaned:
        return []
    parts = re.split(r"(?<=[\.\!\?])\s+", cleaned)
    if parts and len(parts) == 1:
        comma_parts = [_heal_split_words(p.strip()) for p in cleaned.split(",") if p.strip()]
        if comma_parts:
            return comma_parts
    return [_heal_split_words(p.strip()) for p in parts if p.strip()]


STREAM_SENTENCE_END_MARKERS = {".", "!", "?", "。", "！", "？", "\n"}

STREAM_WORD_JOIN_EXCEPTIONS = {
    "menu",
    "robot",
    "orderrobot",
    "chatgpt",
}


def _strip_diacritics(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text)
    return "".join(char for char in normalized if unicodedata.category(char) != "Mn")


def _tail_alpha_fragment(text: str) -> str:
    if not text:
        return ""
    index = len(text) - 1
    while index >= 0 and text[index].isalpha():
        index -= 1
    return text[index + 1 :]


def _head_alpha_fragment(text: str) -> str:
    if not text:
        return ""
    index = 0
    while index < len(text) and text[index].isalpha():
        index += 1
    return text[:index]


def _has_vowel(token: str) -> bool:
    folded = _strip_diacritics(token).lower()
    return any(char in "aeiouy" for char in folded)


def _looks_like_split_word(buffer: str, piece: str) -> bool:
    tail_fragment = _tail_alpha_fragment(buffer)
    head_fragment = _head_alpha_fragment(piece)
    if not tail_fragment or not head_fragment:
        return False

    combined = f"{tail_fragment}{head_fragment}".lower()
    if combined in STREAM_WORD_JOIN_EXCEPTIONS:
        return True

    tail_no_vowel = not _has_vowel(tail_fragment)
    head_no_vowel = not _has_vowel(head_fragment)
    if (len(tail_fragment) <= 2 and tail_no_vowel) or (len(head_fragment) <= 2 and head_no_vowel):
        return True

    if len(tail_fragment) == 1 and tail_fragment.isalpha():
        return True

    return False


def _heal_split_words(text: str) -> str:
    cleaned = str(text or "")
    if not cleaned:
        return ""

    tokens = cleaned.split()
    if len(tokens) < 2:
        return cleaned

    merged: list[str] = []
    index = 0
    while index < len(tokens):
        current = tokens[index]
        if index < len(tokens) - 1:
            nxt = tokens[index + 1]
            if _tail_alpha_fragment(current) and _head_alpha_fragment(nxt):
                if _looks_like_split_word(current, nxt):
                    current = f"{current}{nxt}"
                    index += 1
        merged.append(current)
        index += 1

    return " ".join(merged)


def append_stream_content(buffer: str, content: str) -> str:
    piece = str(content or "")
    if not piece:
        return buffer
    if not buffer:
        return piece

    if piece[0].isspace() or buffer[-1].isspace():
        combined = f"{buffer}{piece}"
        return _heal_split_words(combined)
    if piece[0] in ".,!?;:)]}":
        combined = f"{buffer}{piece}"
        return _heal_split_words(combined)
    if _looks_like_split_word(buffer, piece):
        combined = f"{buffer}{piece}"
        return _heal_split_words(combined)
    combined = f"{buffer} {piece}"
    return _heal_split_words(combined)


def split_completed_sentences(buffer: str) -> tuple[list[str], str]:
    if not buffer:
        return [], ""

    completed: list[str] = []
    start = 0
    for index, char in enumerate(buffer):
        if char not in STREAM_SENTENCE_END_MARKERS:
            continue
        sentence = buffer[start : index + 1].strip()
        if sentence:
            completed.append(sentence)
        start = index + 1

    remainder = buffer[start:]
    return completed, remainder
