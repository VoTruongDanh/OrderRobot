from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from app.config import get_settings
from app.models import (
    BridgeDebugChatRequest,
    BridgeDebugChatResponse,
    BridgeTemporaryChatResetResponse,
    ConversationResponse,
    FeedbackRequest,
    SessionStartRequest,
    SpeechSynthesisRequest,
    SpeechTranscriptionResponse,
    TTSConfigRequest,
    TurnRequest,
)
from app.services.conversation_engine import ConversationEngine
from app.services.conversation_engine import render_fallback_reply
from app.services.core_backend_client import CoreBackendClient
from app.services.provider_client import ProviderError
from app.services.speech_service import SpeechNotHeardError, SpeechService


settings = get_settings()
core_client = CoreBackendClient(settings.core_backend_url, settings.request_timeout_seconds)
speech_service = SpeechService(settings, core_client)
conversation_engine = ConversationEngine(settings, core_client, speech_service)
logger = logging.getLogger(__name__)

app = FastAPI(title="Order Robot AI Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def preload_speech_model() -> None:
    if not settings.stt_preload:
        return

    task = asyncio.create_task(speech_service.preload_stt())

    def report_preload_failure(background_task: asyncio.Task[None]) -> None:
        try:
            background_task.result()
        except Exception:
            logger.exception("STT preload failed")

    task.add_done_callback(report_preload_failure)


@app.on_event("shutdown")
async def shutdown_clients() -> None:
    await core_client.aclose()
    if conversation_engine.provider_client is not None:
        await conversation_engine.provider_client.aclose()


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "provider_enabled": settings.provider_enabled,
        "llm_mode": settings.llm_mode,
        "bridge_base_url": settings.bridge_base_url,
        "voice_style": settings.voice_style,
        "stt_model": settings.stt_model,
        "tts_voice": settings.tts_voice,
        "tts_rate": settings.tts_rate,
        "active_sessions": await conversation_engine.active_session_count(),
    }


@app.post("/debug/bridge-chat", response_model=BridgeDebugChatResponse)
async def debug_bridge_chat(payload: BridgeDebugChatRequest) -> BridgeDebugChatResponse:
    started_at = time.perf_counter()
    user_text = payload.text.strip()
    debug_rule = payload.rule.strip() if payload.rule else None

    prompt_payload: dict[str, object] = {
        "scene": "fallback",
        "seed": "Day la luong debug de kiem tra bridge web.",
        "cart_summary": [],
        "recommended_items": [],
        "needs_confirmation": False,
        "order_created": False,
        "voice_style": settings.voice_style,
        "user_text": user_text,
    }
    if debug_rule:
        prompt_payload["debug_rule"] = debug_rule

    provider_client = conversation_engine.provider_client
    if provider_client is None:
        fallback_text = render_fallback_reply(prompt_payload)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        return BridgeDebugChatResponse(
            reply_text=fallback_text,
            source="fallback",
            bridge_enabled=False,
            latency_ms=latency_ms,
            detail="Bridge provider is disabled (LLM_MODE != bridge_only).",
        )

    try:
        bridge_reply = await provider_client.compose_reply(prompt_payload)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        return BridgeDebugChatResponse(
            reply_text=bridge_reply.get("reply_text", "").strip(),
            source="bridge",
            bridge_enabled=True,
            latency_ms=latency_ms,
            detail=None,
        )
    except ProviderError as exc:
        fallback_text = render_fallback_reply(prompt_payload)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        return BridgeDebugChatResponse(
            reply_text=fallback_text,
            source="fallback",
            bridge_enabled=True,
            latency_ms=latency_ms,
            detail=str(exc),
        )


@app.post("/config/tts")
async def update_tts_config(payload: TTSConfigRequest) -> dict[str, str]:
    """Update TTS voice and rate at runtime without restarting backend."""
    if payload.voice is not None:
        settings.tts_voice = payload.voice
    if payload.rate is not None:
        settings.tts_rate = str(payload.rate)
    
    return {
        "status": "ok",
        "tts_voice": settings.tts_voice,
        "tts_rate": settings.tts_rate,
    }


@app.post("/sessions/start", response_model=ConversationResponse)
async def start_session(_: SessionStartRequest) -> ConversationResponse:
    try:
        return await conversation_engine.start_session()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Core backend khong san sang.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/sessions/{session_id}/turn", response_model=ConversationResponse)
async def handle_turn(session_id: str, payload: TurnRequest) -> ConversationResponse:
    try:
        return await conversation_engine.handle_turn(session_id, payload.transcript)
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or "Khong the tao don tu core backend."
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Khong the ket noi toi core backend.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/sessions/{session_id}/turn/stream")
async def handle_turn_stream(session_id: str, payload: TurnRequest) -> StreamingResponse:
    """Stream conversation response with interleaved text and audio chunks for lower latency."""
    try:
        async def response_stream():
            async for chunk in conversation_engine.handle_turn_stream(session_id, payload.transcript):
                # Yield JSON-encoded chunks: {"type": "text", "content": "..."} or {"type": "audio", "content": base64}
                yield json.dumps(chunk, ensure_ascii=False).encode("utf-8") + b"\n"

        return StreamingResponse(response_stream(), media_type="application/x-ndjson")
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or "Khong the tao don tu core backend."
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Khong the ket noi toi core backend.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/sessions/{session_id}/reset", response_model=ConversationResponse)
async def reset_session(session_id: str) -> ConversationResponse:
    return await conversation_engine.reset_session(session_id)


@app.post(
    "/sessions/{session_id}/bridge/reset-temp-chat",
    response_model=BridgeTemporaryChatResetResponse,
)
async def reset_bridge_temporary_chat(session_id: str) -> BridgeTemporaryChatResetResponse:
    provider_client = conversation_engine.provider_client
    if provider_client is None:
        return BridgeTemporaryChatResetResponse(
            ok=False,
            source="fallback",
            detail="Bridge provider is disabled (LLM_MODE != bridge_only).",
        )

    try:
        result = await provider_client.reset_temporary_chat(session_id)
        return BridgeTemporaryChatResetResponse(
            ok=bool(result.get("ok", False)),
            source="bridge",
            detail=str(result.get("detail") or "Bridge temporary chat reset completed."),
        )
    except ProviderError as exc:
        return BridgeTemporaryChatResetResponse(
            ok=False,
            source="fallback",
            detail=str(exc),
        )


@app.post("/sessions/{session_id}/feedback")
async def save_session_feedback(session_id: str, payload: FeedbackRequest) -> dict[str, str]:
    await conversation_engine.save_feedback(
        session_id=session_id,
        rating=payload.rating,
        comment=payload.comment,
        transcript_history=payload.transcript_history,
        needs_improvement=payload.needs_improvement,
        improvement_tags=payload.improvement_tags,
        review_status=payload.review_status,
    )
    return {"status": "ok"}


@app.post("/speech/synthesize")
async def synthesize_speech(payload: SpeechSynthesisRequest) -> Response:
    try:
        audio = await speech_service.synthesize(payload.text, payload.voice, payload.rate)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Khong the tao giong noi: {exc}") from exc

    return Response(content=audio.content, media_type=audio.media_type)


@app.post("/speech/synthesize/stream")
async def synthesize_speech_stream(payload: SpeechSynthesisRequest) -> StreamingResponse:
    try:
        async def audio_stream():
            async for chunk in speech_service.synthesize_stream(payload.text, payload.voice, payload.rate):
                yield chunk

        return StreamingResponse(audio_stream(), media_type="audio/mpeg")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Khong the tao giong noi: {exc}") from exc


@app.post("/speech/transcribe", response_model=SpeechTranscriptionResponse)
async def transcribe_speech(file: UploadFile = File(...)) -> SpeechTranscriptionResponse:
    try:
        transcript = await speech_service.transcribe(file)
        return SpeechTranscriptionResponse(transcript=transcript, status="ok")
    except SpeechNotHeardError as exc:
        return SpeechTranscriptionResponse(transcript="", status="retry", message=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.websocket("/speech/transcribe/ws")
async def transcribe_speech_ws(websocket: WebSocket) -> None:
    await websocket.accept()

    filename = "speech.webm"
    stream_mode = "order"
    audio_buffer = bytearray()
    partial_task: asyncio.Task[str] | None = None
    last_partial = ""
    last_partial_at = 0.0
    last_partial_size = 0
    min_partial_interval_sec = 0.32
    min_partial_delta_bytes = 6_000

    def configure_stream_mode(mode: str) -> None:
        nonlocal stream_mode, min_partial_interval_sec, min_partial_delta_bytes
        stream_mode = "caption" if mode == "caption" else "order"
        if stream_mode == "caption":
            min_partial_interval_sec = 0.22
            min_partial_delta_bytes = 3_000
        else:
            min_partial_interval_sec = 0.32
            min_partial_delta_bytes = 6_000

    async def flush_partial(*, force: bool = False) -> None:
        nonlocal partial_task, last_partial, last_partial_at, last_partial_size
        if partial_task is not None and not partial_task.done():
            return
        if not audio_buffer:
            return

        snapshot = bytes(audio_buffer)
        snapshot_size = len(snapshot)
        now = time.monotonic()
        if (
            not force
            and snapshot_size - last_partial_size < min_partial_delta_bytes
            and now - last_partial_at < min_partial_interval_sec
        ):
            return

        partial_task = asyncio.create_task(
            speech_service.transcribe_partial(snapshot, filename, mode=stream_mode)
        )
        try:
            transcript = await partial_task
        except Exception:
            logger.exception("Streaming partial STT failed")
            return
        finally:
            partial_task = None

        if transcript and transcript != last_partial:
            last_partial = transcript
            await websocket.send_json({"type": "partial", "transcript": transcript})
        last_partial_at = now
        last_partial_size = snapshot_size

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                audio_buffer.extend(message["bytes"])
                continue

            payload = message.get("text")
            if payload is None:
                continue

            if payload.startswith("start:"):
                parts = payload.split(":", 2)
                if len(parts) >= 3:
                    configure_stream_mode(parts[1])
                    filename = parts[2] or "speech.webm"
                else:
                    configure_stream_mode("order")
                    filename = parts[1] if len(parts) == 2 and parts[1] else "speech.webm"
                audio_buffer.clear()
                last_partial = ""
                last_partial_at = 0.0
                last_partial_size = 0
                continue

            if payload == "flush":
                await flush_partial()
                continue

            if payload == "finalize":
                if partial_task is not None and not partial_task.done():
                    partial_task.cancel()
                    partial_task = None

                try:
                    snapshot = bytes(audio_buffer)
                    if not snapshot:
                        await websocket.send_json(
                            {
                                "type": "final",
                                "status": "retry",
                                "transcript": "",
                                "message": "Minh nghe chua ro, ban noi lai giup minh nhe.",
                            },
                        )
                        continue

                    await flush_partial(force=True)
                    if stream_mode == "order" and last_partial and speech_service.is_actionable_transcript(last_partial):
                        await websocket.send_json(
                            {"type": "final", "status": "ok", "transcript": last_partial},
                        )
                        audio_buffer.clear()
                        continue

                    final_transcript = await speech_service.transcribe_bytes(
                        snapshot,
                        filename,
                        mode=stream_mode,
                    )
                    await websocket.send_json(
                        {"type": "final", "status": "ok", "transcript": final_transcript},
                    )
                except SpeechNotHeardError as exc:
                    await websocket.send_json(
                        {"type": "final", "status": "retry", "transcript": "", "message": str(exc)},
                    )
                except Exception as exc:
                    await websocket.send_json(
                        {"type": "final", "status": "error", "message": str(exc), "transcript": ""},
                    )
                finally:
                    audio_buffer.clear()
                continue
    except WebSocketDisconnect:
        return
