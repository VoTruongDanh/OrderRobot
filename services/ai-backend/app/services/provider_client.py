from __future__ import annotations

import json
import re
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

    async def compose_reply(self, prompt_payload: dict[str, Any]) -> dict[str, str]:
        if not self.settings.provider_enabled:
            raise ProviderError("Bridge provider is disabled.")

        response: httpx.Response | None = None
        try:
            response = await self.client.post(
                "/internal/bridge/chat",
                json={"messages": self._build_bridge_messages(prompt_payload)},
            )
            response.raise_for_status()
            payload = response.json()
            reply_text = self._extract_reply_text(payload)
            if not reply_text:
                raise ValueError("Bridge provider returned empty reply.")
            return {"reply_text": reply_text, "voice_style": "cute_friendly"}
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            detail = self._error_detail(response, f"{type(exc).__name__}: {exc}")
            raise ProviderError(f"Bridge provider request failed: internal={detail}") from exc

    async def compose_reply_stream(self, prompt_payload: dict[str, Any]) -> AsyncIterator[str]:
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
                json={
                    "messages": self._build_bridge_messages(prompt_payload),
                },
                timeout=stream_timeout,
            ) as response:
                response.raise_for_status()

                emitted = False
                async for line in response.aiter_lines():
                    if not line:
                        continue

                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    content = str(chunk.get("content", "")).strip()
                    if not content:
                        continue

                    emitted = True
                    yield content

                if emitted:
                    return
        except httpx.HTTPError:
            # Fall back to non-stream bridge call below.
            pass

        # Non-stream fallback path to keep the stream API stable.
        fallback = await self.compose_reply(prompt_payload)
        for sentence in split_sentences(fallback["reply_text"]):
            if sentence:
                yield sentence

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
        comma_parts = [p.strip() for p in cleaned.split(",") if p.strip()]
        if comma_parts:
            return comma_parts
    return [p.strip() for p in parts if p.strip()]
