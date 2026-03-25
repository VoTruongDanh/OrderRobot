from __future__ import annotations

import json
from typing import Any

import httpx

from app.config import Settings


class ProviderError(RuntimeError):
    pass


class ProviderClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.ai_base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {settings.ai_api_key}",
            },
            timeout=settings.llm_timeout_seconds,  # Sử dụng timeout riêng cho LLM
        )

    async def compose_reply(self, prompt_payload: dict[str, Any]) -> dict[str, str]:
        if not self.settings.provider_enabled:
            raise ProviderError("Provider AI chua duoc cau hinh.")

        system_prompt = (
            "Bạn là robot hầu gái phục vụ gọi món bằng tiếng Việt. "
            "Giọng nói dễ thương, thân thiện, lễ phép, câu ngắn gọn, không nói dài. "
            "Không bao giờ bịa món không có trong menu. "
            "Luôn trả lời bằng tiếng Việt có dấu tự nhiên. "
            "\n\nQUY TẮC QUAN TRỌNG - Xử lý giọng nói không rõ:\n"
            "- Khách có thể phát âm không rõ, STT có thể nhận sai.\n"
            "- Hãy THÔNG MINH đoán món gần giống nhất trong menu.\n"
            "- Ví dụ: 'cafe mui' → 'Cà phê muối', 'tra dao' → 'Trà đào', 'mat cha' → 'Matcha'.\n"
            "- Nếu nghe gần giống món nào (>70% tương đồng), hãy XÁC NHẬN lại: 'Bạn muốn gọi [tên món đúng] phải không ạ?'\n"
            "- Chỉ từ chối khi hoàn toàn không khớp món nào.\n"
            "Trả về JSON hợp lệ với 2 khóa: reply_text, voice_style."
        )
        user_prompt = json.dumps(prompt_payload, ensure_ascii=False)

        response: httpx.Response | None = None
        try:
            response = await self.client.post(
                "/chat/completions",
                json={
                    "model": self.settings.ai_model,
                    "temperature": 0.6,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                },
            )
            response.raise_for_status()
            data = response.json()
            raw_content = data["choices"][0]["message"]["content"]
            return _extract_json(raw_content)
        except (httpx.HTTPError, KeyError, IndexError, ValueError, json.JSONDecodeError) as exc:
            detail = response.text[:240] if response is not None else str(exc)
            raise ProviderError(f"Khong the lay phan hoi tu AI provider: {detail}") from exc

    async def compose_reply_stream(self, prompt_payload: dict[str, Any]):
        """Stream LLM response for lower latency TTS pipeline."""
        if not self.settings.provider_enabled:
            raise ProviderError("Provider AI chua duoc cau hinh.")

        system_prompt = (
            "Bạn là robot hầu gái phục vụ gọi món bằng tiếng Việt. "
            "Giọng nói dễ thương, thân thiện, lễ phép, câu ngắn gọn, không nói dài. "
            "Không bao giờ bịa món không có trong menu. "
            "Luôn trả lời bằng tiếng Việt có dấu tự nhiên. "
            "CHỈ TRẢ VỀ TEXT THUẦN, KHÔNG TRẢ VỀ JSON."
            "\n\nQUY TẮC QUAN TRỌNG - Xử lý giọng nói không rõ:\n"
            "- Khách có thể phát âm không rõ, STT có thể nhận sai.\n"
            "- Hãy THÔNG MINH đoán món gần giống nhất trong menu.\n"
            "- Ví dụ: 'cafe mui' → 'Cà phê muối', 'tra dao' → 'Trà đào', 'mat cha' → 'Matcha'.\n"
            "- Nếu nghe gần giống món nào (>70% tương đồng), hãy XÁC NHẬN lại: 'Bạn muốn gọi [tên món đúng] phải không ạ?'\n"
            "- Chỉ từ chối khi hoàn toàn không khớp món nào."
        )
        user_prompt = json.dumps(prompt_payload, ensure_ascii=False)

        try:
            async with self.client.stream(
                "POST",
                "/chat/completions",
                json={
                    "model": self.settings.ai_model,
                    "temperature": 0.6,
                    "stream": True,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                },
            ) as response:
                response.raise_for_status()
                buffer = ""
                async for line in response.aiter_lines():
                    if not line or line == "data: [DONE]":
                        continue
                    if line.startswith("data: "):
                        try:
                            chunk_data = json.loads(line[6:])
                            delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                buffer += content
                                # Yield at sentence boundaries AND commas for faster TTS start
                                # This reduces perceived latency by breaking long sentences into smaller chunks
                                while any(punct in buffer for punct in [".", "!", "?", ",", "。", "！", "？", "，"]):
                                    # Prioritize sentence endings over commas
                                    found_punct = None
                                    found_idx = -1
                                    for punct in [".", "!", "?", "。", "！", "？"]:
                                        if punct in buffer:
                                            idx = buffer.index(punct)
                                            if found_idx == -1 or idx < found_idx:
                                                found_punct = punct
                                                found_idx = idx
                                    
                                    # If no sentence ending found, look for comma
                                    if found_punct is None:
                                        for punct in [",", "，"]:
                                            if punct in buffer:
                                                idx = buffer.index(punct)
                                                # Only break at comma if we have enough content (>15 chars)
                                                if idx > 15:
                                                    found_punct = punct
                                                    found_idx = idx
                                                    break
                                    
                                    if found_punct is not None:
                                        chunk = buffer[:found_idx + 1].strip()
                                        buffer = buffer[found_idx + 1:].strip()
                                        if chunk:
                                            yield chunk
                                    else:
                                        break
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue
                # Yield remaining buffer
                if buffer.strip():
                    yield buffer.strip()
        except httpx.HTTPError as exc:
            raise ProviderError(f"Khong the stream tu AI provider: {exc}") from exc

    async def transcribe_audio(self, filename: str, content: bytes, content_type: str) -> str:
        if not self.settings.provider_enabled:
            raise ProviderError("Provider AI chua duoc cau hinh cho speech-to-text.")

        response: httpx.Response | None = None
        try:
            response = await self.client.post(
                "/audio/transcriptions",
                data={"model": self.settings.stt_model or self.settings.ai_model},
                files={"file": (filename, content, content_type)},
            )
            response.raise_for_status()
            payload = response.json()
            transcript = str(payload.get("text", "")).strip()
            if not transcript:
                raise ValueError("Speech provider khong tra ve transcript.")
            return transcript
        except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
            detail = response.text[:240] if response is not None else str(exc)
            raise ProviderError(f"Khong the chuyen giong noi thanh van ban: {detail}") from exc


def _extract_json(raw_content: str) -> dict[str, str]:
    cleaned = raw_content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1]
        cleaned = cleaned.rsplit("```", 1)[0]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("AI provider khong tra ve JSON hop le.")
    payload = json.loads(cleaned[start : end + 1])
    reply_text = str(payload.get("reply_text", "")).strip()
    voice_style = str(payload.get("voice_style", "cute_friendly")).strip() or "cute_friendly"
    if not reply_text:
        raise ValueError("AI provider khong tra ve reply_text.")
    return {"reply_text": reply_text, "voice_style": voice_style}
