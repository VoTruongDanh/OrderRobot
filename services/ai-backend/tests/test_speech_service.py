from __future__ import annotations

import pytest

from app.config import Settings
from app.models import MenuItem
from app.services.speech_service import (
    SpeechNotHeardError,
    SpeechService,
    best_lexicon_match,
    normalize_vietnamese_text,
    pick_edge_voice,
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

    def fake_run_transcription_pass(_model, _content, _filename, _language, *, vad_filter: bool) -> str:
        attempts.append(vad_filter)
        return "" if vad_filter else "cho mình 1 trà đào"

    monkeypatch.setattr(service, "_run_transcription_pass", fake_run_transcription_pass)

    transcript = service._transcribe_sync(b"fake-audio", "sample.webm")

    assert transcript == "cho mình 1 trà đào"
    assert attempts == [True, False]


def test_transcribe_raises_soft_retry_error_when_both_passes_are_empty(monkeypatch) -> None:
    service = SpeechService(build_settings())

    monkeypatch.setattr(service, "_get_stt_model", lambda: object())
    monkeypatch.setattr(service, "_run_transcription_pass", lambda *_args, **_kwargs: "")

    try:
        service._transcribe_sync(b"fake-audio", "sample.webm")
    except SpeechNotHeardError as exc:
        assert "nói lại" in str(exc)
    else:
        raise AssertionError("Expected SpeechNotHeardError when transcript stays empty.")


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
    assert ("it ngot" in dict(service._get_ordering_lexicon())) is True


def test_is_actionable_transcript_reuses_post_processing() -> None:
    service = SpeechService(build_settings())

    assert service.is_actionable_transcript("cafe mui") is True


def test_best_lexicon_match_handles_vietnamese_normalization() -> None:
    display, score = best_lexicon_match(
        normalize_vietnamese_text("cafe mui"),
        [(normalize_vietnamese_text("Cà phê muối"), "Cà phê muối")],
    )

    assert display == "Cà phê muối"
    assert score >= 0.8
