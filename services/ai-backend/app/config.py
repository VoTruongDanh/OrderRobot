from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[3]
load_dotenv(ROOT_DIR / ".env")


@dataclass(slots=True)
class Settings:
    # Legacy provider settings retained for backward compatibility with existing tests/envs.
    ai_base_url: str
    ai_api_key: str
    ai_model: str

    core_backend_url: str

    # Bridge-only runtime settings.
    bridge_base_url: str = "http://127.0.0.1:1122"
    bridge_timeout_seconds: float = 25.0
    bridge_stream_timeout_seconds: float = 120.0
    llm_mode: str = "disabled"  # disabled | bridge_only

    voice_lang: str = "vi-VN"
    voice_style: str = "cute_friendly"
    tts_engine: str = "auto"  # auto | vieneu | edge | local
    tts_vieneu_model_path: str = ""
    tts_voice: str = "vietnam"
    tts_rate: str = "165"
    stt_model: str = "medium"
    stt_device: str = "auto"
    stt_compute_type: str = "auto"
    stt_beam_size: int = 8
    stt_best_of: int = 5
    stt_partial_beam_size: int = 2
    stt_partial_best_of: int = 1
    stt_vad_min_silence_ms: int = 450
    stt_preload: bool = True
    stt_cpu_threads: int = 8
    stt_num_workers: int = 1
    request_timeout_seconds: float = 25.0
    llm_timeout_seconds: float = 120.0
    session_timeout_minutes: int = 15

    @property
    def provider_enabled(self) -> bool:
        # Backward-compatible alias consumed by existing code paths.
        return self.bridge_enabled

    @property
    def bridge_enabled(self) -> bool:
        return self.llm_mode == "bridge_only" and bool(self.bridge_base_url)


def get_settings() -> Settings:
    default_cpu_threads = max(1, min(os.cpu_count() or 4, 8))
    llm_mode = os.getenv("LLM_MODE", "bridge_only").strip().lower() or "bridge_only"
    raw_bridge_base_url = os.getenv("BRIDGE_BASE_URL", "").strip()
    bridge_base_url = raw_bridge_base_url or "http://127.0.0.1:1122"
    if llm_mode == "bridge_only":
        normalized_legacy_urls = {
            "http://127.0.0.1:1111",
            "http://localhost:1111",
            "https://127.0.0.1:1111",
            "https://localhost:1111",
        }
        if bridge_base_url.rstrip("/") in normalized_legacy_urls:
            bridge_base_url = "http://127.0.0.1:1122"

    return Settings(
        ai_base_url=os.getenv("AI_BASE_URL", "").strip(),
        ai_api_key=os.getenv("AI_API_KEY", "").strip(),
        ai_model=os.getenv("AI_MODEL", "").strip(),
        core_backend_url=os.getenv("CORE_BACKEND_URL", "http://127.0.0.1:8001").strip(),
        bridge_base_url=bridge_base_url,
        bridge_timeout_seconds=float(os.getenv("BRIDGE_TIMEOUT_SECONDS", "25.0")),
        bridge_stream_timeout_seconds=float(os.getenv("BRIDGE_STREAM_TIMEOUT_SECONDS", "120.0")),
        llm_mode=llm_mode,
        voice_lang=os.getenv("VOICE_LANG", "vi-VN").strip(),
        voice_style=os.getenv("VOICE_STYLE", "cute_friendly").strip(),
        tts_engine=os.getenv("TTS_ENGINE", "auto").strip().lower() or "auto",
        tts_vieneu_model_path=os.getenv("TTS_VIENEU_MODEL_PATH", "").strip(),
        tts_voice=os.getenv("TTS_VOICE", "vietnam").strip(),
        tts_rate=os.getenv("TTS_RATE", "165").strip(),
        stt_model=os.getenv("STT_MODEL", "medium").strip(),
        stt_device=os.getenv("STT_DEVICE", "auto").strip(),
        stt_compute_type=os.getenv("STT_COMPUTE_TYPE", "auto").strip(),
        stt_beam_size=int(os.getenv("STT_BEAM_SIZE", "8")),
        stt_best_of=int(os.getenv("STT_BEST_OF", "5")),
        stt_partial_beam_size=max(1, int(os.getenv("STT_PARTIAL_BEAM_SIZE", "2"))),
        stt_partial_best_of=max(1, int(os.getenv("STT_PARTIAL_BEST_OF", "1"))),
        stt_vad_min_silence_ms=int(os.getenv("STT_VAD_MIN_SILENCE_MS", "450")),
        stt_preload=os.getenv("STT_PRELOAD", "true").strip().lower() not in {"0", "false", "no"},
        stt_cpu_threads=max(1, int(os.getenv("STT_CPU_THREADS", str(default_cpu_threads)))),
        stt_num_workers=max(1, int(os.getenv("STT_NUM_WORKERS", "1"))),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "25.0")),
        llm_timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", "120.0")),
        session_timeout_minutes=int(os.getenv("SESSION_TIMEOUT_MINUTES", "15")),
    )
