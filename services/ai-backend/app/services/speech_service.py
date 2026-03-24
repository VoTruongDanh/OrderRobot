from __future__ import annotations

import asyncio
import io
import os
import re
import subprocess
import sys
import tempfile
import threading
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import edge_tts
import pyttsx3
from fastapi import UploadFile
from faster_whisper import WhisperModel

from app.config import Settings
from app.services.core_backend_client import CoreBackendClient


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
        self._stt_prompt_cache: str | None = None
        self._stt_hotwords_cache: str | None = None
        self._lexicon_cache: list[tuple[str, str]] | None = None

    async def synthesize(self, text: str) -> SynthesizedAudio:
        return await self._synthesize_async(text)

    async def transcribe(self, file: UploadFile) -> str:
        content = await file.read()
        if not content:
            raise ValueError("Audio upload trong.")

        filename = file.filename or "speech.webm"
        return await asyncio.to_thread(self._transcribe_sync, content, filename)

    async def transcribe_partial(self, content: bytes, filename: str = "speech.webm") -> str:
        if not content:
            return ""

        return await asyncio.to_thread(self._transcribe_partial_sync, content, filename)

    async def transcribe_bytes(self, content: bytes, filename: str = "speech.webm") -> str:
        if not content:
            raise ValueError("Audio upload trong.")

        return await asyncio.to_thread(self._transcribe_sync, content, filename)

    async def preload_stt(self) -> None:
        await asyncio.to_thread(self._preload_stt_assets)

    def _preload_stt_assets(self) -> None:
        self._get_stt_model()
        self._build_stt_prompt()
        self._build_stt_hotwords()
        self._get_ordering_lexicon()

    async def _synthesize_async(self, text: str) -> SynthesizedAudio:
        normalized_text = normalize_speech_text(text)
        try:
            return await self._synthesize_with_edge_tts(normalized_text)
        except Exception:
            return await asyncio.to_thread(self._synthesize_sync, normalized_text)

    async def _synthesize_with_edge_tts(self, text: str) -> SynthesizedAudio:
        communicate = edge_tts.Communicate(
            text=text,
            voice=pick_edge_voice(self.settings.voice_lang, self.settings.tts_voice),
            rate=convert_rate_to_edge(parse_tts_rate(self.settings.tts_rate)),
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

    def _transcribe_sync(self, content: bytes, filename: str) -> str:
        model = self._get_stt_model()
        language = self.settings.voice_lang.split("-", 1)[0].lower()

        transcript = self._post_process_transcript(
            self._run_transcription_pass(model, content, filename, language, vad_filter=True),
        )
        if self._looks_actionable(transcript):
            return transcript

        transcript = self._post_process_transcript(
            self._run_transcription_pass(model, content, filename, language, vad_filter=False),
        )
        if self._looks_actionable(transcript):
            return transcript

        raise SpeechNotHeardError("Mình nghe chưa rõ, bạn nói lại giúp mình nhé.")

    def _transcribe_partial_sync(self, content: bytes, filename: str) -> str:
        model = self._get_stt_model()
        language = self.settings.voice_lang.split("-", 1)[0].lower()
        transcript = self._post_process_transcript(
            self._run_transcription_pass(model, content, filename, language, vad_filter=True),
        )
        if self._looks_actionable(transcript):
            return transcript
        return ""

    def _run_transcription_pass(
        self,
        model: WhisperModel,
        content: bytes,
        filename: str,
        language: str,
        *,
        vad_filter: bool,
    ) -> str:
        audio_stream = io.BytesIO(content)
        audio_stream.name = filename
        segments, _ = model.transcribe(
            audio_stream,
            language=language,
            vad_filter=vad_filter,
            beam_size=self.settings.stt_beam_size,
            best_of=self.settings.stt_best_of,
            temperature=0,
            condition_on_previous_text=False,
            without_timestamps=True,
            compression_ratio_threshold=2.1,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.45,
            vad_parameters={"min_silence_duration_ms": self.settings.stt_vad_min_silence_ms},
            initial_prompt=self._build_stt_prompt(),
            hotwords=self._build_stt_hotwords(),
        )
        return clean_spacing(" ".join(segment.text.strip() for segment in segments).strip())

    def _get_stt_model(self) -> WhisperModel:
        if self._stt_model is not None:
            return self._stt_model

        with self._stt_lock:
            if self._stt_model is None:
                self._stt_model = WhisperModel(
                    self.settings.stt_model,
                    device=self.settings.stt_device,
                    compute_type=self.settings.stt_compute_type,
                    cpu_threads=self.settings.stt_cpu_threads,
                    num_workers=self.settings.stt_num_workers,
                )

        return self._stt_model

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
        if self.core_client is not None:
            try:
                for item in self.core_client.list_menu():
                    hotword_values.append(item.name)
                    hotword_values.append(item.category)
                    hotword_values.extend(tag.replace("-", " ") for tag in item.tags)
            except Exception:
                pass

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

        return len(normalized) >= 6

    def _get_ordering_lexicon(self) -> list[tuple[str, str]]:
        if self._lexicon_cache is not None:
            return self._lexicon_cache

        lexicon_map: dict[str, str] = {
            normalize_vietnamese_text(display): display for display in COMMON_ORDERING_PHRASES.values()
        }
        if self.core_client is not None:
            try:
                for item in self.core_client.list_menu():
                    lexicon_map[normalize_vietnamese_text(item.name)] = item.name
                    lexicon_map[normalize_vietnamese_text(item.category)] = item.category
                    for tag in item.tags:
                        display_tag = tag.replace("-", " ")
                        lexicon_map[normalize_vietnamese_text(display_tag)] = display_tag
            except Exception:
                pass

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


def parse_tts_rate(raw_value: str) -> int:
    try:
        return int(raw_value)
    except ValueError:
        return 165


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
    if hint.startswith("vi-vn-"):
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
