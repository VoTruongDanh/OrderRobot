from __future__ import annotations

import numpy as np
import pytest

import app.services.speech_service as speech_service_module
from app.config import Settings
from app.models import MenuItem
from app.services.speech_service import (
    SpeechNotHeardError,
    SpeechService,
    SynthesizedAudio,
    best_lexicon_match,
    normalize_vietnamese_text,
    pick_edge_voice,
    split_streaming_segments,
    should_fallback_to_windows_tts,
)


def build_settings() -> Settings:
    return Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vi-VN-HoaiMyNeural",
        tts_rate="165",
        stt_model="medium",
        stt_device="cpu",
        stt_compute_type="int8",
        stt_beam_size=8,
        stt_best_of=5,
        stt_vad_min_silence_ms=450,
        stt_preload=True,
        stt_cpu_threads=8,
        stt_num_workers=1,
    )


def test_transcribe_retries_without_vad_when_first_pass_is_empty(tmp_path, monkeypatch) -> None:
    service = SpeechService(build_settings())
    audio_path = tmp_path / "sample.webm"
    audio_path.write_bytes(b"fake-audio")

    attempts: list[bool] = []

    monkeypatch.setattr(service, "_get_stt_model", lambda: object())

    def fake_run_transcription_pass(
        _model,
        _content,
        _filename,
        _language,
        *,
        vad_filter: bool,
        mode: str = "order",
    ) -> str:
        attempts.append(vad_filter)
        return "" if vad_filter else "cho minh 1 tra dao"

    monkeypatch.setattr(service, "_run_transcription_pass", fake_run_transcription_pass)

    transcript = service._transcribe_sync(b"fake-audio", "sample.webm")

    assert transcript == "cho minh 1 tra dao"
    assert attempts == [True, False]


def test_transcribe_raises_soft_retry_error_when_both_passes_are_empty(monkeypatch) -> None:
    service = SpeechService(build_settings())

    monkeypatch.setattr(service, "_get_stt_model", lambda: object())
    monkeypatch.setattr(service, "_run_transcription_pass", lambda *_args, **_kwargs: "")

    with pytest.raises(SpeechNotHeardError):
        service._transcribe_sync(b"fake-audio", "sample.webm")


def test_partial_decode_error_handles_pyav_tuple_index_error(monkeypatch) -> None:
    service = SpeechService(build_settings())

    def raise_index_error() -> None:
        raise IndexError("tuple index out of range")

    try:
        raise_index_error()
    except Exception as exc:
        monkeypatch.setattr(
            speech_service_module.traceback,
            "format_tb",
            lambda _tb: ["  File \"av/container/streams.py\", line 146, in process\n"],
        )
        assert service._is_partial_decode_error(exc) is True


def test_partial_decode_error_keeps_non_decode_index_error_visible(monkeypatch) -> None:
    service = SpeechService(build_settings())

    def raise_index_error() -> None:
        raise IndexError("list index out of range")

    try:
        raise_index_error()
    except Exception as exc:
        monkeypatch.setattr(
            speech_service_module.traceback,
            "format_tb",
            lambda _tb: ["  File \"app/services/logic.py\", line 10, in helper\n"],
        )
        assert service._is_partial_decode_error(exc) is False


def test_run_transcription_pass_uses_stream_and_disables_timestamps() -> None:
    service = SpeechService(build_settings())

    class FakeSegment:
        def __init__(self, text: str) -> None:
            self.text = text

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            assert audio.read() == b"fake-audio"
            assert getattr(audio, "name", "") == "sample.webm"
            assert kwargs["without_timestamps"] is True
            assert "Matcha latte" in kwargs["hotwords"]
            return [FakeSegment("cho minh 1 matcha")], None

    transcript = service._run_transcription_pass(
        FakeModel(),
        b"fake-audio",
        "sample.webm",
        "vi",
        vad_filter=True,
    )

    assert transcript == "cho minh 1 matcha"


def test_run_transcription_pass_skips_ordering_bias_for_caption_mode() -> None:
    service = SpeechService(build_settings())

    class FakeSegment:
        def __init__(self, text: str) -> None:
            self.text = text

    captured_kwargs: dict[str, object] = {}

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            captured_kwargs.update(kwargs)
            assert audio.read() == b"fake-audio"
            return [FakeSegment("alo mot hai cap dan")], None

    transcript = service._run_transcription_pass(
        FakeModel(),
        b"fake-audio",
        "sample.webm",
        "vi",
        vad_filter=True,
        decode_mode="partial",
        mode="caption",
    )

    assert transcript == "alo mot hai cap dan"
    assert captured_kwargs["hotwords"] is None
    assert captured_kwargs["initial_prompt"] is None
    assert captured_kwargs["beam_size"] == 1
    assert captured_kwargs["best_of"] == 1


def test_preload_stt_assets_builds_prompt_hotwords_and_lexicon(monkeypatch) -> None:
    service = SpeechService(build_settings())
    calls: list[str] = []

    monkeypatch.setattr(service, "_get_stt_model", lambda: calls.append("model"))
    monkeypatch.setattr(service, "_build_stt_prompt", lambda: calls.append("prompt"))
    monkeypatch.setattr(service, "_build_stt_hotwords", lambda: calls.append("hotwords"))
    monkeypatch.setattr(service, "_get_ordering_lexicon", lambda: calls.append("lexicon"))

    service._preload_stt_assets()

    assert calls == ["model", "prompt", "hotwords", "lexicon"]


def test_synthesize_falls_back_to_windows_tts_when_pyttsx3_driver_is_missing(monkeypatch) -> None:
    service = SpeechService(build_settings())
    fallback_called = {"value": False}

    def fake_primary(_text, _temp_path) -> None:
        raise ModuleNotFoundError("No module named 'pywintypes'")

    def fake_fallback(_text, temp_path) -> None:
        fallback_called["value"] = True
        temp_path.write_bytes(b"RIFFfakewave")

    monkeypatch.setattr(service, "_synthesize_with_pyttsx3", fake_primary)
    monkeypatch.setattr(service, "_synthesize_with_windows_tts", fake_fallback)

    audio = service._synthesize_sync("xin chao")

    assert fallback_called["value"] is True
    assert audio.content == b"RIFFfakewave"
    assert audio.media_type == "audio/wav"


def test_should_fallback_to_windows_tts_detects_pywintypes_errors() -> None:
    assert should_fallback_to_windows_tts(ModuleNotFoundError("No module named 'pywintypes'")) is True
    assert should_fallback_to_windows_tts(RuntimeError("some other failure")) is False


def test_pick_edge_voice_prefers_vietnamese_neural_voice() -> None:
    assert pick_edge_voice("vi-VN", "vi-VN-HoaiMyNeural") == "vi-VN-HoaiMyNeural"
    assert pick_edge_voice("vi-VN", "female") == "vi-VN-HoaiMyNeural"
    assert pick_edge_voice("vi-VN", "male") == "vi-VN-NamMinhNeural"


def test_split_streaming_segments_breaks_long_sentence() -> None:
    segments = split_streaming_segments(
        "xin chao ban, minh co the goi y nhieu mon ngon cho ban hom nay neu ban muon thu ngay",
        max_chars=24,
    )
    assert segments
    assert all(len(segment) <= 24 for segment in segments)


def test_should_use_vieneu_honors_engine_override() -> None:
    service = SpeechService(build_settings())
    service.settings.tts_engine = "vieneu"
    service._vieneu_import_checked = True
    service._vieneu_import_ok = True

    assert service._should_use_vieneu({"engine": "edge"}) is False
    assert service._should_use_vieneu({"engine": "vieneu"}) is True


def test_vieneu_stream_emits_single_wav_header_then_pcm(monkeypatch) -> None:
    service = SpeechService(build_settings())

    class FakeVieneuEngine:
        sample_rate = 24000

        def infer_stream(self, text: str):
            assert text == "xin chao"
            yield np.array([0.0, 0.2, -0.2, 0.0], dtype=np.float32)
            yield np.array([0.1, 0.0], dtype=np.float32)

    monkeypatch.setattr(service, "_get_vieneu_instance", lambda: FakeVieneuEngine())
    monkeypatch.setattr(
        service,
        "_build_vieneu_infer_kwargs",
        lambda _engine, text, vieneu_overrides=None: {"text": text},
    )

    chunks = list(service._synthesize_with_vieneu_stream_sync("xin chao"))
    assert len(chunks) >= 3
    assert chunks[0][:4] == b"RIFF"
    assert chunks[1][:4] != b"RIFF"
    assert chunks[2][:4] != b"RIFF"
    assert len(chunks[1]) == 8
    assert len(chunks[2]) == 4


def test_configure_vieneu_streaming_applies_runtime_settings() -> None:
    service = SpeechService(build_settings())

    class FakeVieneuEngine:
        hop_length = 320
        streaming_frames_per_chunk = 25
        streaming_lookforward = 10
        streaming_lookback = 100
        streaming_overlap_frames = 1
        streaming_stride_samples = 8000

    engine = FakeVieneuEngine()
    service.settings.tts_vieneu_stream_frames_per_chunk = 20
    service.settings.tts_vieneu_stream_lookforward = 5
    service.settings.tts_vieneu_stream_lookback = 40
    service.settings.tts_vieneu_stream_overlap_frames = 2

    service._configure_vieneu_streaming(engine)

    assert engine.streaming_frames_per_chunk == 20
    assert engine.streaming_lookforward == 5
    assert engine.streaming_lookback == 40
    assert engine.streaming_overlap_frames == 2
    assert engine.streaming_stride_samples == 6400


def test_build_vieneu_infer_kwargs_prefers_ref_audio_over_preset_voice() -> None:
    service = SpeechService(build_settings())
    service.settings.tts_vieneu_voice_id = "Tuyen"

    class FakeEngine:
        def get_preset_voice(self, voice_id: str):
            return {"id": voice_id}

    kwargs = service._build_vieneu_infer_kwargs(
        FakeEngine(),
        "xin chao",
        vieneu_overrides={
            "vieneu_ref_audio": "C:/sample.wav",
            "vieneu_ref_text": "mau clone",
        },
    )

    assert kwargs["text"] == "xin chao"
    assert kwargs["ref_audio"] == "C:/sample.wav"
    assert kwargs["ref_text"] == "mau clone"
    assert "voice" not in kwargs


def test_transcript_post_processing_recovers_menu_like_phrase() -> None:
    service = SpeechService(build_settings())

    transcript = service._post_process_transcript("cafe mui")

    assert transcript == "Cà phê muối"


def test_low_information_short_noise_is_not_actionable() -> None:
    service = SpeechService(build_settings())

    assert service._looks_actionable("Bui") is False
    assert service._looks_actionable("Matcha") is True


@pytest.mark.anyio
async def test_preload_stt_fetches_menu_items_once_for_sync_caches() -> None:
    class FakeCoreClient:
        def __init__(self) -> None:
            self.calls = 0

        async def list_menu(self) -> list[MenuItem]:
            self.calls += 1
            return [
                MenuItem(
                    item_id="matcha",
                    name="Matcha latte",
                    category="Latte",
                    description="",
                    price=0,
                    available=True,
                    tags=["it-ngot"],
                )
            ]

    core_client = FakeCoreClient()
    service = SpeechService(build_settings(), core_client)

    await service.preload_stt()

    assert core_client.calls == 1
    assert "Latte" in (service._build_stt_hotwords() or "")
    assert "it ngot" in dict(service._get_ordering_lexicon())


def test_is_actionable_transcript_reuses_post_processing() -> None:
    service = SpeechService(build_settings())

    assert service.is_actionable_transcript("cafe mui") is True


def test_caption_mode_keeps_generic_text_without_menu_post_processing() -> None:
    service = SpeechService(build_settings())

    assert service._finalize_transcript("cafe mui", mode="caption") == "cafe mui"
    assert service._accept_transcript("alo", mode="caption") is True


def test_best_lexicon_match_handles_vietnamese_normalization() -> None:
    display, score = best_lexicon_match(
        normalize_vietnamese_text("cafe mui"),
        [(normalize_vietnamese_text("Cà phê muối"), "Cà phê muối")],
    )

    assert display == "Cà phê muối"
    assert score >= 0.8


@pytest.mark.anyio
async def test_synthesize_prefers_vieneu_when_engine_forced(monkeypatch) -> None:
    settings = build_settings()
    settings.tts_engine = "vieneu"
    service = SpeechService(settings)

    monkeypatch.setattr(
        service,
        "_synthesize_with_vieneu_sync",
        lambda _text: SynthesizedAudio(content=b"RIFFvieneu", media_type="audio/wav"),
    )

    async def fake_edge(*_args, **_kwargs):
        raise AssertionError("Edge TTS should not run when VieNeu succeeds")

    monkeypatch.setattr(service, "_synthesize_with_edge_tts", fake_edge)

    audio = await service.synthesize("xin chao")

    assert audio.content == b"RIFFvieneu"
    assert audio.media_type == "audio/wav"
