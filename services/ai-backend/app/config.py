from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[3]
load_dotenv(ROOT_DIR / ".env")


@dataclass(slots=True)
class Settings:
    ai_base_url: str
    ai_api_key: str
    ai_model: str
    core_backend_url: str
    voice_lang: str
    voice_style: str
    tts_voice: str
    tts_rate: str
    stt_model: str
    stt_device: str
    stt_compute_type: str
    stt_beam_size: int = 8
    stt_best_of: int = 5
    stt_vad_min_silence_ms: int = 450
    stt_preload: bool = True
    stt_cpu_threads: int = 8
    stt_num_workers: int = 1
    request_timeout_seconds: float = 25.0
    llm_timeout_seconds: float = 120.0  # Tăng timeout cho LLM
    session_timeout_minutes: int = 15

    @property
    def provider_enabled(self) -> bool:
        return bool(self.ai_base_url and self.ai_api_key and self.ai_model)


def get_settings() -> Settings:
    default_cpu_threads = max(1, min(os.cpu_count() or 4, 8))
    return Settings(
        ai_base_url=os.getenv("AI_BASE_URL", "").strip(),
        ai_api_key=os.getenv("AI_API_KEY", "").strip(),
        ai_model=os.getenv("AI_MODEL", "").strip(),
        core_backend_url=os.getenv("CORE_BACKEND_URL", "http://127.0.0.1:8001").strip(),
        voice_lang=os.getenv("VOICE_LANG", "vi-VN").strip(),
        voice_style=os.getenv("VOICE_STYLE", "cute_friendly").strip(),
        tts_voice=os.getenv("TTS_VOICE", "vietnam").strip(),
        tts_rate=os.getenv("TTS_RATE", "165").strip(),
        stt_model=os.getenv("STT_MODEL", "medium").strip(),
        stt_device=os.getenv("STT_DEVICE", "cpu").strip(),
        stt_compute_type=os.getenv("STT_COMPUTE_TYPE", "int8").strip(),
        stt_beam_size=int(os.getenv("STT_BEAM_SIZE", "8")),
        stt_best_of=int(os.getenv("STT_BEST_OF", "5")),
        stt_vad_min_silence_ms=int(os.getenv("STT_VAD_MIN_SILENCE_MS", "450")),
        stt_preload=os.getenv("STT_PRELOAD", "true").strip().lower() not in {"0", "false", "no"},
        stt_cpu_threads=max(1, int(os.getenv("STT_CPU_THREADS", str(default_cpu_threads)))),
        stt_num_workers=max(1, int(os.getenv("STT_NUM_WORKERS", "1"))),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "25.0")),
        llm_timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", "120.0")),
        session_timeout_minutes=int(os.getenv("SESSION_TIMEOUT_MINUTES", "15")),
    )
