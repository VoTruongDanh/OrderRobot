from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import io
import importlib.util
from importlib import metadata as importlib_metadata
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import warnings
import wave
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Literal

import anyio
import edge_tts
import numpy as np
import pyttsx3
from fastapi import UploadFile
from faster_whisper import WhisperModel

from app.config import Settings
from app.models import MenuItem
from app.services.core_backend_client import CoreBackendClient

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "8")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")

logger = logging.getLogger("uvicorn.error")
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
logging.getLogger("torch.distributed.elastic.multiprocessing.redirects").setLevel(logging.ERROR)

warnings.filterwarnings(
    "ignore",
    message=r"The `local_dir_use_symlinks` argument is deprecated.*",
    category=UserWarning,
)
warnings.filterwarnings(
    "ignore",
    message=r"The `resume_download` argument is deprecated.*",
    category=UserWarning,
)
warnings.filterwarnings(
    "ignore",
    message=r"Redirects are currently not supported in Windows or MacOs\.",
    category=UserWarning,
)
warnings.filterwarnings(
    "ignore",
    message=r".*unauthenticated requests to the HF Hub.*",
    category=UserWarning,
)

SpeechMode = Literal["order", "caption"]


COMMON_ORDERING_PHRASES = {
    "ca phe": "cà phê",
    "ca phe muoi": "Cà phê muối",
    "cafe muoi": "Cà phê muối",
    "cafe mui": "Cà phê muối",
    "ca phe mui": "Cà phê muối",
    "bac xiu": "Bạc xỉu",
    "bac siu": "Bạc xỉu",
    "tra dao cam sa": "Trà đào cam sả",
    "tra sua": "trà sữa",
    "tra sua tran chau": "Trà sữa trân châu",
    "tra sua khoai mon": "Trà sữa khoai môn",
    "tra sua dua luoi": "Trà sữa dưa lưới",
    "matcha": "Matcha latte",
    "matcha latte": "Matcha latte",
    "socola da xay": "Socola đá xay",
    "chanh day da xay": "Chanh dây đá xay",
    "cookies cream da xay": "Cookies & cream đá xay",
    "americano cam": "Americano cam",
    "cappuccino": "Cappuccino",
    "latte hat de": "Latte hạt dẻ",
    "banh flan": "Bánh flan caramel",
    "tiramisu": "Tiramisu",
}

ACTIONABLE_KEYWORDS = {
    "cho",
    "them",
    "lay",
    "goi",
    "tu van",
    "de xuat",
    "xac nhan",
    "huy",
    "bo",
    "khong",
    "it da",
    "it ngot",
    "nong",
    "lanh",
}

ORDERING_INTENT_KEYWORDS = {
    "mon",
    "menu",
    "nuoc",
    "uong",
    "do uong",
    "combo",
    "gia",
    "khuyen mai",
    "ban chay",
}

ORDERING_FILLERS = [
    "cho minh",
    "cho em",
    "cho toi",
    "minh muon",
    "toi muon",
    "lay cho minh",
    "lay cho em",
    "goi cho minh",
    "goi cho em",
    "em oi",
    "robot oi",
    "cho",
    "lay",
    "goi",
    "them",
]

STREAM_SENTENCE_SPLIT_PATTERN = re.compile(r"(?<=[.!?;:])\s+")
STREAM_CLAUSE_SPLIT_PATTERN = re.compile(r"\s*(?:,|\bva\b|\bvoi\b)\s+", re.IGNORECASE)
STREAM_SEGMENT_MAX_CHARS = 120
DEFAULT_VIENEU_CPU_MODEL = "pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF"
DEFAULT_VIENEU_CPU_TURBO_MODEL = "pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF"
DEFAULT_VIENEU_CPU_LEGACY_MODEL = "pnnbao-ump/VieNeu-TTS-0.3B-q4-gguf"
DEFAULT_VIENEU_CPU_CODEC_REPO = "neuphonic/neucodec-onnx-decoder-int8"


class SpeechNotHeardError(ValueError):
    pass


@dataclass(slots=True)
class SynthesizedAudio:
    content: bytes
    media_type: str


class SpeechService:
    def __init__(self, settings: Settings, core_client: CoreBackendClient | None = None) -> None:
        self.settings = settings
        self.core_client = core_client
        self._stt_model: WhisperModel | None = None
        self._stt_lock = threading.Lock()
        self._vieneu_instance: object | None = None
        self._vieneu_lock = threading.Lock()
        self._vieneu_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="vieneu-tts",
        )
        self._stt_prompt_cache: str | None = None
        self._stt_hotwords_cache: str | None = None
        self._lexicon_cache: list[tuple[str, str]] | None = None
        self._menu_items_cache: list[MenuItem] | None = None
        self._vieneu_last_error: str = ""
        self._vieneu_last_init_ms: int = 0
        self._vieneu_prewarmed_at: float = 0.0
        self._vieneu_prewarm_ms: int = 0
        self._vieneu_stream_guard = threading.Lock()
        self._vieneu_active_stream_cancel: threading.Event | None = None
        self._vieneu_stream_last_realtime_factor: float = 0.0
        self._vieneu_effective_model_path: str = ""
        self._vieneu_effective_codec_repo: str = ""
        self._vieneu_compat_warning: str = ""
        self._vieneu_version: str = ""
        self._vieneu_import_checked: bool = False
        self._vieneu_import_ok: bool = False

    async def synthesize(
        self,
        text: str,
        voice: str | None = None,
        rate: int | None = None,
        vieneu_overrides: dict[str, object] | None = None,
    ) -> SynthesizedAudio:
        return await self._synthesize_async(text, voice, rate, vieneu_overrides=vieneu_overrides)

    async def synthesize_stream(
        self,
        text: str,
        voice: str | None = None,
        rate: int | None = None,
        vieneu_overrides: dict[str, object] | None = None,
    ):
        """Stream audio chunks for low latency playback."""
        normalized_text = normalize_speech_text(text)
        if not normalized_text:
            return
        resolved_engine = self._resolve_tts_engine(vieneu_overrides)

        if self._should_use_vieneu(vieneu_overrides):
            try:
                async for chunk in self._synthesize_with_vieneu_stream_async(
                    normalized_text,
                    vieneu_overrides=vieneu_overrides,
                ):
                    if chunk:
                        yield chunk
                return
            except Exception as exc:
                if resolved_engine == "vieneu":
                    raise RuntimeError(f"VieNeu stream failed: {exc}") from exc
                logger.exception("VieNeu stream failed, falling back to Edge/local TTS.")

        actual_voice = voice or self.settings.tts_voice
        actual_rate = rate or parse_tts_rate(self.settings.tts_rate)
        padded_text = normalized_text if normalized_text.startswith(". ") else f". {normalized_text}"

        try:
            communicate = edge_tts.Communicate(
                text=padded_text,
                voice=pick_edge_voice(self.settings.voice_lang, actual_voice),
                rate=convert_rate_to_edge(actual_rate),
            )
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    yield chunk["data"]
        except Exception as edge_error:
            try:
                audio = await self._synthesize_async(normalized_text, voice, rate)
                if audio.content:
                    yield audio.content
            except Exception as fallback_error:
                logger.error("Edge TTS failed: %s", edge_error)
                logger.error("Fallback TTS also failed: %s", fallback_error)
                return

    async def transcribe(self, file: UploadFile, mode: SpeechMode = "order") -> str:
        content = await file.read()
        if not content:
            raise ValueError("Audio upload trong.")

        filename = file.filename or "speech.webm"
        await self._ensure_menu_items_loaded()
        return await anyio.to_thread.run_sync(self._transcribe_sync, content, filename, mode)

    async def transcribe_partial(
        self,
        content: bytes,
        filename: str = "speech.webm",
        mode: SpeechMode = "order",
    ) -> str:
        if not content:
            return ""

        await self._ensure_menu_items_loaded()
        return await anyio.to_thread.run_sync(self._transcribe_partial_sync, content, filename, mode)

    async def transcribe_bytes(
        self,
        content: bytes,
        filename: str = "speech.webm",
        mode: SpeechMode = "order",
    ) -> str:
        if not content:
            raise ValueError("Audio upload trong.")

        await self._ensure_menu_items_loaded()
        return await anyio.to_thread.run_sync(self._transcribe_sync, content, filename, mode)

    async def preload_stt(self) -> None:
        await self._ensure_menu_items_loaded()
        await anyio.to_thread.run_sync(self._preload_stt_assets)

    async def preload_tts(self) -> None:
        if not self.settings.tts_preload:
            return
        resolved_engine = self._resolve_tts_engine()
        if resolved_engine not in {"auto", "vieneu"}:
            return
        if not self._is_vieneu_available():
            logger.warning("tts_prewarm_skip reason=vieneu_not_installed")
            return
        started_at = time.perf_counter()
        try:
            await anyio.to_thread.run_sync(self._preload_vieneu_sync)
            self._vieneu_prewarm_ms = int((time.perf_counter() - started_at) * 1000)
            self._vieneu_prewarmed_at = time.time()
            logger.info(
                "tts_prewarm_ms=%s engine=vieneu model=%s",
                self._vieneu_prewarm_ms,
                self.settings.tts_vieneu_model_path.strip() or DEFAULT_VIENEU_CPU_MODEL,
            )
        except Exception as exc:
            self._vieneu_last_error = f"{type(exc).__name__}: {exc}"
            logger.exception("tts_prewarm_failed engine=vieneu")

    async def prewarm_vieneu_now(self) -> None:
        if not self._is_vieneu_available():
            raise RuntimeError("VieNeu package is not installed.")
        started_at = time.perf_counter()
        await anyio.to_thread.run_sync(self._preload_vieneu_sync)
        self._vieneu_prewarm_ms = int((time.perf_counter() - started_at) * 1000)
        self._vieneu_prewarmed_at = time.time()

    def _normalize_vieneu_mode(self, raw_mode: str | None) -> str:
        mode = (raw_mode or "turbo").strip().lower()
        if mode == "gpu":
            return "fast"
        if mode == "api":
            return "remote"
        if mode in {"turbo", "turbo_gpu", "standard", "fast", "xpu", "remote"}:
            return mode
        return "turbo"

    def get_vieneu_diagnostics(self) -> dict[str, object]:
        configured_mode = self._normalize_vieneu_mode(self.settings.tts_vieneu_mode)
        configured_model_path = self.settings.tts_vieneu_model_path.strip() or DEFAULT_VIENEU_CPU_MODEL
        configured_codec_repo = self.settings.tts_vieneu_codec_repo.strip()
        configured_backbone_device = (self.settings.tts_vieneu_backbone_device or "cpu").strip().lower() or "cpu"
        configured_codec_device = (self.settings.tts_vieneu_codec_device or "cpu").strip().lower() or "cpu"
        effective_model_path, effective_codec_repo, compat_warning, vieneu_version = self._resolve_vieneu_runtime_compat(
            configured_model_path=configured_model_path,
            configured_codec_repo=configured_codec_repo,
            mode=configured_mode,
            backbone_device=configured_backbone_device,
            codec_device=configured_codec_device,
        )
        return {
            "available": self._is_vieneu_available(),
            "engine": self.settings.tts_engine,
            "mode": configured_mode,
            "configured_model_path": configured_model_path,
            "model_path": self._vieneu_effective_model_path or effective_model_path,
            "backbone_device": configured_backbone_device,
            "configured_codec_repo": configured_codec_repo,
            "codec_repo": self._vieneu_effective_codec_repo or effective_codec_repo,
            "codec_device": configured_codec_device,
            "remote_api_base": self.settings.tts_vieneu_remote_api_base,
            "instance_ready": self._vieneu_instance is not None,
            "last_init_ms": self._vieneu_last_init_ms,
            "prewarm_ms": self._vieneu_prewarm_ms,
            "prewarmed_at_unix": self._vieneu_prewarmed_at or 0,
            "last_error": self._vieneu_last_error,
            "compat_warning": self._vieneu_compat_warning or compat_warning,
            "vieneu_version": self._vieneu_version or vieneu_version,
            "stream_realtime_factor": round(self._vieneu_stream_last_realtime_factor, 4),
            "cpu_processing": self._collect_cpu_runtime_versions(),
            "stream_cfg": {
                "frames_per_chunk": self.settings.tts_vieneu_stream_frames_per_chunk,
                "lookforward": self.settings.tts_vieneu_stream_lookforward,
                "lookback": self.settings.tts_vieneu_stream_lookback,
                "overlap_frames": self.settings.tts_vieneu_stream_overlap_frames,
            },
        }

    def _collect_cpu_runtime_versions(self) -> dict[str, str]:
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

    def _resolve_vieneu_runtime_compat(
        self,
        *,
        configured_model_path: str,
        configured_codec_repo: str,
        mode: str,
        backbone_device: str,
        codec_device: str,
    ) -> tuple[str, str, str, str]:
        model_path = configured_model_path.strip() or DEFAULT_VIENEU_CPU_MODEL
        codec_repo = configured_codec_repo.strip()
        warnings: list[str] = []

        try:
            vieneu_version = importlib_metadata.version("vieneu")
        except Exception:
            vieneu_version = ""

        major_version = 0
        if vieneu_version:
            try:
                major_version = int(vieneu_version.split(".", maxsplit=1)[0])
            except (TypeError, ValueError):
                major_version = 0

        normalized_model_path = model_path.lower()
        normalized_codec_repo = codec_repo.lower()
        is_turbo_model = "vieneu-tts-v2-turbo-gguf" in normalized_model_path
        is_legacy_cpu_model = "vieneu-tts-0.3b" in normalized_model_path

        if "vieneu" in normalized_model_path and "0.2b" in normalized_model_path:
            model_path = DEFAULT_VIENEU_CPU_TURBO_MODEL
            warnings.append(
                "Hien chua co model VieNeu 0.2B chinh thuc; da fallback sang VieNeu-TTS-v2-Turbo-GGUF."
            )
            normalized_model_path = model_path.lower()
            is_turbo_model = True
            is_legacy_cpu_model = False

        if is_turbo_model and major_version and major_version < 2:
            model_path = DEFAULT_VIENEU_CPU_LEGACY_MODEL
            warnings.append(
                f"VieNeu {vieneu_version} chua toi uu cho v2-Turbo-GGUF; "
                f"tam dung dung model {DEFAULT_VIENEU_CPU_LEGACY_MODEL}. "
                "Nen nang cap vieneu>=2.1.3."
            )
            normalized_model_path = model_path.lower()
            is_turbo_model = False
            is_legacy_cpu_model = "vieneu-tts-0.3b" in normalized_model_path

        # Turbo should rely on SDK-default codec; forcing legacy ONNX codec causes noisy output.
        if is_turbo_model and normalized_codec_repo:
            codec_repo = ""
            warnings.append("Turbo model dung codec/decoder mac dinh cua SDK; bo qua codec_repo tu cau hinh.")

        if (
            not codec_repo
            and mode == "standard"
            and backbone_device == "cpu"
            and codec_device == "cpu"
            and is_legacy_cpu_model
        ):
            codec_repo = DEFAULT_VIENEU_CPU_CODEC_REPO

        return model_path, codec_repo, " ".join(warnings).strip(), vieneu_version

    def _preload_vieneu_sync(self) -> None:
        self._get_vieneu_instance()

    def _configure_vieneu_streaming(self, engine: object) -> None:
        updates: dict[str, int] = {
            "streaming_frames_per_chunk": self.settings.tts_vieneu_stream_frames_per_chunk,
            "streaming_lookforward": self.settings.tts_vieneu_stream_lookforward,
            "streaming_lookback": self.settings.tts_vieneu_stream_lookback,
            "streaming_overlap_frames": self.settings.tts_vieneu_stream_overlap_frames,
        }
        applied: dict[str, int] = {}
        for attr, value in updates.items():
            if hasattr(engine, attr):
                try:
                    setattr(engine, attr, int(value))
                    applied[attr] = int(getattr(engine, attr))
                except Exception:
                    logger.debug("Unable to set VieNeu stream attr '%s'.", attr, exc_info=True)

        if hasattr(engine, "hop_length") and hasattr(engine, "streaming_frames_per_chunk"):
            try:
                hop_length = int(getattr(engine, "hop_length"))
                frames = int(getattr(engine, "streaming_frames_per_chunk"))
                stride = max(1, frames * hop_length)
                setattr(engine, "streaming_stride_samples", stride)
                applied["streaming_stride_samples"] = stride
            except Exception:
                logger.debug("Unable to set VieNeu streaming stride.", exc_info=True)

        if applied:
            logger.info("vieneu_stream_config_applied %s", applied)

    async def _ensure_menu_items_loaded(self) -> None:
        if self._menu_items_cache is not None or self.core_client is None:
            return

        try:
            self._set_menu_items_cache(await self.core_client.list_menu())
        except Exception:
            logger.debug("Unable to preload menu items for STT lexicon.", exc_info=True)

    def _set_menu_items_cache(self, items: list[MenuItem]) -> None:
        self._menu_items_cache = list(items)
        self._stt_hotwords_cache = None
        self._lexicon_cache = None

    def _preload_stt_assets(self) -> None:
        self._get_stt_model()
        self._build_stt_prompt()
        self._build_stt_hotwords()
        self._get_ordering_lexicon()

    def _resolve_tts_engine(self, vieneu_overrides: dict[str, object] | None = None) -> str:
        override_engine = ""
        if vieneu_overrides:
            raw_engine = vieneu_overrides.get("engine")
            if raw_engine is not None:
                override_engine = str(raw_engine).strip().lower()

        engine = override_engine or (self.settings.tts_engine or "auto").strip().lower()
        if engine in {"auto", "vieneu", "edge", "local", "pyttsx3"}:
            return engine
        return "auto"

    def _should_use_vieneu(self, vieneu_overrides: dict[str, object] | None = None) -> bool:
        engine = self._resolve_tts_engine(vieneu_overrides)
        if engine == "vieneu":
            return self._is_vieneu_available()
        if engine in {"edge", "local", "pyttsx3"}:
            return False
        return self._is_vieneu_available()

    def _is_vieneu_available(self) -> bool:
        if self._vieneu_import_checked:
            return self._vieneu_import_ok

        if importlib.util.find_spec("vieneu") is None:
            self._vieneu_import_checked = True
            self._vieneu_import_ok = False
            return False

        try:
            from vieneu import Vieneu  # type: ignore[import-not-found]  # noqa: F401
            self._vieneu_import_ok = True
        except Exception as exc:
            self._vieneu_import_ok = False
            self._vieneu_last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("vieneu_unavailable error=%s", self._vieneu_last_error)
        finally:
            self._vieneu_import_checked = True

        return self._vieneu_import_ok

    def _get_vieneu_instance(self):
        if self._vieneu_instance is not None:
            self._configure_vieneu_streaming(self._vieneu_instance)
            return self._vieneu_instance

        with self._vieneu_lock:
            if self._vieneu_instance is not None:
                self._configure_vieneu_streaming(self._vieneu_instance)
                return self._vieneu_instance

            from vieneu import Vieneu  # type: ignore[import-not-found]

            requested_mode = self._normalize_vieneu_mode(self.settings.tts_vieneu_mode)
            vieneu_mode = requested_mode

            configured_model_path = self.settings.tts_vieneu_model_path.strip()
            backbone_device = (self.settings.tts_vieneu_backbone_device or "cpu").strip().lower() or "cpu"
            codec_device = (self.settings.tts_vieneu_codec_device or "cpu").strip().lower() or "cpu"
            remote_api_base = (self.settings.tts_vieneu_remote_api_base or "http://localhost:23333/v1").strip()
            model_path, codec_repo, compat_warning, vieneu_version = self._resolve_vieneu_runtime_compat(
                configured_model_path=configured_model_path,
                configured_codec_repo=(self.settings.tts_vieneu_codec_repo or "").strip(),
                mode=vieneu_mode,
                backbone_device=backbone_device,
                codec_device=codec_device,
            )
            normalized_model_path = (model_path or "").strip().lower()
            is_turbo_model = "vieneu-tts-v2-turbo-gguf" in normalized_model_path
            if is_turbo_model and vieneu_mode not in {"turbo", "turbo_gpu", "remote"}:
                preferred_mode = "turbo_gpu" if backbone_device in {"cuda", "gpu"} else "turbo"
                compat_warning = (
                    f"{compat_warning} Auto switch mode '{vieneu_mode}' -> '{preferred_mode}' for Turbo GGUF."
                ).strip()
                vieneu_mode = preferred_mode
            self._vieneu_effective_model_path = model_path
            self._vieneu_effective_codec_repo = codec_repo
            self._vieneu_compat_warning = compat_warning
            self._vieneu_version = vieneu_version
            if compat_warning:
                logger.warning("vieneu_compat_fallback %s", compat_warning)

            init_attempts: list[dict[str, object]] = []
            if vieneu_mode in {"standard", "fast", "xpu"}:
                primary_kwargs: dict[str, object] = {
                    "backbone_repo": model_path,
                    "backbone_device": backbone_device,
                    "codec_device": codec_device,
                }
                if codec_repo:
                    primary_kwargs["codec_repo"] = codec_repo
                init_attempts.append(primary_kwargs)
                if codec_repo:
                    fallback_kwargs = dict(primary_kwargs)
                    fallback_kwargs.pop("codec_repo", None)
                    init_attempts.append(fallback_kwargs)
            elif vieneu_mode == "remote":
                primary_kwargs = {
                    "api_base": remote_api_base,
                    "model_name": model_path,
                    "codec_device": codec_device,
                }
                if codec_repo:
                    primary_kwargs["codec_repo"] = codec_repo
                init_attempts.append(primary_kwargs)
                if codec_repo:
                    fallback_kwargs = dict(primary_kwargs)
                    fallback_kwargs.pop("codec_repo", None)
                    init_attempts.append(fallback_kwargs)
            elif vieneu_mode in {"turbo", "turbo_gpu"}:
                primary_kwargs = {
                    "backbone_repo": model_path,
                    "device": backbone_device,
                }
                init_attempts.append(primary_kwargs)

            init_attempts.append({})

            deduplicated_attempts: list[dict[str, object]] = []
            seen_keys: set[tuple[tuple[str, str], ...]] = set()
            for attempt in init_attempts:
                fingerprint = tuple(sorted((key, str(value)) for key, value in attempt.items()))
                if fingerprint in seen_keys:
                    continue
                seen_keys.add(fingerprint)
                deduplicated_attempts.append(attempt)
            init_attempts = deduplicated_attempts

            is_local_model_path = False
            try:
                is_local_model_path = Path(model_path).exists()
            except Exception:
                is_local_model_path = False
            prefers_offline_cache = (
                vieneu_mode != "remote"
                and bool(model_path)
                and ("/" in model_path)
                and not is_local_model_path
            )

            last_error: Exception | None = None
            for kwargs in init_attempts:
                offline_modes = [False]
                if prefers_offline_cache:
                    offline_modes = [True, False]

                for offline_mode in offline_modes:
                    init_started_at = time.perf_counter()
                    previous_offline_env = os.getenv("HF_HUB_OFFLINE")
                    if offline_mode:
                        os.environ["HF_HUB_OFFLINE"] = "1"
                    else:
                        if previous_offline_env is None:
                            os.environ.pop("HF_HUB_OFFLINE", None)
                        else:
                            os.environ["HF_HUB_OFFLINE"] = previous_offline_env

                    try:
                        self._vieneu_instance = Vieneu(mode=vieneu_mode, **kwargs)
                        self._configure_vieneu_streaming(self._vieneu_instance)
                        self._vieneu_last_init_ms = int((time.perf_counter() - init_started_at) * 1000)
                        logger.info(
                            "vieneu_init_ok ms=%s mode=%s kwargs=%s offline=%s",
                            self._vieneu_last_init_ms,
                            vieneu_mode,
                            kwargs,
                            offline_mode,
                        )
                        self._vieneu_last_error = ""
                        break
                    except Exception as exc:
                        last_error = exc
                        self._vieneu_last_error = f"{type(exc).__name__}: {exc}"
                        logger.warning(
                            "vieneu_init_failed mode=%s kwargs=%s offline=%s err=%s",
                            vieneu_mode,
                            kwargs,
                            offline_mode,
                            self._vieneu_last_error,
                        )
                    finally:
                        if previous_offline_env is None:
                            os.environ.pop("HF_HUB_OFFLINE", None)
                        else:
                            os.environ["HF_HUB_OFFLINE"] = previous_offline_env

                if self._vieneu_instance is not None:
                    break

            if self._vieneu_instance is None and last_error is not None:
                raise last_error

            logger.info(
                "vieneu_ready mode=%s requested=%s effective=%s codec_repo=%s version=%s init_ms=%s",
                vieneu_mode,
                configured_model_path or "default",
                model_path or "default",
                codec_repo or "default",
                vieneu_version or "unknown",
                self._vieneu_last_init_ms,
            )
            return self._vieneu_instance

    async def list_vieneu_voices(self) -> list[dict[str, str]]:
        if not self._is_vieneu_available():
            return []
        try:
            return await anyio.to_thread.run_sync(self._list_vieneu_voices_sync)
        except Exception:
            logger.exception("Unable to list VieNeu preset voices.")
            return []

    def _list_vieneu_voices_sync(self) -> list[dict[str, str]]:
        engine = self._get_vieneu_instance()
        result: object = []
        with self._vieneu_lock:
            list_fn = getattr(engine, "list_preset_voices", None)
            if callable(list_fn):
                result = list_fn()
            else:
                # Backward compatibility for older/newer SDK variants.
                for attr_name in ("preset_voices", "voice_presets", "voices"):
                    if hasattr(engine, attr_name):
                        result = getattr(engine, attr_name)
                        break

        raw_items: list[object] = []
        if isinstance(result, dict):
            raw_items = list(result.items())
        elif isinstance(result, (list, tuple, set)):
            raw_items = list(result)

        voices: list[dict[str, str]] = []
        for index, item in enumerate(raw_items):
            if isinstance(item, (tuple, list)) and len(item) >= 2:
                description = str(item[0] or "").strip() or f"Voice {index + 1}"
                voice_id = str(item[1] or "").strip()
            else:
                description = str(item or "").strip() or f"Voice {index + 1}"
                voice_id = description
            if not voice_id:
                continue
            voices.append({"id": voice_id, "description": description})
        # Stable order + deduplicate by voice id.
        unique: dict[str, dict[str, str]] = {}
        for voice in voices:
            unique[voice["id"]] = voice
        return [unique[key] for key in sorted(unique.keys(), key=lambda item: item.lower())]

    def reset_vieneu_runtime(self) -> None:
        stale_instance = None
        with self._vieneu_lock:
            stale_instance = self._vieneu_instance
            self._vieneu_instance = None
            self._vieneu_effective_model_path = ""
            self._vieneu_effective_codec_repo = ""
            self._vieneu_compat_warning = ""

        if stale_instance is None:
            return

        close_fn = getattr(stale_instance, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                logger.debug("Ignoring VieNeu close error while resetting runtime.", exc_info=True)

    def _register_vieneu_stream(self, current_cancel_event: threading.Event) -> threading.Event | None:
        with self._vieneu_stream_guard:
            previous = self._vieneu_active_stream_cancel
            self._vieneu_active_stream_cancel = current_cancel_event
            return previous

    def _unregister_vieneu_stream(self, current_cancel_event: threading.Event) -> None:
        with self._vieneu_stream_guard:
            if self._vieneu_active_stream_cancel is current_cancel_event:
                self._vieneu_active_stream_cancel = None

    async def _synthesize_with_vieneu_async(
        self,
        text: str,
        vieneu_overrides: dict[str, object] | None = None,
    ) -> SynthesizedAudio:
        if vieneu_overrides is None:
            return await anyio.to_thread.run_sync(
                self._synthesize_with_vieneu_sync,
                text,
            )
        return await anyio.to_thread.run_sync(
            self._synthesize_with_vieneu_sync,
            text,
            vieneu_overrides,
        )

    async def _synthesize_with_vieneu_stream_async(
        self,
        text: str,
        vieneu_overrides: dict[str, object] | None = None,
    ):
        request_started_at = time.perf_counter()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[object] = asyncio.Queue()
        done_sentinel = object()
        current_cancel_event = threading.Event()
        previous_cancel_event = self._register_vieneu_stream(current_cancel_event)
        if previous_cancel_event is not None:
            previous_cancel_event.set()

        def push(item: object) -> None:
            if current_cancel_event.is_set():
                return
            try:
                future = asyncio.run_coroutine_threadsafe(queue.put(item), loop)
                future.result()
            except Exception:
                # Request may already be cancelled and loop closed for this generator.
                return

        def worker() -> None:
            try:
                for chunk in self._synthesize_with_vieneu_stream_sync(
                    text,
                    vieneu_overrides=vieneu_overrides,
                    cancel_event=current_cancel_event,
                ):
                    if current_cancel_event.is_set():
                        break
                    push(chunk)
            except Exception as exc:  # pragma: no cover - exercised in runtime flow
                push(exc)
            finally:
                push(done_sentinel)

        threading.Thread(target=worker, daemon=True, name="vieneu-stream").start()

        first_chunk_at = 0.0
        chunk_count = 0
        chunk_bytes = 0
        sample_rate = 24000
        header_bytes = 0
        try:
            while True:
                item = await queue.get()
                if item is done_sentinel:
                    break
                if isinstance(item, Exception):
                    raise item
                if isinstance(item, (bytes, bytearray)):
                    chunk = bytes(item)
                    if chunk:
                        if not first_chunk_at:
                            first_chunk_at = time.perf_counter()
                            if len(chunk) >= 44 and chunk[:4] == b"RIFF":
                                try:
                                    sample_rate = int.from_bytes(chunk[24:28], "little", signed=False)
                                    header_bytes = 44
                                except Exception:
                                    sample_rate = 24000
                        chunk_count += 1
                        chunk_bytes += len(chunk)
                        yield chunk
        except asyncio.CancelledError:
            current_cancel_event.set()
            raise
        finally:
            current_cancel_event.set()
            self._unregister_vieneu_stream(current_cancel_event)
            elapsed_sec = time.perf_counter() - request_started_at
            payload_bytes = max(0, chunk_bytes - header_bytes)
            audio_sec = payload_bytes / 2 / max(sample_rate, 1)
            realtime_factor = (audio_sec / elapsed_sec) if elapsed_sec > 0 else 0.0
            self._vieneu_stream_last_realtime_factor = realtime_factor
            logger.info(
                "tts_stream_ms=%s tts_first_chunk_ms=%s chunks=%s bytes=%s audio_sec=%.3f realtime_factor=%.3f engine=vieneu text_chars=%s",
                int(elapsed_sec * 1000),
                int((first_chunk_at - request_started_at) * 1000) if first_chunk_at else -1,
                chunk_count,
                chunk_bytes,
                audio_sec,
                realtime_factor,
                len(text),
            )

    def _synthesize_with_vieneu_stream_sync(
        self,
        text: str,
        vieneu_overrides: dict[str, object] | None = None,
        cancel_event: threading.Event | None = None,
    ):
        safe_text = text.strip()
        if not safe_text:
            return

        engine = self._get_vieneu_instance()
        infer_stream_fn = getattr(engine, "infer_stream", None)
        if not callable(infer_stream_fn):
            fallback_audio = self._synthesize_with_vieneu_sync(safe_text, vieneu_overrides=vieneu_overrides)
            if fallback_audio.content:
                yield fallback_audio.content
            return

        infer_kwargs = self._build_vieneu_infer_kwargs(
            engine,
            safe_text,
            vieneu_overrides=vieneu_overrides,
        )
        sample_rate = self._resolve_vieneu_sample_rate(engine)
        yielded_any = False
        header = self._build_wav_stream_header(sample_rate)
        header_sent = False

        with self._vieneu_lock:
            stream_result = call_with_supported_kwargs(infer_stream_fn, infer_kwargs)

            if isinstance(stream_result, (bytes, bytearray)):
                payload = self._normalize_vieneu_stream_pcm_bytes(stream_result)
                if payload:
                    if header and not header_sent:
                        header_sent = True
                        yielded_any = True
                        yield header
                    yielded_any = True
                    yield payload
            elif isinstance(stream_result, np.ndarray):
                if cancel_event is not None and cancel_event.is_set():
                    return
                payload = self._normalize_vieneu_stream_pcm_bytes(stream_result)
                if payload:
                    if header and not header_sent:
                        header_sent = True
                        yielded_any = True
                        yield header
                    yielded_any = True
                    yield payload
            elif stream_result is not None:
                for item in stream_result:
                    if cancel_event is not None and cancel_event.is_set():
                        close_fn = getattr(stream_result, "close", None)
                        if callable(close_fn):
                            try:
                                close_fn()
                            except Exception:
                                logger.debug("Ignored VieNeu stream close error.", exc_info=True)
                        break

                    payload = self._normalize_vieneu_stream_pcm_bytes(item)
                    if payload:
                        if header and not header_sent:
                            yielded_any = True
                            header_sent = True
                            yield header
                        yielded_any = True
                        yield payload

        if yielded_any:
            return

        # Fallback for SDK variants that expose infer_stream but may return no chunks.
        fallback_audio = self._synthesize_with_vieneu_sync(safe_text, vieneu_overrides=vieneu_overrides)
        if fallback_audio.content:
            yield fallback_audio.content

    def _synthesize_with_vieneu_sync(
        self,
        text: str,
        vieneu_overrides: dict[str, object] | None = None,
    ) -> SynthesizedAudio:
        safe_text = text.strip()
        if not safe_text:
            return SynthesizedAudio(content=b"", media_type="audio/wav")

        started_at = time.perf_counter()
        engine = self._get_vieneu_instance()
        with self._vieneu_lock:
            infer_kwargs = self._build_vieneu_infer_kwargs(
                engine,
                safe_text,
                vieneu_overrides=vieneu_overrides,
            )
            synthesized = call_with_supported_kwargs(engine.infer, infer_kwargs)

            if isinstance(synthesized, (bytes, bytearray)):
                raw = bytes(synthesized)
                if raw:
                    logger.info(
                        "tts_sync_ms=%s bytes=%s engine=vieneu text_chars=%s",
                        int((time.perf_counter() - started_at) * 1000),
                        len(raw),
                        len(safe_text),
                    )
                    return SynthesizedAudio(content=raw, media_type="audio/wav")

            save_fn = getattr(engine, "save", None)
            if callable(save_fn):
                temp_path = Path(tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name)
                try:
                    save_fn(synthesized, str(temp_path))
                    audio_bytes = temp_path.read_bytes()
                finally:
                    if temp_path.exists():
                        os.unlink(temp_path)

                if audio_bytes:
                    logger.info(
                        "tts_sync_ms=%s bytes=%s engine=vieneu text_chars=%s",
                        int((time.perf_counter() - started_at) * 1000),
                        len(audio_bytes),
                        len(safe_text),
                    )
                    return SynthesizedAudio(content=audio_bytes, media_type="audio/wav")

        raise RuntimeError("VieNeu khong tao duoc audio.")

    def _build_vieneu_infer_kwargs(
        self,
        engine: object,
        text: str,
        vieneu_overrides: dict[str, object] | None = None,
    ) -> dict[str, object]:
        infer_kwargs: dict[str, object] = {"text": text}

        override_voice_id = coerce_optional_string(vieneu_overrides.get("vieneu_voice_id")) if vieneu_overrides else None
        override_ref_audio = coerce_optional_string(vieneu_overrides.get("vieneu_ref_audio")) if vieneu_overrides else None
        override_ref_text = coerce_optional_string(vieneu_overrides.get("vieneu_ref_text")) if vieneu_overrides else None
        override_temperature = vieneu_overrides.get("vieneu_temperature") if vieneu_overrides else None
        override_top_k = vieneu_overrides.get("vieneu_top_k") if vieneu_overrides else None
        override_max_chars = vieneu_overrides.get("vieneu_max_chars") if vieneu_overrides else None

        voice_id = override_voice_id or self.settings.tts_vieneu_voice_id.strip()
        ref_audio = override_ref_audio or self.settings.tts_vieneu_ref_audio.strip()
        ref_text = override_ref_text or self.settings.tts_vieneu_ref_text.strip()

        infer_kwargs["temperature"] = clamp_float(
            override_temperature,
            self.settings.tts_vieneu_temperature,
            min_value=0.1,
            max_value=2.0,
        )
        infer_kwargs["top_k"] = clamp_int(
            override_top_k,
            self.settings.tts_vieneu_top_k,
            min_value=1,
            max_value=200,
        )
        infer_kwargs["max_chars"] = clamp_int(
            override_max_chars,
            self.settings.tts_vieneu_max_chars,
            min_value=32,
            max_value=512,
        )

        if ref_audio and ref_text:
            infer_kwargs["ref_audio"] = ref_audio
            infer_kwargs["ref_text"] = ref_text
        elif ref_audio and not ref_text:
            logger.warning("Ignoring VieNeu ref_audio because ref_text is empty.")

        active_model = (
            self._vieneu_effective_model_path
            or self.settings.tts_vieneu_model_path.strip()
            or DEFAULT_VIENEU_CPU_MODEL
        )
        if (
            "vieneu-tts-v2-turbo-gguf" in active_model.lower()
            and "ref_audio" in infer_kwargs
        ):
            # VieNeu Turbo model card currently flags cloning as not supported.
            infer_kwargs.pop("ref_audio", None)
            infer_kwargs.pop("ref_text", None)
            logger.warning(
                "VieNeu Turbo currently does not support ref_audio cloning; fallback to preset/default voice."
            )

        is_turbo_runtime = "vieneu-tts-v2-turbo-gguf" in active_model.lower()
        if not is_turbo_runtime:
            engine_name = type(engine).__name__.lower()
            is_turbo_runtime = "turbo" in engine_name

        def apply_voice_payload(voice_payload: object, selected_voice_id: str) -> None:
            # Turbo runtime uses `voice` for infer(...) and `ref_codes` for infer_stream(...).
            # Set both to keep preset voice consistent across sync + stream endpoints.
            if is_turbo_runtime:
                infer_kwargs["voice"] = voice_payload
                infer_kwargs["ref_codes"] = voice_payload
            else:
                infer_kwargs["voice"] = voice_payload
            logger.info(
                "vieneu_voice_selected id=%s turbo=%s",
                selected_voice_id,
                is_turbo_runtime,
            )

        if "ref_audio" not in infer_kwargs and voice_id:
            get_voice_fn = getattr(engine, "get_preset_voice", None)
            if callable(get_voice_fn):
                try:
                    voice_payload = get_voice_fn(voice_id)
                    apply_voice_payload(voice_payload, voice_id)
                except Exception:
                    resolved_voice_id = self._resolve_vieneu_voice_alias(engine, voice_id)
                    if resolved_voice_id and resolved_voice_id != voice_id:
                        try:
                            voice_payload = get_voice_fn(resolved_voice_id)
                            apply_voice_payload(voice_payload, resolved_voice_id)
                            logger.info(
                                "VieNeu preset voice alias mapped: '%s' -> '%s'.",
                                voice_id,
                                resolved_voice_id,
                            )
                        except Exception:
                            logger.warning(
                                "VieNeu preset voice '%s' (alias '%s') not found. Falling back to default voice.",
                                voice_id,
                                resolved_voice_id,
                            )
                    else:
                        logger.warning("VieNeu preset voice '%s' not found. Falling back to default voice.", voice_id)
            else:
                logger.debug("VieNeu engine does not support preset voice lookup.")

        return infer_kwargs

    def _resolve_vieneu_voice_alias(self, engine: object, voice_id: str) -> str | None:
        alias_raw = str(voice_id or "").strip()
        if not alias_raw:
            return None

        alias_norm = normalize_vietnamese_text(alias_raw)
        if not alias_norm:
            return None

        list_fn = getattr(engine, "list_preset_voices", None)
        if not callable(list_fn):
            return None

        try:
            raw_voices = list_fn()
        except Exception:
            return None

        if not isinstance(raw_voices, (list, tuple, set)):
            return None

        best_id = None
        best_score = 0.0
        for item in raw_voices:
            description = ""
            candidate_id = ""
            if isinstance(item, (tuple, list)) and len(item) >= 2:
                description = str(item[0] or "").strip()
                candidate_id = str(item[1] or "").strip()
            else:
                description = str(item or "").strip()
                candidate_id = description
            if not candidate_id:
                continue

            candidate_norm = normalize_vietnamese_text(candidate_id)
            description_norm = normalize_vietnamese_text(description)
            if not candidate_norm and not description_norm:
                continue

            score = 0.0
            if alias_norm == candidate_norm:
                score = 1.0
            elif alias_norm == description_norm:
                score = 0.99
            elif alias_norm and candidate_norm and (alias_norm in candidate_norm or candidate_norm in alias_norm):
                score = 0.95
            elif alias_norm and description_norm and (alias_norm in description_norm or description_norm in alias_norm):
                score = 0.92
            else:
                score = max(
                    SequenceMatcher(None, alias_norm, candidate_norm).ratio() if candidate_norm else 0.0,
                    SequenceMatcher(None, alias_norm, description_norm).ratio() if description_norm else 0.0,
                )

            if score > best_score:
                best_score = score
                best_id = candidate_id

        if best_id and best_score >= 0.6:
            return best_id
        return None

    def _resolve_vieneu_sample_rate(self, engine: object) -> int:
        raw_rate = getattr(engine, "sample_rate", 24000)
        try:
            parsed = int(raw_rate)
        except (TypeError, ValueError):
            return 24000
        if parsed < 8000 or parsed > 192000:
            return 24000
        return parsed

    def _build_wav_stream_header(self, sample_rate: int) -> bytes:
        try:
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as wav_writer:
                wav_writer.setnchannels(1)
                wav_writer.setsampwidth(2)
                wav_writer.setframerate(sample_rate)
                wav_writer.writeframes(b"")
            return buffer.getvalue()
        except Exception:
            return b""

    def _to_pcm16_chunk_bytes(self, chunk: object) -> bytes:
        if chunk is None:
            return b""
        if isinstance(chunk, (bytes, bytearray)):
            return bytes(chunk)

        try:
            waveform = np.asarray(chunk)
        except Exception:
            return b""

        if waveform.size == 0:
            return b""
        if waveform.ndim > 1:
            waveform = waveform.reshape(-1)

        if np.issubdtype(waveform.dtype, np.floating):
            float_waveform = waveform.astype(np.float32, copy=False)
            peak = float(np.max(np.abs(float_waveform))) if float_waveform.size else 0.0
            if peak > 1.0:
                float_waveform = float_waveform / max(peak, 1e-6)
            pcm16 = np.clip(float_waveform, -1.0, 1.0)
            pcm16 = (pcm16 * 32767.0).astype(np.int16)
        elif np.issubdtype(waveform.dtype, np.integer):
            if waveform.dtype == np.int16:
                pcm16 = waveform.astype(np.int16, copy=False)
            else:
                pcm16 = np.clip(waveform.astype(np.int64), -32768, 32767).astype(np.int16)
        else:
            return b""

        if pcm16.size == 0:
            return b""
        return np.ascontiguousarray(pcm16).tobytes()

    def _normalize_vieneu_stream_pcm_bytes(self, chunk: object) -> bytes:
        if chunk is None:
            return b""

        if isinstance(chunk, (bytes, bytearray)):
            payload = bytes(chunk)
            if not payload:
                return b""

            is_wav = (
                len(payload) >= 12
                and payload[0:4] == b"RIFF"
                and payload[8:12] == b"WAVE"
            )
            if is_wav:
                try:
                    with wave.open(io.BytesIO(payload), "rb") as wav_reader:
                        payload = wav_reader.readframes(wav_reader.getnframes())
                except Exception:
                    if len(payload) > 44:
                        payload = payload[44:]
                    else:
                        return b""

            # Keep 16-bit alignment for downstream Int16 decoding.
            if len(payload) % 2 == 1:
                payload = payload[:-1]
            return payload

        return self._to_pcm16_chunk_bytes(chunk)

    def _to_wav_chunk_bytes(self, chunk: object, sample_rate: int) -> bytes:
        if chunk is None:
            return b""
        if isinstance(chunk, (bytes, bytearray)):
            return bytes(chunk)

        pcm_payload = self._to_pcm16_chunk_bytes(chunk)
        if not pcm_payload:
            return b""

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_writer:
            wav_writer.setnchannels(1)
            wav_writer.setsampwidth(2)
            wav_writer.setframerate(sample_rate)
            wav_writer.writeframes(pcm_payload)
        return buffer.getvalue()

    async def _synthesize_async(
        self,
        text: str,
        voice: str | None = None,
        rate: int | None = None,
        vieneu_overrides: dict[str, object] | None = None,
    ) -> SynthesizedAudio:
        normalized_text = normalize_speech_text(text)
        resolved_engine = self._resolve_tts_engine(vieneu_overrides)
        if self._should_use_vieneu(vieneu_overrides):
            try:
                return await self._synthesize_with_vieneu_async(
                    normalized_text,
                    vieneu_overrides=vieneu_overrides,
                )
            except Exception as exc:
                # When user explicitly selects VieNeu, surface error instead of silently
                # falling back to default TTS voice (which causes "custom voice ignored").
                if resolved_engine == "vieneu":
                    raise RuntimeError(f"VieNeu synth failed: {exc}") from exc
                logger.exception("VieNeu synth failed, falling back to Edge/local TTS.")

        try:
            return await self._synthesize_with_edge_tts(normalized_text, voice, rate)
        except Exception:
            return await anyio.to_thread.run_sync(self._synthesize_sync, normalized_text)

    async def _synthesize_with_edge_tts(self, text: str, voice: str | None = None, rate: int | None = None) -> SynthesizedAudio:
        actual_voice = voice or self.settings.tts_voice
        actual_rate = rate or parse_tts_rate(self.settings.tts_rate)
        # Prepend '. ' to force a ~300ms silent pause before speaking.
        # This prevents Bluetooth/OS audio wake-up truncation of the first word!
        padded_text = text if text.startswith(". ") else (". " + text)
        
        communicate = edge_tts.Communicate(
            text=padded_text,
            voice=pick_edge_voice(self.settings.voice_lang, actual_voice),
            rate=convert_rate_to_edge(actual_rate),
        )
        audio_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            raise RuntimeError("Edge TTS khong tao duoc audio.")

        return SynthesizedAudio(content=b"".join(audio_chunks), media_type="audio/mpeg")

    def _synthesize_sync(self, text: str) -> SynthesizedAudio:
        temp_path = Path(tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name)
        try:
            try:
                self._synthesize_with_pyttsx3(text, temp_path)
            except Exception as exc:
                if not should_fallback_to_windows_tts(exc):
                    raise
                self._synthesize_with_windows_tts(text, temp_path)
            return SynthesizedAudio(content=temp_path.read_bytes(), media_type="audio/wav")
        finally:
            if temp_path.exists():
                os.unlink(temp_path)

    def _synthesize_with_pyttsx3(self, text: str, temp_path: Path) -> None:
        engine = pyttsx3.init()
        try:
            voice = pick_local_voice(engine, self.settings.voice_lang, self.settings.tts_voice)
            if voice is not None:
                engine.setProperty("voice", voice.id)

            engine.setProperty("rate", parse_tts_rate(self.settings.tts_rate))
            engine.save_to_file(text, str(temp_path))
            engine.runAndWait()
        finally:
            try:
                engine.stop()
            except Exception:
                pass

    def _synthesize_with_windows_tts(self, text: str, temp_path: Path) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Windows TTS fallback chi ho tro tren Windows.")

        escaped_text = text.replace("'", "''").replace("\r", " ").replace("\n", " ")
        escaped_path = str(temp_path).replace("'", "''")
        voice_hint = self.settings.tts_voice.replace("'", "''")
        rate = parse_tts_rate(self.settings.tts_rate)
        script = f"""
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voiceHint = '{voice_hint}'
if ($voiceHint) {{
  foreach ($voice in $synth.GetInstalledVoices()) {{
    $info = $voice.VoiceInfo
    if ($info.Name -like "*$voiceHint*" -or $info.Culture.Name -like "vi-*") {{
      $synth.SelectVoice($info.Name)
      break
    }}
  }}
}}
$synth.Rate = {convert_rate_to_sapi(rate)}
$synth.SetOutputToWaveFile('{escaped_path}')
$synth.Speak('{escaped_text}')
$synth.Dispose()
"""
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0 or not temp_path.exists() or temp_path.stat().st_size == 0:
            error_text = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(error_text or "Windows TTS fallback khong tao duoc audio.")

    def _transcribe_sync(self, content: bytes, filename: str, mode: SpeechMode = "order") -> str:
        model = self._get_stt_model()
        language = self.settings.voice_lang.split("-", 1)[0].lower()

        transcript = self._finalize_transcript(
            self._run_transcription_pass(
                model,
                content,
                filename,
                language,
                vad_filter=True,
                mode=mode,
            ),
            mode=mode,
        )
        if self._accept_transcript(transcript, mode=mode):
            return transcript

        transcript = self._finalize_transcript(
            self._run_transcription_pass(
                model,
                content,
                filename,
                language,
                vad_filter=False,
                mode=mode,
            ),
            mode=mode,
        )
        if self._accept_transcript(transcript, mode=mode):
            return transcript

        raise SpeechNotHeardError("Mình nghe chưa rõ, bạn nói lại giúp mình nhé.")

    def _transcribe_partial_sync(
        self,
        content: bytes,
        filename: str,
        mode: SpeechMode = "order",
    ) -> str:
        model = self._get_stt_model()
        language = self.settings.voice_lang.split("-", 1)[0].lower()
        try:
            transcript = self._finalize_transcript(
                self._run_transcription_pass(
                    model,
                    content,
                    filename,
                    language,
                    vad_filter=True,
                    decode_mode="partial",
                    mode=mode,
                ),
                mode=mode,
            )
        except Exception as exc:
            if self._is_partial_decode_error(exc):
                logger.debug(
                    "stt_partial_skip reason=incomplete_audio filename=%s bytes=%s error=%s",
                    filename,
                    len(content),
                    exc,
                )
                return ""
            raise
        normalized = normalize_vietnamese_text(transcript)
        if len(normalized) < 3:
            return ""
        return transcript

    def _is_partial_decode_error(self, exc: Exception) -> bool:
        name = exc.__class__.__name__.lower()
        message = str(exc).lower()
        if any(marker in name for marker in ("invaliddataerror", "ffmperror", "eoferror")):
            return True
        if any(
            marker in message
            for marker in (
                "invalid data found when processing input",
                "end of file",
                "could not find codec parameters",
                "moov atom not found",
                "error number -1094995529",
                "tuple index out of range",
            )
        ):
            return True
        if isinstance(exc, IndexError):
            stack_text = "".join(traceback.format_tb(exc.__traceback__)).lower()
            return (
                "faster_whisper\\audio.py" in stack_text
                or "av/container/streams.py" in stack_text
                or "av/container/input.py" in stack_text
            )
        return False

    def _run_transcription_pass(
        self,
        model: WhisperModel,
        content: bytes,
        filename: str,
        language: str,
        *,
        vad_filter: bool,
        decode_mode: str = "final",
        mode: SpeechMode = "order",
    ) -> str:
        partial_mode = decode_mode == "partial"
        if mode == "caption" and partial_mode:
            beam_size = 1
            best_of = 1
        else:
            beam_size = (
                self.settings.stt_partial_beam_size if partial_mode else self.settings.stt_beam_size
            )
            best_of = (
                self.settings.stt_partial_best_of if partial_mode else self.settings.stt_best_of
            )
        silence_ms = (
            max(220, self.settings.stt_vad_min_silence_ms - 160)
            if partial_mode
            else self.settings.stt_vad_min_silence_ms
        )

        audio_stream = io.BytesIO(content)
        audio_stream.name = filename
        segments, _ = model.transcribe(
            audio_stream,
            language=language,
            vad_filter=vad_filter,
            beam_size=beam_size,
            best_of=best_of,
            temperature=0,
            condition_on_previous_text=False,
            without_timestamps=True,
            compression_ratio_threshold=2.1,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.45,
            vad_parameters={"min_silence_duration_ms": silence_ms},
            initial_prompt=None if partial_mode or mode == "caption" else self._build_stt_prompt(),
            hotwords=None if mode == "caption" else self._build_stt_hotwords(),
        )
        return clean_spacing(" ".join(segment.text.strip() for segment in segments).strip())

    def _get_stt_model(self) -> WhisperModel:
        if self._stt_model is not None:
            return self._stt_model

        with self._stt_lock:
            if self._stt_model is None:
                last_error: Exception | None = None
                for device, compute_type in self._resolve_model_candidates():
                    try:
                        self._stt_model = WhisperModel(
                            self.settings.stt_model,
                            device=device,
                            compute_type=compute_type,
                            cpu_threads=self.settings.stt_cpu_threads,
                            num_workers=self.settings.stt_num_workers,
                        )
                        logger.info(
                            "Loaded faster-whisper model '%s' on %s (%s)",
                            self.settings.stt_model,
                            device,
                            compute_type,
                        )
                        break
                    except Exception as exc:
                        last_error = exc
                        logger.warning(
                            "STT init failed on %s (%s), trying fallback. Reason: %s",
                            device,
                            compute_type,
                            exc,
                        )

                if self._stt_model is None and last_error is not None:
                    raise last_error

        return self._stt_model

    def _resolve_model_candidates(self) -> list[tuple[str, str]]:
        configured_device = self.settings.stt_device.strip().lower() or "auto"
        configured_compute = self.settings.stt_compute_type.strip().lower() or "auto"

        if configured_device != "auto":
            primary_compute = (
                self._default_compute_for_device(configured_device)
                if configured_compute == "auto"
                else configured_compute
            )
            candidates = [(configured_device, primary_compute)]
            if configured_device != "cpu":
                candidates.append(("cpu", "int8"))
            return _dedupe_candidates(candidates)

        auto_candidates = [("cuda", "int8_float16"), ("cuda", "float16"), ("cpu", "int8")]
        if configured_compute != "auto":
            auto_candidates = [(device, configured_compute) for device, _ in auto_candidates]

        return _dedupe_candidates(auto_candidates)

    def _default_compute_for_device(self, device: str) -> str:
        if device == "cuda":
            return "int8_float16"
        if device == "cpu":
            return "int8"
        return "int8"

    def _build_stt_prompt(self) -> str:
        if self._stt_prompt_cache is not None:
            return self._stt_prompt_cache

        base_prompt = (
            "Đây là hội thoại gọi món bằng tiếng Việt trong quán cafe. "
            "Ưu tiên nhận đúng tên món, số lượng, vị ngọt, đá, nóng lạnh."
        )
        self._stt_prompt_cache = base_prompt
        return self._stt_prompt_cache

    def _build_stt_hotwords(self) -> str | None:
        if self._stt_hotwords_cache is not None:
            return self._stt_hotwords_cache

        hotword_values = list(COMMON_ORDERING_PHRASES.values())
        for item in self._menu_items_cache or []:
            hotword_values.append(item.name)
            hotword_values.append(item.category)
            hotword_values.extend(tag.replace("-", " ") for tag in item.tags)

        normalized_unique: list[str] = []
        seen: set[str] = set()
        for value in hotword_values:
            cleaned = clean_spacing(value)
            if not cleaned:
                continue
            key = normalize_vietnamese_text(cleaned)
            if key in seen:
                continue
            seen.add(key)
            normalized_unique.append(cleaned)

        self._stt_hotwords_cache = ", ".join(normalized_unique[:48]) or None
        return self._stt_hotwords_cache

    def _post_process_transcript(self, transcript: str) -> str:
        cleaned = clean_spacing(transcript)
        if not cleaned:
            return ""

        focused = strip_ordering_fillers(cleaned)
        lexicon = self._get_ordering_lexicon()

        best_match, best_score = best_lexicon_match(normalize_vietnamese_text(focused), lexicon)
        if best_match and best_score >= 0.8:
            return best_match

        best_match, best_score = best_lexicon_match(normalize_vietnamese_text(cleaned), lexicon)
        if best_match and best_score >= 0.9:
            return best_match

        return cleaned

    def _looks_actionable(self, transcript: str) -> bool:
        normalized = normalize_vietnamese_text(transcript)
        if not normalized:
            return False

        tokens = normalized.split()
        if any(char.isdigit() for char in normalized):
            return True

        if contains_keyword(normalized, ACTIONABLE_KEYWORDS):
            return True

        _, best_score = best_lexicon_match(normalized, self._get_ordering_lexicon())
        if best_score >= 0.74:
            return True

        if len(tokens) == 1 and len(tokens[0]) <= 3:
            return False

        return contains_keyword(normalized, ORDERING_INTENT_KEYWORDS)

    def is_actionable_transcript(self, transcript: str) -> bool:
        return self._looks_actionable(self._post_process_transcript(transcript))

    def _finalize_transcript(self, transcript: str, *, mode: SpeechMode) -> str:
        if mode == "caption":
            return clean_spacing(transcript)
        return self._post_process_transcript(transcript)

    def _accept_transcript(self, transcript: str, *, mode: SpeechMode) -> bool:
        normalized = normalize_vietnamese_text(transcript)
        if mode == "caption":
            return len(normalized) >= 1
        # User requested "always hear everything": do not enforce ordering-intent filters here.
        return len(normalized) >= 1

    def _get_ordering_lexicon(self) -> list[tuple[str, str]]:
        if self._lexicon_cache is not None:
            return self._lexicon_cache

        lexicon_map: dict[str, str] = {
            normalize_vietnamese_text(display): display for display in COMMON_ORDERING_PHRASES.values()
        }
        for item in self._menu_items_cache or []:
            lexicon_map[normalize_vietnamese_text(item.name)] = item.name
            lexicon_map[normalize_vietnamese_text(item.category)] = item.category
            for tag in item.tags:
                display_tag = tag.replace("-", " ")
                lexicon_map[normalize_vietnamese_text(display_tag)] = display_tag

        self._lexicon_cache = list(lexicon_map.items())
        return self._lexicon_cache


def normalize_speech_text(text: str) -> str:
    return (
        text.replace("AI", "ây ai")
        .replace("CSV", "xê ét vê")
        .replace("MySQL", "mai ét kiu eo")
        .replace("STT", "ét ti ti")
        .replace("TTS", "ti ti ét")
        .replace("...", ". ")
        .strip()
    )


def split_streaming_segments(text: str, max_chars: int = STREAM_SEGMENT_MAX_CHARS) -> list[str]:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return []

    segments: list[str] = []
    for sentence in STREAM_SENTENCE_SPLIT_PATTERN.split(compact):
        sentence = sentence.strip()
        if not sentence:
            continue

        if len(sentence) <= max_chars:
            segments.append(sentence)
            continue

        for clause in STREAM_CLAUSE_SPLIT_PATTERN.split(sentence):
            clause = clause.strip()
            if not clause:
                continue
            if len(clause) <= max_chars:
                segments.append(clause)
                continue

            words = clause.split(" ")
            current_words: list[str] = []
            current_length = 0
            for word in words:
                candidate_length = current_length + (1 if current_words else 0) + len(word)
                if candidate_length > max_chars and current_words:
                    segments.append(" ".join(current_words))
                    current_words = [word]
                    current_length = len(word)
                else:
                    current_words.append(word)
                    current_length = candidate_length
            if current_words:
                segments.append(" ".join(current_words))

    return segments or [compact]


def parse_tts_rate(raw_value: str) -> int:
    try:
        return int(raw_value)
    except ValueError:
        return 165


def coerce_optional_string(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def clamp_int(
    value: object | None,
    fallback: int,
    *,
    min_value: int,
    max_value: int,
) -> int:
    try:
        raw = int(value) if value is not None else int(fallback)
    except (TypeError, ValueError):
        raw = int(fallback)
    return max(min_value, min(max_value, raw))


def clamp_float(
    value: object | None,
    fallback: float,
    *,
    min_value: float,
    max_value: float,
) -> float:
    try:
        raw = float(value) if value is not None else float(fallback)
    except (TypeError, ValueError):
        raw = float(fallback)
    return max(min_value, min(max_value, raw))


def call_with_supported_kwargs(func: object, kwargs: dict[str, object]):
    if not callable(func):
        raise RuntimeError("VieNeu infer function is not callable.")

    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return func(**kwargs)  # type: ignore[misc]

    has_var_keyword = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
    if has_var_keyword:
        return func(**kwargs)  # type: ignore[misc]

    allowed_names = set(signature.parameters.keys())
    filtered_kwargs = {key: value for key, value in kwargs.items() if key in allowed_names}
    return func(**filtered_kwargs)  # type: ignore[misc]


def convert_rate_to_sapi(rate: int) -> int:
    normalized = max(80, min(260, rate))
    return max(-10, min(10, round((normalized - 165) / 8)))


def convert_rate_to_edge(rate: int) -> str:
    normalized = max(80, min(260, rate))
    percentage = round(((normalized / 165) - 1) * 100)
    percentage = max(-50, min(100, percentage))
    sign = "+" if percentage >= 0 else ""
    return f"{sign}{percentage}%"


def should_fallback_to_windows_tts(exc: Exception) -> bool:
    message = f"{type(exc).__name__}: {exc}".lower()
    fallback_markers = [
        "pywintypes",
        "com error",
        "sapi",
        "class not registered",
        "voice",
    ]
    return any(marker in message for marker in fallback_markers)


def pick_edge_voice(voice_lang: str, voice_hint: str) -> str:
    hint = voice_hint.lower().strip()
    # Allow passing a full Edge voice id directly, for example:
    # vi-VN-HoaiMyNeural, en-US-AvaMultilingualNeural, etc.
    if re.match(r"^[a-z]{2}-[a-z]{2}-[a-z0-9]+(?:neural)$", hint):
        return voice_hint

    if any(token in hint for token in ["hoaimy", "hoai", "female", "nu", "woman"]):
        return "vi-VN-HoaiMyNeural"
    if any(token in hint for token in ["nam", "male", "man"]):
        return "vi-VN-NamMinhNeural"

    if voice_lang.lower().startswith("vi"):
        return "vi-VN-HoaiMyNeural"

    return "en-US-JennyNeural"


def pick_local_voice(engine: pyttsx3.Engine, voice_lang: str, voice_hint: str):
    normalized_lang = voice_lang.lower()
    normalized_hint = voice_hint.lower()
    voices = engine.getProperty("voices")
    scored_voices = sorted(
        voices,
        key=lambda voice: score_local_voice(voice, normalized_lang, normalized_hint),
        reverse=True,
    )
    top_voice = scored_voices[0] if scored_voices else None
    if top_voice is None:
        return None

    if score_local_voice(top_voice, normalized_lang, normalized_hint) <= 0:
        return None

    return top_voice


def score_local_voice(voice, voice_lang: str, voice_hint: str) -> int:
    score = 0
    voice_id = getattr(voice, "id", "").lower()
    voice_name = getattr(voice, "name", "").lower()
    languages = []
    for item in getattr(voice, "languages", []):
        if isinstance(item, bytes):
            try:
                languages.append(item.decode("utf-8", errors="ignore").lower())
            except Exception:
                continue
        else:
            languages.append(str(item).lower())

    haystack = " ".join([voice_id, voice_name, *languages])

    if voice_lang.startswith("vi") and ("vi" in haystack or "vietnam" in haystack):
        score += 80
    if voice_hint and voice_hint in haystack:
        score += 40
    if any(name in haystack for name in ["linh", "mai", "hoa", "chi", "female", "zira", "susan"]):
        score += 12
    if "male" in haystack:
        score -= 6

    return score


def clean_spacing(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" .,!?")


def normalize_vietnamese_text(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text.casefold())
    stripped = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    stripped = re.sub(r"[^a-z0-9\s]", " ", stripped)
    return re.sub(r"\s+", " ", stripped).strip()


def strip_ordering_fillers(text: str) -> str:
    normalized = normalize_vietnamese_text(text)
    changed = normalized
    for filler in ORDERING_FILLERS:
        changed = re.sub(rf"^(?:{re.escape(filler)})\s+", "", changed)
    return changed.strip() or normalized


def best_lexicon_match(
    normalized_text: str,
    lexicon: list[tuple[str, str]],
) -> tuple[str | None, float]:
    if not normalized_text:
        return None, 0.0

    if normalized_text in COMMON_ORDERING_PHRASES:
        return COMMON_ORDERING_PHRASES[normalized_text], 1.0

    best_display: str | None = None
    best_score = 0.0
    for normalized_candidate, display in lexicon:
        score = SequenceMatcher(None, normalized_text, normalized_candidate).ratio()
        if score > best_score:
            best_display = display
            best_score = score
    return best_display, best_score


def contains_keyword(text: str, keywords: set[str]) -> bool:
    return any(keyword in text for keyword in keywords)


def _dedupe_candidates(candidates: list[tuple[str, str]]) -> list[tuple[str, str]]:
    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        deduped.append(candidate)
    return deduped
