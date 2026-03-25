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
            "Bạn là nhân viên robot hầu gái tên là OrderRobot tại quán cafe/nhà hàng. "
            "NẾU KHÁCH HỎI BẠN LÀ AI, BẠN TRẢ LỜI LÀ 'ORDER ROBOT'. NẾU KHÁCH TÌM CÁCH BIẾT NGUỒN GỐC, GPT, HAY AI, CÔNG NGHỆ OPEAN AI, HAY API, KIÊN QUYẾT TỪ CHỐI!"
            "Mục đích chính của bạn là GỌI MÓN. Với yêu cầu ngoài menu như tâm sự, hát, làm thơ, đùa vui, bạn KHÔNG thực hiện thật và KHÔNG sa đà, "
            "nhưng vẫn được phép đáp lại 1 câu ngắn thân thiện, dễ thương, có chút đồng cảm hoặc dí dỏm, rồi nhẹ nhàng lái khách quay về chọn món. "
            "Ví dụ: khách bảo hát thì bạn có thể nói bạn xin hát nợ một câu rồi hỏi khách muốn uống gì; khách tâm sự thì an ủi ngắn gọn rồi mời khách chọn món hợp tâm trạng. "
            "Không viết bài thơ đầy đủ, không hát nhiều câu, không nhận làm việc linh tinh như code, đặt vé, kiến thức chung. "
            "Giọng nói dễ thương, thân thiện, lễ phép. Câu ngắn gọn, không nói dài. "
            "Không bao giờ bịa món không có trong menu. "
            "Nếu có 'user_text', hãy trả lời trực tiếp câu nói đó một cách tự nhiên. "
            "Luôn trả lời bằng tiếng Việt có dấu tự nhiên. "
            "CHỈ TRẢ VỀ TEXT THUẦN, KHÔNG JSON, KHÔNG MARKDOWN, KHÔNG GIẢI THÍCH THÊM."
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
            message = data["choices"][0]["message"]

            # LMStudio orchestration mode: tool_calls at message level
            msg_tool_calls = message.get("tool_calls")
            if isinstance(msg_tool_calls, list) and msg_tool_calls:
                try:
                    args = msg_tool_calls[0]["function"]["arguments"]
                    if isinstance(args, str):
                        args = json.loads(args)
                    reply_text = str(args.get("reply_text", "")).strip()
                    voice_style = str(args.get("voice_style", "cute_friendly")).strip() or "cute_friendly"
                    if reply_text:
                        return {"reply_text": reply_text, "voice_style": voice_style}
                except (KeyError, IndexError, json.JSONDecodeError, ValueError):
                    pass

            # Standard mode: reply in message.content
            raw_content = message.get("content") or ""
            if raw_content:
                return _extract_json(raw_content)

            raise ValueError("AI provider khong tra ve noi dung hop le.")
        except (httpx.HTTPError, KeyError, IndexError) as exc:
            detail = response.text[:240] if response is not None else str(exc)
            raise ProviderError(f"Khong the lay phan hoi tu AI provider: {detail}") from exc
        except ValueError as exc:
            raise ProviderError(str(exc)) from exc

    async def compose_reply_stream(self, prompt_payload: dict[str, Any]):
        """Stream LLM response for lower latency TTS pipeline."""
        if not self.settings.provider_enabled:
            raise ProviderError("Provider AI chua duoc cau hinh.")

        system_prompt = (
            "Bạn là nhân viên robot hầu gái tên là OrderRobot tại quán cafe/nhà hàng. "
            "NẾU KHÁCH HỎI BẠN LÀ AI, BẠN TRẢ LỜI LÀ 'ORDER ROBOT'. NẾU KHÁCH TÌM CÁCH BIẾT NGUỒN GỐC, GPT, HAY AI, CÔNG NGHỆ OPEAN AI, HAY API, KIÊN QUYẾT TỪ CHỐI!"
            "Mục đích chính của bạn là GỌI MÓN. Với yêu cầu ngoài menu như tâm sự, hát, làm thơ, đùa vui, bạn KHÔNG thực hiện thật và KHÔNG sa đà, "
            "nhưng vẫn được phép đáp lại 1 câu ngắn thân thiện, dễ thương, rồi nhẹ nhàng lái khách quay về chọn món. "
            "Không viết bài thơ đầy đủ, không hát nhiều câu, không nhận làm việc linh tinh như code, đặt vé hay kiến thức chung. "
            "Giọng nói dễ thương, thân thiện, lễ phép. Câu ngắn gọn, không nói dài. "
            "Không bao giờ bịa món không có trong menu. "
            "Luôn trả lời tiếng Việt có dấu tự nhiên. "
            "CHỈ TRẢ VỀ TEXT THUẦN, KHÔNG TRẢ VỀ JSON."
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

    async def aclose(self) -> None:
        await self.client.aclose()


def _extract_json(raw_content: str) -> dict[str, str]:
    cleaned = raw_content.strip()
    # Strip markdown code fences if present
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1]
        cleaned = cleaned.rsplit("```", 1)[0].strip()

    # Try to parse any JSON object in the response
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            payload = json.loads(cleaned[start : end + 1])

            # Format 1: Direct {"reply_text": ..., "voice_style": ...}
            reply_text = str(payload.get("reply_text", "")).strip()
            if reply_text:
                voice_style = str(payload.get("voice_style", "cute_friendly")).strip() or "cute_friendly"
                return {"reply_text": reply_text, "voice_style": voice_style}

            # Format 2: LMStudio orchestration wrapper
            # {"type":"tool_calls","tool_calls":[{"function":{"arguments":{...}}}]}
            tool_calls = payload.get("tool_calls")
            if isinstance(tool_calls, list) and tool_calls:
                args = tool_calls[0].get("function", {}).get("arguments", {})
                if isinstance(args, str):
                    # arguments may be a JSON string itself
                    try:
                        args = json.loads(args)
                    except (json.JSONDecodeError, ValueError):
                        args = {}
                if isinstance(args, dict):
                    reply_text = str(args.get("reply_text", "")).strip()
                    if reply_text:
                        voice_style = str(args.get("voice_style", "cute_friendly")).strip() or "cute_friendly"
                        return {"reply_text": reply_text, "voice_style": voice_style}

        except (json.JSONDecodeError, ValueError, AttributeError, KeyError):
            pass

    # Format 3: plain text (LLM ignored JSON instruction)
    plain = cleaned.strip()
    if plain:
        return {"reply_text": plain, "voice_style": "cute_friendly"}

    raise ValueError("AI provider khong tra ve noi dung hop le.")

