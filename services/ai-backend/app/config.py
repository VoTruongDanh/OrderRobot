from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _resolve_root_dir() -> Path:
    override = os.getenv("ORDERROBOT_ROOT_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3]


def _resolve_env_config_path(root_dir: Path) -> Path:
    override = os.getenv("ORDERROBOT_ENV_FILE", "").strip()
    if not override:
        return root_dir / ".env"
    candidate = Path(override).expanduser()
    if not candidate.is_absolute():
        candidate = root_dir / candidate
    return candidate.resolve()


ROOT_DIR = _resolve_root_dir()
ENV_CONFIG_PATH = _resolve_env_config_path(ROOT_DIR)
load_dotenv(ENV_CONFIG_PATH)
DEFAULT_VIENEU_CPU_MODEL = "pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF"
DEFAULT_VIENEU_CPU_CODEC_REPO = ""


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
    bridge_keepalive_enabled: bool = True
    bridge_keepalive_interval_seconds: float = 90.0
    bridge_keepalive_timeout_seconds: float = 5.0
    llm_mode: str = "disabled"  # disabled | bridge_only

    voice_lang: str = "vi-VN"
    voice_style: str = "cute_friendly"
    tts_engine: str = "auto"  # auto | vieneu | edge | local
    tts_vieneu_model_path: str = DEFAULT_VIENEU_CPU_MODEL
    tts_vieneu_mode: str = "turbo"  # turbo | turbo_gpu | standard | fast | xpu | remote
    tts_vieneu_backbone_device: str = "cpu"
    tts_vieneu_codec_repo: str = DEFAULT_VIENEU_CPU_CODEC_REPO
    tts_vieneu_codec_device: str = "cpu"
    tts_vieneu_remote_api_base: str = "http://localhost:23333/v1"
    tts_vieneu_voice_id: str = ""
    tts_vieneu_ref_audio: str = ""
    tts_vieneu_ref_text: str = ""
    tts_vieneu_temperature: float = 1.0
    tts_vieneu_top_k: int = 50
    tts_vieneu_max_chars: int = 256
    tts_vieneu_stream_frames_per_chunk: int = 25
    tts_vieneu_stream_lookforward: int = 10
    tts_vieneu_stream_lookback: int = 100
    tts_vieneu_stream_overlap_frames: int = 1
    tts_preload: bool = True
    tts_voice: str = "vietnam"
    tts_rate: str = "185"
    stt_model: str = "small"
    stt_device: str = "auto"
    stt_compute_type: str = "auto"
    stt_beam_size: int = 5
    stt_best_of: int = 3
    stt_partial_beam_size: int = 1
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
    load_dotenv(ENV_CONFIG_PATH, override=True)

    default_cpu_threads = max(1, min(os.cpu_count() or 4, 8))
    llm_mode = os.getenv("LLM_MODE", "disabled").strip().lower() or "disabled"
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
        core_backend_url=os.getenv("CORE_BACKEND_URL", "http://127.0.0.1:8011").strip(),
        bridge_base_url=bridge_base_url,
        bridge_timeout_seconds=float(os.getenv("BRIDGE_TIMEOUT_SECONDS", "25.0")),
        bridge_stream_timeout_seconds=float(os.getenv("BRIDGE_STREAM_TIMEOUT_SECONDS", "120.0")),
        bridge_keepalive_enabled=os.getenv("BRIDGE_KEEPALIVE_ENABLED", "true").strip().lower() not in {"0", "false", "no"},
        bridge_keepalive_interval_seconds=max(15.0, float(os.getenv("BRIDGE_KEEPALIVE_INTERVAL_SECONDS", "90.0"))),
        bridge_keepalive_timeout_seconds=max(1.0, float(os.getenv("BRIDGE_KEEPALIVE_TIMEOUT_SECONDS", "5.0"))),
        llm_mode=llm_mode,
        voice_lang=os.getenv("VOICE_LANG", "vi-VN").strip(),
        voice_style=os.getenv("VOICE_STYLE", "cute_friendly").strip(),
        tts_engine=os.getenv("TTS_ENGINE", "auto").strip().lower() or "auto",
        tts_vieneu_model_path=(
            os.getenv("TTS_VIENEU_MODEL_PATH", DEFAULT_VIENEU_CPU_MODEL).strip()
            or DEFAULT_VIENEU_CPU_MODEL
        ),
        tts_vieneu_mode=os.getenv("TTS_VIENEU_MODE", "turbo").strip().lower() or "turbo",
        tts_vieneu_backbone_device=os.getenv("TTS_VIENEU_BACKBONE_DEVICE", "cpu").strip().lower() or "cpu",
        tts_vieneu_codec_repo=(
            os.getenv("TTS_VIENEU_CODEC_REPO", DEFAULT_VIENEU_CPU_CODEC_REPO).strip()
            or DEFAULT_VIENEU_CPU_CODEC_REPO
        ),
        tts_vieneu_codec_device=os.getenv("TTS_VIENEU_CODEC_DEVICE", "cpu").strip().lower() or "cpu",
        tts_vieneu_remote_api_base=os.getenv("TTS_VIENEU_REMOTE_API_BASE", "http://localhost:23333/v1").strip(),
        tts_vieneu_voice_id=os.getenv("TTS_VIENEU_VOICE_ID", "").strip(),
        tts_vieneu_ref_audio=os.getenv("TTS_VIENEU_REF_AUDIO", "").strip(),
        tts_vieneu_ref_text=os.getenv("TTS_VIENEU_REF_TEXT", "").strip(),
        tts_vieneu_temperature=max(0.1, min(2.0, float(os.getenv("TTS_VIENEU_TEMPERATURE", "1.0")))),
        tts_vieneu_top_k=max(1, min(200, int(os.getenv("TTS_VIENEU_TOP_K", "50")))),
        tts_vieneu_max_chars=max(32, min(512, int(os.getenv("TTS_VIENEU_MAX_CHARS", "256")))),
        tts_vieneu_stream_frames_per_chunk=max(8, min(64, int(os.getenv("TTS_VIENEU_STREAM_FRAMES_PER_CHUNK", "25")))),
        tts_vieneu_stream_lookforward=max(0, min(32, int(os.getenv("TTS_VIENEU_STREAM_LOOKFORWARD", "10")))),
        tts_vieneu_stream_lookback=max(8, min(256, int(os.getenv("TTS_VIENEU_STREAM_LOOKBACK", "100")))),
        tts_vieneu_stream_overlap_frames=max(1, min(8, int(os.getenv("TTS_VIENEU_STREAM_OVERLAP_FRAMES", "1")))),
        tts_preload=os.getenv("TTS_PRELOAD", "true").strip().lower() not in {"0", "false", "no"},
        tts_voice=os.getenv("TTS_VOICE", "vietnam").strip(),
        tts_rate=os.getenv("TTS_RATE", "185").strip(),
        stt_model=os.getenv("STT_MODEL", "small").strip(),
        stt_device=os.getenv("STT_DEVICE", "auto").strip(),
        stt_compute_type=os.getenv("STT_COMPUTE_TYPE", "auto").strip(),
        stt_beam_size=int(os.getenv("STT_BEAM_SIZE", "5")),
        stt_best_of=int(os.getenv("STT_BEST_OF", "3")),
        stt_partial_beam_size=max(1, int(os.getenv("STT_PARTIAL_BEAM_SIZE", "1"))),
        stt_partial_best_of=max(1, int(os.getenv("STT_PARTIAL_BEST_OF", "1"))),
        stt_vad_min_silence_ms=int(os.getenv("STT_VAD_MIN_SILENCE_MS", "450")),
        stt_preload=os.getenv("STT_PRELOAD", "true").strip().lower() not in {"0", "false", "no"},
        stt_cpu_threads=max(1, int(os.getenv("STT_CPU_THREADS", str(default_cpu_threads)))),
        stt_num_workers=max(1, int(os.getenv("STT_NUM_WORKERS", "1"))),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "25.0")),
        llm_timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", "120.0")),
        session_timeout_minutes=int(os.getenv("SESSION_TIMEOUT_MINUTES", "15")),
    )
