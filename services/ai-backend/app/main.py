from __future__ import annotations

import asyncio
import base64
import io
from importlib import metadata as importlib_metadata
import json
import logging
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Awaitable
import wave

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from dotenv import dotenv_values

from app.config import ENV_CONFIG_PATH, get_settings
from app.config import ROOT_DIR
from app.models import (
    BridgeDebugChatRequest,
    BridgeDebugChatResponse,
    BridgeTemporaryChatResetResponse,
    ConversationResponse,
    EnvLoadRequest,
    EnvLoadResponse,
    EnvSyncRequest,
    EnvSyncResponse,
    FeedbackRequest,
    SharedAdminStateResponse,
    SharedAdminStateSyncRequest,
    SessionStartRequest,
    SpeechSynthesisRequest,
    SpeechTranscriptionResponse,
    TTSConfigRequest,
    TurnRequest,
)
from app.services.conversation_engine import ConversationEngine
from app.services.conversation_engine import render_fallback_reply
from app.services.conversation_engine import render_lite_bridge_required_reply
from app.services.core_backend_client import CoreBackendClient
from app.services.provider_client import ProviderError, split_sentences
from app.services.speech_service import SpeechNotHeardError, SpeechService


settings = get_settings()
core_client = CoreBackendClient(settings.core_backend_url, settings.request_timeout_seconds)
speech_service = SpeechService(settings, core_client)
conversation_engine = ConversationEngine(settings, core_client, speech_service)
logger = logging.getLogger("uvicorn.error")
SUPPORTED_TTS_ENGINES = {"auto", "vieneu", "edge", "local", "pyttsx3"}
VIENEU_INSTALL_TIMEOUT_SECONDS = 900
bridge_keepalive_task: asyncio.Task[None] | None = None
ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENV_ASSIGNMENT_PATTERN = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
SHARED_ADMIN_STATE_PATH = ROOT_DIR / "data" / "shared-admin-state.json"

app = FastAPI(title="Order Robot AI Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _serialize_env_value(raw_value: str) -> str:
    clean_value = str(raw_value or "").replace("\r", " ").replace("\n", " ").strip()
    if not clean_value:
        return ""
    if any(token in clean_value for token in ('"', "'", "#")) or any(ch.isspace() for ch in clean_value):
        escaped = clean_value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return clean_value


def _safe_json_text(payload: object) -> str:
    """Serialize JSON and replace invalid surrogate code points safely for streaming."""
    return json.dumps(payload, ensure_ascii=False).encode("utf-8", errors="replace").decode("utf-8")


def _safe_sse_data(payload: object) -> str:
    return f"data: {_safe_json_text(payload)}\n\n"


def _safe_ndjson_line(payload: object) -> bytes:
    return _safe_json_text(payload).encode("utf-8") + b"\n"


def _write_env_updates(env_path: Path, updates: dict[str, str]) -> None:
    env_path.parent.mkdir(parents=True, exist_ok=True)
    if env_path.exists():
        original_lines = env_path.read_text(encoding="utf-8-sig").splitlines()
    else:
        original_lines = []

    written: set[str] = set()
    next_lines: list[str] = list(original_lines)
    for index, line in enumerate(original_lines):
        if line.lstrip().startswith("#"):
            continue
        match = ENV_ASSIGNMENT_PATTERN.match(line)
        if not match:
            continue
        key = match.group(1)
        if key not in updates:
            continue
        next_lines[index] = f"{key}={_serialize_env_value(updates[key])}"
        written.add(key)

    for key, value in updates.items():
        if key in written:
            continue
        next_lines.append(f"{key}={_serialize_env_value(value)}")

    content = "\n".join(next_lines).rstrip()
    env_path.write_text(f"{content}\n" if content else "", encoding="utf-8")


def _read_env_values(env_path: Path, keys: set[str]) -> dict[str, str]:
    if not env_path.exists():
        return {}
    parsed = dotenv_values(env_path)
    values: dict[str, str] = {}
    for raw_key, raw_value in parsed.items():
        key = str(raw_key or "").strip()
        if not key or not ENV_KEY_PATTERN.match(key):
            continue
        if keys and key not in keys:
            continue
        values[key] = "" if raw_value is None else str(raw_value)
    return values


def _read_shared_admin_state(state_path: Path) -> dict[str, object]:
    if not state_path.exists():
        return {}
    try:
        raw = state_path.read_text(encoding="utf-8").strip()
        if not raw:
            return {}
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _write_shared_admin_state(state_path: Path, updates: dict[str, object]) -> dict[str, object]:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    current = _read_shared_admin_state(state_path)
    next_state = dict(current)
    next_state.update(updates)
    state_path.write_text(json.dumps(next_state, ensure_ascii=False, indent=2), encoding="utf-8")
    return next_state


@app.on_event("startup")
async def preload_speech_model() -> None:
    preload_jobs: list[Awaitable[None]] = []
    if settings.stt_preload:
        preload_jobs.append(speech_service.preload_stt())
    if settings.tts_preload:
        preload_jobs.append(speech_service.preload_tts())

    if not preload_jobs:
        return

    preload_started_at = time.perf_counter()
    try:
        await asyncio.wait_for(asyncio.gather(*preload_jobs), timeout=180.0)
        logger.info("speech_preload_ms=%s status=ok", int((time.perf_counter() - preload_started_at) * 1000))
    except asyncio.TimeoutError:
        logger.warning(
            "speech_preload_ms=%s status=timeout budget_s=180",
            int((time.perf_counter() - preload_started_at) * 1000),
        )
    except Exception:
        logger.exception(
            "speech_preload_ms=%s status=error",
            int((time.perf_counter() - preload_started_at) * 1000),
        )


@app.on_event("startup")
async def start_bridge_keepalive() -> None:
    global bridge_keepalive_task
    provider_client = conversation_engine.provider_client
    if provider_client is None or not settings.bridge_keepalive_enabled:
        return
    if bridge_keepalive_task is not None and not bridge_keepalive_task.done():
        return
    bridge_keepalive_task = asyncio.create_task(_bridge_keepalive_loop())


@app.on_event("shutdown")
async def shutdown_clients() -> None:
    global bridge_keepalive_task
    if bridge_keepalive_task is not None:
        bridge_keepalive_task.cancel()
        try:
            await bridge_keepalive_task
        except asyncio.CancelledError:
            pass
        finally:
            bridge_keepalive_task = None

    await core_client.aclose()
    if conversation_engine.provider_client is not None:
        await conversation_engine.provider_client.aclose()


@app.get("/health")
async def health() -> dict[str, object]:
    vieneu_diag = speech_service.get_vieneu_diagnostics()
    return {
        "status": "ok",
        "provider_enabled": settings.provider_enabled,
        "llm_mode": settings.llm_mode,
        "bridge_base_url": settings.bridge_base_url,
        "bridge_keepalive_enabled": settings.bridge_keepalive_enabled,
        "bridge_keepalive_interval_seconds": settings.bridge_keepalive_interval_seconds,
        "bridge_keepalive_timeout_seconds": settings.bridge_keepalive_timeout_seconds,
        "voice_style": settings.voice_style,
        "tts_engine": settings.tts_engine,
        "stt_model": settings.stt_model,
        "tts_voice": settings.tts_voice,
        "tts_rate": settings.tts_rate,
        "tts_vieneu_model_path": settings.tts_vieneu_model_path,
        "tts_vieneu_mode": settings.tts_vieneu_mode,
        "tts_vieneu_backbone_device": settings.tts_vieneu_backbone_device,
        "tts_vieneu_codec_repo": settings.tts_vieneu_codec_repo,
        "tts_vieneu_codec_device": settings.tts_vieneu_codec_device,
        "tts_vieneu_remote_api_base": settings.tts_vieneu_remote_api_base,
        "tts_vieneu_voice_id": settings.tts_vieneu_voice_id,
        "tts_vieneu_ref_audio": settings.tts_vieneu_ref_audio,
        "tts_vieneu_has_ref_text": bool(settings.tts_vieneu_ref_text.strip()),
        "tts_vieneu_temperature": settings.tts_vieneu_temperature,
        "tts_vieneu_top_k": settings.tts_vieneu_top_k,
        "tts_vieneu_max_chars": settings.tts_vieneu_max_chars,
        "tts_vieneu_stream_frames_per_chunk": settings.tts_vieneu_stream_frames_per_chunk,
        "tts_vieneu_stream_lookforward": settings.tts_vieneu_stream_lookforward,
        "tts_vieneu_stream_lookback": settings.tts_vieneu_stream_lookback,
        "tts_vieneu_stream_overlap_frames": settings.tts_vieneu_stream_overlap_frames,
        "vieneu_stream_realtime_factor": vieneu_diag.get("stream_realtime_factor", 0),
        "vieneu_installed": speech_service._is_vieneu_available(),
        "active_sessions": await conversation_engine.active_session_count(),
    }


async def _bridge_keepalive_loop() -> None:
    provider_client = conversation_engine.provider_client
    if provider_client is None:
        return

    interval_seconds = max(15.0, float(settings.bridge_keepalive_interval_seconds))
    timeout_seconds = max(1.0, float(settings.bridge_keepalive_timeout_seconds))

    while True:
        try:
            await asyncio.sleep(interval_seconds)
            started_at = time.perf_counter()
            await provider_client.ping(timeout_seconds=timeout_seconds)
            logger.debug(
                "bridge_keepalive_ms=%s status=ok",
                int((time.perf_counter() - started_at) * 1000),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("bridge_keepalive status=error detail=%s", exc)


@app.get("/chat/stream")
async def chat_stream(session_id: str, text: str) -> StreamingResponse:
    provider_client = conversation_engine.provider_client
    clean_text = str(text or "").strip()

    async def generator():
        if not clean_text:
            yield "data: [DONE]\n\n"
            return

        if provider_client is None:
            fallback_reply = render_lite_bridge_required_reply(
                {
                    "scene": "fallback",
                    "seed": "",
                    "cart_summary": [],
                    "recommended_items": [],
                    "needs_confirmation": False,
                    "order_created": False,
                    "voice_style": settings.voice_style,
                    "user_text": clean_text,
                }
            )
            for sentence in split_sentences(fallback_reply):
                yield _safe_sse_data({"sentence": sentence})
            yield "data: [DONE]\n\n"
            return

        prompt_payload: dict[str, object] = {
            "scene": "fallback",
            "seed": "",
            "cart_summary": [],
            "recommended_items": [],
            "needs_confirmation": False,
            "order_created": False,
            "voice_style": settings.voice_style,
            "user_text": clean_text,
        }
        turn_id = f"chat-stream-{int(time.time() * 1000)}"

        try:
            async for sentence in provider_client.compose_reply_stream(
                prompt_payload,
                session_id=session_id,
                turn_id=turn_id,
                latest_wins=True,
            ):
                clean_sentence = str(sentence or "").strip()
                if not clean_sentence:
                    continue
                yield _safe_sse_data({"sentence": clean_sentence})
        except Exception as exc:
            yield _safe_sse_data({"error": str(exc)})
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


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
        fallback_text = render_lite_bridge_required_reply(prompt_payload)
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
    should_reset_vieneu = False

    if payload.voice is not None:
        settings.tts_voice = payload.voice
    if payload.rate is not None:
        settings.tts_rate = str(payload.rate)
    if payload.engine is not None:
        normalized_engine = payload.engine.strip().lower()
        if normalized_engine in SUPPORTED_TTS_ENGINES:
            settings.tts_engine = normalized_engine
    if payload.vieneu_model_path is not None:
        normalized_model_path = payload.vieneu_model_path.strip()
        if normalized_model_path != settings.tts_vieneu_model_path:
            should_reset_vieneu = True
        settings.tts_vieneu_model_path = normalized_model_path
    if payload.vieneu_mode is not None:
        normalized_mode = payload.vieneu_mode.strip().lower()
        if normalized_mode in {"turbo", "turbo_gpu", "standard", "fast", "gpu", "xpu", "remote", "api"}:
            if normalized_mode in {"gpu"}:
                normalized_mode = "fast"
            if normalized_mode != settings.tts_vieneu_mode:
                should_reset_vieneu = True
            settings.tts_vieneu_mode = normalized_mode
    if payload.vieneu_backbone_device is not None:
        normalized_backbone_device = payload.vieneu_backbone_device.strip().lower()
        if normalized_backbone_device and normalized_backbone_device != settings.tts_vieneu_backbone_device:
            should_reset_vieneu = True
        settings.tts_vieneu_backbone_device = normalized_backbone_device or settings.tts_vieneu_backbone_device
    if payload.vieneu_codec_repo is not None:
        normalized_codec_repo = payload.vieneu_codec_repo.strip()
        if normalized_codec_repo != settings.tts_vieneu_codec_repo:
            should_reset_vieneu = True
        settings.tts_vieneu_codec_repo = normalized_codec_repo
    if payload.vieneu_codec_device is not None:
        normalized_codec_device = payload.vieneu_codec_device.strip().lower()
        if normalized_codec_device and normalized_codec_device != settings.tts_vieneu_codec_device:
            should_reset_vieneu = True
        settings.tts_vieneu_codec_device = normalized_codec_device or settings.tts_vieneu_codec_device
    if payload.vieneu_remote_api_base is not None:
        normalized_remote_api_base = payload.vieneu_remote_api_base.strip()
        if normalized_remote_api_base and normalized_remote_api_base != settings.tts_vieneu_remote_api_base:
            should_reset_vieneu = True
        settings.tts_vieneu_remote_api_base = normalized_remote_api_base or settings.tts_vieneu_remote_api_base
    if payload.vieneu_voice_id is not None:
        settings.tts_vieneu_voice_id = payload.vieneu_voice_id.strip()
    if payload.vieneu_ref_audio is not None:
        settings.tts_vieneu_ref_audio = payload.vieneu_ref_audio.strip()
    if payload.vieneu_ref_text is not None:
        settings.tts_vieneu_ref_text = payload.vieneu_ref_text.strip()
    if payload.vieneu_temperature is not None:
        settings.tts_vieneu_temperature = payload.vieneu_temperature
    if payload.vieneu_top_k is not None:
        settings.tts_vieneu_top_k = payload.vieneu_top_k
    if payload.vieneu_max_chars is not None:
        settings.tts_vieneu_max_chars = payload.vieneu_max_chars
    if payload.vieneu_stream_frames_per_chunk is not None:
        settings.tts_vieneu_stream_frames_per_chunk = payload.vieneu_stream_frames_per_chunk
    if payload.vieneu_stream_lookforward is not None:
        settings.tts_vieneu_stream_lookforward = payload.vieneu_stream_lookforward
    if payload.vieneu_stream_lookback is not None:
        settings.tts_vieneu_stream_lookback = payload.vieneu_stream_lookback
    if payload.vieneu_stream_overlap_frames is not None:
        settings.tts_vieneu_stream_overlap_frames = payload.vieneu_stream_overlap_frames

    if should_reset_vieneu:
        speech_service.reset_vieneu_runtime()

    return {
        "status": "ok",
        "tts_engine": settings.tts_engine,
        "tts_voice": settings.tts_voice,
        "tts_rate": settings.tts_rate,
        "tts_vieneu_model_path": settings.tts_vieneu_model_path,
        "tts_vieneu_mode": settings.tts_vieneu_mode,
        "tts_vieneu_backbone_device": settings.tts_vieneu_backbone_device,
        "tts_vieneu_codec_repo": settings.tts_vieneu_codec_repo,
        "tts_vieneu_codec_device": settings.tts_vieneu_codec_device,
        "tts_vieneu_remote_api_base": settings.tts_vieneu_remote_api_base,
        "tts_vieneu_voice_id": settings.tts_vieneu_voice_id,
        "tts_vieneu_ref_audio": settings.tts_vieneu_ref_audio,
        "tts_vieneu_temperature": str(settings.tts_vieneu_temperature),
        "tts_vieneu_top_k": str(settings.tts_vieneu_top_k),
        "tts_vieneu_max_chars": str(settings.tts_vieneu_max_chars),
        "tts_vieneu_stream_frames_per_chunk": str(settings.tts_vieneu_stream_frames_per_chunk),
        "tts_vieneu_stream_lookforward": str(settings.tts_vieneu_stream_lookforward),
        "tts_vieneu_stream_lookback": str(settings.tts_vieneu_stream_lookback),
        "tts_vieneu_stream_overlap_frames": str(settings.tts_vieneu_stream_overlap_frames),
    }


@app.post("/config/env/sync", response_model=EnvSyncResponse)
async def sync_env_config(payload: EnvSyncRequest) -> EnvSyncResponse:
    """Persist admin-configured environment values to the root .env file."""
    normalized_updates: dict[str, str] = {}
    for raw_key, raw_value in payload.fields.items():
        key = str(raw_key or "").strip()
        if not key or not ENV_KEY_PATTERN.match(key):
            continue
        normalized_updates[key] = str(raw_value or "").strip()

    if not normalized_updates:
        raise HTTPException(status_code=400, detail="No valid ENV keys provided.")

    env_path = ENV_CONFIG_PATH
    try:
        await asyncio.to_thread(_write_env_updates, env_path, normalized_updates)
    except Exception as exc:
        logger.exception("config_env_sync status=error err=%s", exc)
        raise HTTPException(status_code=500, detail=f"Cannot update .env: {exc}") from exc

    logger.info(
        "config_env_sync status=ok updated_keys=%s env_path=%s",
        len(normalized_updates),
        env_path,
    )
    return EnvSyncResponse(
        status="ok",
        env_path=str(env_path),
        updated_keys=len(normalized_updates),
    )


@app.post("/config/env/load", response_model=EnvLoadResponse)
async def load_env_config(payload: EnvLoadRequest) -> EnvLoadResponse:
    """Load selected environment keys from root .env for Admin hydration."""
    requested_keys: set[str] = set()
    for raw_key in payload.keys:
        key = str(raw_key or "").strip()
        if key and ENV_KEY_PATTERN.match(key):
            requested_keys.add(key)

    env_path = ENV_CONFIG_PATH
    try:
        loaded = await asyncio.to_thread(_read_env_values, env_path, requested_keys)
    except Exception as exc:
        logger.exception("config_env_load status=error err=%s", exc)
        raise HTTPException(status_code=500, detail=f"Cannot read .env: {exc}") from exc

    logger.info(
        "config_env_load status=ok loaded_keys=%s env_path=%s",
        len(loaded),
        env_path,
    )
    return EnvLoadResponse(
        status="ok",
        env_path=str(env_path),
        fields=loaded,
        loaded_keys=len(loaded),
    )


@app.post("/config/admin-state/load", response_model=SharedAdminStateResponse)
async def load_shared_admin_state() -> SharedAdminStateResponse:
    state_path = SHARED_ADMIN_STATE_PATH
    fields = await asyncio.to_thread(_read_shared_admin_state, state_path)
    return SharedAdminStateResponse(
        status="ok",
        state_path=str(state_path),
        fields=fields,
    )


@app.post("/config/admin-state/sync", response_model=SharedAdminStateResponse)
async def sync_shared_admin_state(payload: SharedAdminStateSyncRequest) -> SharedAdminStateResponse:
    updates: dict[str, object] = {}
    if payload.robot_scale_percent is not None:
        updates["robot_scale_percent"] = max(60, min(170, int(payload.robot_scale_percent)))
    if payload.camera_preview_visible is not None:
        updates["camera_preview_visible"] = bool(payload.camera_preview_visible)
    if payload.mic_noise_filter_strength is not None:
        updates["mic_noise_filter_strength"] = max(0, min(100, int(payload.mic_noise_filter_strength)))
    if payload.robot_studio_config is not None:
        updates["robot_studio_config"] = payload.robot_studio_config

    if not updates:
        raise HTTPException(status_code=400, detail="No shared admin fields provided.")

    state_path = SHARED_ADMIN_STATE_PATH
    fields = await asyncio.to_thread(_write_shared_admin_state, state_path, updates)
    return SharedAdminStateResponse(
        status="ok",
        state_path=str(state_path),
        fields=fields,
    )


@app.get("/speech/vieneu/voices")
async def list_vieneu_voices() -> dict[str, object]:
    vieneu_installed = speech_service._is_vieneu_available()
    voices = await speech_service.list_vieneu_voices()
    return {
        "status": "ok",
        "tts_engine": settings.tts_engine,
        "vieneu_installed": vieneu_installed,
        "voices": voices,
    }


@app.get("/speech/vieneu/diag")
async def vieneu_diag() -> dict[str, object]:
    diagnostics = speech_service.get_vieneu_diagnostics()
    return {
        "status": "ok",
        "diag": diagnostics,
    }


@app.post("/speech/vieneu/prewarm")
async def prewarm_vieneu() -> dict[str, object]:
    started_at = time.perf_counter()
    if not speech_service._is_vieneu_available():
        logger.warning("vieneu_prewarm status=skip reason=not_installed")
        raise HTTPException(status_code=400, detail="VieNeu package is not installed.")
    try:
        logger.info("vieneu_prewarm status=start")
        await speech_service.prewarm_vieneu_now()
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info("vieneu_prewarm status=ok elapsed_ms=%s", elapsed_ms)
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.exception("vieneu_prewarm status=error elapsed_ms=%s err=%s", elapsed_ms, exc)
        raise HTTPException(status_code=500, detail=f"Khong the prewarm VieNeu: {exc}") from exc
    return {
        "status": "ok",
        "detail": "VieNeu model prewarmed.",
        "diag": speech_service.get_vieneu_diagnostics(),
    }


def _run_vieneu_install() -> subprocess.CompletedProcess[str]:
    llama_cpu_index = "https://pnnbao97.github.io/llama-cpp-python-v0.3.16/cpu/"
    install_steps: list[list[str]] = [
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--upgrade",
            "vieneu>=2.1.3",
            "sea-g2p>=0.7.5",
            "--extra-index-url",
            llama_cpu_index,
        ],
        [sys.executable, "-m", "pip", "install", "onnxruntime>=1.23.2"],
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "torch",
            "--index-url",
            "https://download.pytorch.org/whl/cpu",
        ],
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "llama-cpp-python==0.3.16",
            "--extra-index-url",
            llama_cpu_index,
        ],
    ]
    outputs: list[str] = []
    for command in install_steps:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=VIENEU_INSTALL_TIMEOUT_SECONDS,
            check=False,
        )
        outputs.append(
            "\n".join(
                [
                    f"$ {' '.join(command)}",
                    completed.stdout or "",
                    completed.stderr or "",
                ]
            ).strip()
        )
        if completed.returncode != 0:
            completed.stdout = "\n\n".join(outputs)
            return completed
    return subprocess.CompletedProcess(
        args=install_steps[-1],
        returncode=0,
        stdout="\n\n".join(outputs),
        stderr="",
    )


def _collect_cpu_runtime_versions() -> dict[str, str]:
    package_map = {
        "onnxruntime": "onnxruntime",
        "torch": "torch",
        "llama-cpp-python": "llama-cpp-python",
        "vieneu": "vieneu",
    }
    versions: dict[str, str] = {}
    for display_name, package_name in package_map.items():
        try:
            versions[display_name] = importlib_metadata.version(package_name)
        except importlib_metadata.PackageNotFoundError:
            versions[display_name] = "not-installed"
        except Exception:
            versions[display_name] = "unknown"
    return versions


@app.post("/speech/vieneu/install")
async def install_vieneu() -> dict[str, object]:
    already_installed = speech_service._is_vieneu_available()
    logger.info("Installing VieNeu CPU runtime stack via pip using python=%s", sys.executable)
    try:
        install_result = await asyncio.to_thread(_run_vieneu_install)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=504,
            detail=f"Cai vieneu bi timeout sau {VIENEU_INSTALL_TIMEOUT_SECONDS} giay.",
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Khong the chay pip install vieneu: {exc}") from exc

    stdout_tail = (install_result.stdout or "")[-4000:]
    stderr_tail = (install_result.stderr or "")[-4000:]

    if install_result.returncode != 0:
        detail = stderr_tail.strip() or stdout_tail.strip() or "Pip install failed without output."
        raise HTTPException(
            status_code=500,
            detail=f"Cai vieneu that bai (code={install_result.returncode}): {detail}",
        )

    cpu_versions = _collect_cpu_runtime_versions()

    if cpu_versions.get("vieneu") in {None, "not-installed", "unknown"} or not speech_service._is_vieneu_available():
        raise HTTPException(
            status_code=500,
            detail="Da cai vieneu xong nhung backend chua nhan module. Thu restart AI backend.",
        )

    speech_service.reset_vieneu_runtime()
    missing_cpu = [name for name, version in cpu_versions.items() if version == "not-installed"]
    detail = "Cai vieneu CPU stack thanh cong."
    if missing_cpu:
        detail = f"Cai xong nhung con thieu package: {', '.join(missing_cpu)}."
    return {
        "ok": True,
        "already_installed": already_installed,
        "vieneu_installed": True,
        "detail": detail,
        "cpu_processing": cpu_versions,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
    }


@app.post("/sessions/start", response_model=ConversationResponse)
async def start_session(payload: SessionStartRequest) -> ConversationResponse:
    try:
        return await conversation_engine.start_session(store_id=payload.store_id, table_id=payload.table_id)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Core backend khong san sang.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/sessions/{session_id}/turn", response_model=ConversationResponse)
async def handle_turn(session_id: str, payload: TurnRequest) -> ConversationResponse:
    started_at = time.perf_counter()
    try:
        response = await conversation_engine.handle_turn(
            session_id,
            payload.transcript,
            turn_id=payload.turn_id,
            quick_checkout=payload.quick_checkout,
            store_id=payload.store_id,
            table_id=payload.table_id,
        )
        logger.info(
            "turn_total_ms=%s session_id=%s turn_id=%s endpoint=turn quick_checkout=%s",
            int((time.perf_counter() - started_at) * 1000),
            session_id,
            payload.turn_id or "",
            payload.quick_checkout,
        )
        return response
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or "Khong the tao don tu core backend."
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Khong the ket noi toi core backend.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/sessions/{session_id}/turn/stream")
async def handle_turn_stream(session_id: str, payload: TurnRequest) -> StreamingResponse:
    """Stream conversation response with incremental text and optional audio chunks."""
    async def response_stream():
        started_at = time.perf_counter()
        first_text_at = 0.0
        first_audio_at = 0.0
        try:
            async for chunk in conversation_engine.handle_turn_stream(
                session_id,
                payload.transcript,
                turn_id=payload.turn_id,
                include_audio=payload.include_audio,
                quick_checkout=payload.quick_checkout,
                store_id=payload.store_id,
                table_id=payload.table_id,
            ):
                chunk_type = str(chunk.get("type") or "").lower() if isinstance(chunk, dict) else ""
                if chunk_type in {"text", "text_final"} and not first_text_at:
                    first_text_at = time.perf_counter()
                    logger.info(
                        "turn_first_text_ms=%s session_id=%s turn_id=%s endpoint=turn_stream quick_checkout=%s",
                        int((first_text_at - started_at) * 1000),
                        session_id,
                        payload.turn_id or "",
                        payload.quick_checkout,
                    )
                elif chunk_type == "audio" and not first_audio_at:
                    first_audio_at = time.perf_counter()
                    logger.info(
                        "turn_first_audio_ms=%s session_id=%s turn_id=%s endpoint=turn_stream quick_checkout=%s",
                        int((first_audio_at - started_at) * 1000),
                        session_id,
                        payload.turn_id or "",
                        payload.quick_checkout,
                    )
                yield _safe_ndjson_line(chunk)
            logger.info(
                "turn_total_ms=%s turn_first_text_ms=%s turn_first_audio_ms=%s session_id=%s turn_id=%s endpoint=turn_stream quick_checkout=%s",
                int((time.perf_counter() - started_at) * 1000),
                int((first_text_at - started_at) * 1000) if first_text_at else -1,
                int((first_audio_at - started_at) * 1000) if first_audio_at else -1,
                session_id,
                payload.turn_id or "",
                payload.quick_checkout,
            )
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text or "Khong the tao don tu core backend."
            yield _safe_ndjson_line(
                {"type": "error", "code": "core_http_error", "message": detail, "turn_id": payload.turn_id},
            )
        except httpx.HTTPError:
            yield _safe_ndjson_line(
                {
                    "type": "error",
                    "code": "core_connect_error",
                    "message": "Khong the ket noi toi core backend.",
                    "turn_id": payload.turn_id,
                },
            )
        except ProviderError as exc:
            yield _safe_ndjson_line(
                {"type": "error", "code": "bridge_provider_error", "message": str(exc), "turn_id": payload.turn_id},
            )
        except Exception as exc:
            logger.exception("turn stream unexpected error session_id=%s turn_id=%s", session_id, payload.turn_id)
            yield _safe_ndjson_line(
                {"type": "error", "code": "turn_stream_unexpected_error", "message": str(exc), "turn_id": payload.turn_id},
            )

    return StreamingResponse(response_stream(), media_type="application/x-ndjson")


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


@app.get("/feedback/audit")
async def audit_feedback_log() -> dict[str, object]:
    return await conversation_engine.audit_feedback_log()


@app.post("/feedback/repair")
async def repair_feedback_log() -> dict[str, object]:
    return await conversation_engine.repair_feedback_log()


@app.post("/feedback/triage-new")
async def triage_new_feedback() -> dict[str, object]:
    return await conversation_engine.triage_feedback_log(only_new=True)


@app.post("/speech/synthesize")
async def synthesize_speech(payload: SpeechSynthesisRequest) -> Response:
    started_at = time.perf_counter()
    vieneu_overrides = build_vieneu_overrides(payload)
    try:
        audio = await speech_service.synthesize(
            payload.text,
            payload.voice,
            payload.rate,
            vieneu_overrides=vieneu_overrides,
        )
        logger.info(
            "tts_total_ms=%s endpoint=synthesize chars=%s engine=%s",
            int((time.perf_counter() - started_at) * 1000),
            len((payload.text or "").strip()),
            str((vieneu_overrides or {}).get("engine") or settings.tts_engine),
        )
    except Exception as exc:
        logger.exception(
            "tts_total_ms=%s endpoint=synthesize status=error chars=%s engine=%s",
            int((time.perf_counter() - started_at) * 1000),
            len((payload.text or "").strip()),
            str((vieneu_overrides or {}).get("engine") or settings.tts_engine),
        )
        raise HTTPException(status_code=502, detail=f"Khong the tao giong noi: {exc}") from exc

    return Response(content=audio.content, media_type=audio.media_type)


@app.post("/speech/synthesize/stream")
async def synthesize_speech_stream(payload: SpeechSynthesisRequest) -> StreamingResponse:
    started_at = time.perf_counter()
    vieneu_overrides = build_vieneu_overrides(payload)
    requested_engine = str((vieneu_overrides or {}).get("engine") or "").strip().lower()
    if not requested_engine:
        requested_engine = str(settings.tts_engine or "").strip().lower()
    stream_media_type = "audio/wav" if requested_engine == "vieneu" else "audio/mpeg"
    try:
        async def audio_stream():
            stream_bytes = 0
            stream_chunks = 0
            async for chunk in speech_service.synthesize_stream(
                payload.text,
                payload.voice,
                payload.rate,
                vieneu_overrides=vieneu_overrides,
            ):
                stream_chunks += 1
                stream_bytes += len(chunk)
                yield chunk
            logger.info(
                "tts_total_ms=%s endpoint=synthesize_stream chars=%s engine=%s chunks=%s bytes=%s",
                int((time.perf_counter() - started_at) * 1000),
                len((payload.text or "").strip()),
                str((vieneu_overrides or {}).get("engine") or settings.tts_engine),
                stream_chunks,
                stream_bytes,
            )

        return StreamingResponse(audio_stream(), media_type=stream_media_type)
    except Exception as exc:
        logger.exception(
            "tts_total_ms=%s endpoint=synthesize_stream status=error chars=%s engine=%s",
            int((time.perf_counter() - started_at) * 1000),
            len((payload.text or "").strip()),
            str((vieneu_overrides or {}).get("engine") or settings.tts_engine),
        )
        raise HTTPException(status_code=502, detail=f"Khong the tao giong noi: {exc}") from exc


@app.websocket("/speech/synthesize/ws")
async def synthesize_speech_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    websocket_open = True

    async def send_ws_json(payload: dict[str, object]) -> bool:
        nonlocal websocket_open
        if not websocket_open:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except WebSocketDisconnect:
            websocket_open = False
            return False
        except RuntimeError as exc:
            if "close message has been sent" in str(exc).lower():
                websocket_open = False
                return False
            raise

    try:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            return

        raw_text = message.get("text")
        if raw_text is None and message.get("bytes") is not None:
            raw_text = bytes(message["bytes"]).decode("utf-8", errors="ignore")
        if not raw_text:
            await send_ws_json({"type": "error", "code": "invalid_payload", "message": "Missing JSON payload."})
            return

        payload_dict = json.loads(raw_text)
        payload = SpeechSynthesisRequest.model_validate(payload_dict)
        turn_id = str(payload_dict.get("turn_id") or "").strip() or None
        session_id = str(payload_dict.get("session_id") or "").strip() or None

        overrides = build_vieneu_overrides(payload) or {}
        # Realtime WS playback currently targets VieNeu PCM output.
        overrides["engine"] = "vieneu"

        sample_rate = 24000
        started_at = time.perf_counter()
        chunk_count = 0
        bytes_sent = 0
        first_chunk_at = 0.0

        if not await send_ws_json(
            {
                "type": "meta",
                "format": "pcm_s16le",
                "channels": 1,
                "sample_rate": sample_rate,
                "turn_id": turn_id,
                "session_id": session_id,
                "engine": "vieneu",
            },
        ):
            return

        async for chunk in speech_service.synthesize_stream(
            payload.text,
            payload.voice,
            payload.rate,
            vieneu_overrides=overrides,
        ):
            pcm_chunk, detected_sample_rate = decode_pcm16_chunk(chunk)
            if detected_sample_rate and detected_sample_rate != sample_rate:
                sample_rate = detected_sample_rate
                if not await send_ws_json(
                    {
                        "type": "meta",
                        "format": "pcm_s16le",
                        "channels": 1,
                        "sample_rate": sample_rate,
                        "turn_id": turn_id,
                        "session_id": session_id,
                        "engine": "vieneu",
                    },
                ):
                    return
            if not pcm_chunk:
                continue

            if not first_chunk_at:
                first_chunk_at = time.perf_counter()
                logger.info(
                    "tts_ws_first_chunk_ms=%s session_id=%s turn_id=%s",
                    int((first_chunk_at - started_at) * 1000),
                    session_id or "",
                    turn_id or "",
                )

            try:
                await websocket.send_bytes(pcm_chunk)
            except WebSocketDisconnect:
                websocket_open = False
                return
            except RuntimeError as exc:
                if "close message has been sent" in str(exc).lower():
                    websocket_open = False
                    return
                raise

            chunk_count += 1
            bytes_sent += len(pcm_chunk)

        await send_ws_json(
            {
                "type": "done",
                "turn_id": turn_id,
                "session_id": session_id,
                "chunks": chunk_count,
                "bytes": bytes_sent,
                "total_ms": int((time.perf_counter() - started_at) * 1000),
            },
        )
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.exception("tts_ws_failed")
        await send_ws_json(
            {
                "type": "error",
                "code": "tts_ws_failed",
                "message": str(exc),
            },
        )


@app.post("/speech/transcribe", response_model=SpeechTranscriptionResponse)
async def transcribe_speech(file: UploadFile = File(...)) -> SpeechTranscriptionResponse:
    started_at = time.perf_counter()
    try:
        transcript = await speech_service.transcribe(file)
        logger.info("stt_ms=%s endpoint=transcribe", int((time.perf_counter() - started_at) * 1000))
        return SpeechTranscriptionResponse(transcript=transcript, status="ok")
    except SpeechNotHeardError as exc:
        logger.info("stt_ms=%s endpoint=transcribe status=retry", int((time.perf_counter() - started_at) * 1000))
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
    websocket_open = True

    async def send_ws_json(payload: dict[str, object]) -> bool:
        nonlocal websocket_open
        if not websocket_open:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except WebSocketDisconnect:
            websocket_open = False
            return False
        except RuntimeError as exc:
            # Starlette raises RuntimeError when attempting to send after close.
            if "close message has been sent" in str(exc).lower():
                websocket_open = False
                return False
            raise

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
            if not await send_ws_json({"type": "partial", "transcript": transcript}):
                return
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
                        if not await send_ws_json(
                            {
                                "type": "final",
                                "status": "retry",
                                "transcript": "",
                                "message": "Minh nghe chua ro, ban noi lai giup minh nhe.",
                            },
                        ):
                            return
                        continue

                    await flush_partial(force=True)
                    if stream_mode == "order" and last_partial and speech_service.is_actionable_transcript(last_partial):
                        if not await send_ws_json(
                            {"type": "final", "status": "ok", "transcript": last_partial},
                        ):
                            return
                        audio_buffer.clear()
                        continue

                    final_started_at = time.perf_counter()
                    final_transcript = await speech_service.transcribe_bytes(
                        snapshot,
                        filename,
                        mode=stream_mode,
                    )
                    logger.info(
                        "stt_ms=%s endpoint=transcribe_ws mode=%s",
                        int((time.perf_counter() - final_started_at) * 1000),
                        stream_mode,
                    )
                    if not await send_ws_json(
                        {"type": "final", "status": "ok", "transcript": final_transcript},
                    ):
                        return
                except SpeechNotHeardError as exc:
                    if not await send_ws_json(
                        {"type": "final", "status": "retry", "transcript": "", "message": str(exc)},
                    ):
                        return
                except Exception as exc:
                    if not await send_ws_json(
                        {"type": "final", "status": "error", "message": str(exc), "transcript": ""},
                    ):
                        return
                finally:
                    audio_buffer.clear()
                continue
    except WebSocketDisconnect:
        return


def build_vieneu_overrides(payload: SpeechSynthesisRequest) -> dict[str, object] | None:
    overrides: dict[str, object] = {}

    if payload.engine is not None:
        overrides["engine"] = payload.engine
    if payload.vieneu_voice_id is not None:
        overrides["vieneu_voice_id"] = payload.vieneu_voice_id
    if payload.vieneu_ref_audio is not None:
        overrides["vieneu_ref_audio"] = payload.vieneu_ref_audio
    if payload.vieneu_ref_text is not None:
        overrides["vieneu_ref_text"] = payload.vieneu_ref_text
    if payload.vieneu_temperature is not None:
        overrides["vieneu_temperature"] = payload.vieneu_temperature
    if payload.vieneu_top_k is not None:
        overrides["vieneu_top_k"] = payload.vieneu_top_k
    if payload.vieneu_max_chars is not None:
        overrides["vieneu_max_chars"] = payload.vieneu_max_chars

    return overrides or None


def decode_pcm16_chunk(chunk: bytes) -> tuple[bytes, int | None]:
    payload = bytes(chunk or b"")
    if not payload:
        return b"", None

    is_wav = (
        len(payload) >= 12
        and payload[0:4] == b"RIFF"
        and payload[8:12] == b"WAVE"
    )
    if not is_wav:
        if len(payload) % 2 == 1:
            payload = payload[:-1]
        return payload, None

    try:
        with wave.open(io.BytesIO(payload), "rb") as wav_reader:
            frames = wav_reader.readframes(wav_reader.getnframes())
            if len(frames) % 2 == 1:
                frames = frames[:-1]
            sample_rate = int(wav_reader.getframerate() or 0) or None
            return frames, sample_rate
    except Exception:
        # Fallback for chunks that contain repeated WAV headers plus PCM payload.
        if len(payload) > 44:
            fallback = payload[44:]
            if len(fallback) % 2 == 1:
                fallback = fallback[:-1]
            return fallback, None
        return b"", None
