from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.config import Settings, get_settings
from app.models import CreateOrderResponse, MenuItem, TTSConfigRequest
from app.services.conversation_engine import ConversationEngine, render_fallback_reply


class FakeCoreBackendClient:
    def __init__(self) -> None:
        self.created_orders: list[tuple[str, list[dict[str, int]]]] = []

    async def list_menu(self) -> list[MenuItem]:
        return [
            MenuItem(
                item_id="tra-dao",
                name="Tra dao cam sa",
                category="Tra trai cay",
                description="Thanh mat de uong",
                price=Decimal("48000"),
                available=True,
                tags=["de-uong", "it-ngot"],
            ),
            MenuItem(
                item_id="matcha",
                name="Matcha latte",
                category="Latte",
                description="Mem va thơm",
                price=Decimal("55000"),
                available=True,
                tags=["matcha", "it-ngot"],
            ),
        ]

    async def create_order(self, payload):
        self.created_orders.append(
            (
                payload.session_id,
                [item.model_dump() for item in payload.items],
            )
        )
        return CreateOrderResponse(order_id="ORD-TEST")


class FakeSpeechService:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def synthesize_stream(self, text: str):
        self.calls.append(text)
        yield b"audio-chunk"


def test_get_settings_migrates_legacy_bridge_url_in_bridge_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODE", "bridge_only")
    monkeypatch.setenv("BRIDGE_BASE_URL", "http://127.0.0.1:1111")
    settings = get_settings()
    assert settings.bridge_base_url == "http://127.0.0.1:1122"


def test_get_settings_keeps_custom_bridge_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODE", "bridge_only")
    monkeypatch.setenv("BRIDGE_BASE_URL", "http://10.0.0.8:9000")
    settings = get_settings()
    assert settings.bridge_base_url == "http://10.0.0.8:9000"


def test_tts_config_request_accepts_legacy_and_new_payload_keys() -> None:
    legacy_payload = TTSConfigRequest.model_validate({"tts_voice": "vi-VN-HoaiMyNeural", "tts_rate": 165})
    assert legacy_payload.voice == "vi-VN-HoaiMyNeural"
    assert legacy_payload.rate == 165

    new_payload = TTSConfigRequest.model_validate({"voice": "vi-VN-NamMinhNeural", "rate": 180})
    assert new_payload.voice == "vi-VN-NamMinhNeural"
    assert new_payload.rate == 180


@pytest.mark.anyio
async def test_conversation_engine_can_recommend_and_create_order() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    assert start.reply_text

    recommend = await engine.handle_turn(start.session_id, "Mon nao de uong va it ngot vay?")
    assert recommend.recommended_item_ids

    added = await engine.handle_turn(start.session_id, "Cho minh 2 tra dao cam sa")
    assert added.cart[0].quantity == 2

    confirm_prompt = await engine.handle_turn(start.session_id, "xac nhan")
    assert confirm_prompt.needs_confirmation is True

    created = await engine.handle_turn(start.session_id, "xac nhan")
    assert created.order_created is True
    assert created.order_id == "ORD-TEST"


@pytest.mark.anyio
async def test_conversation_engine_can_add_multiple_items_in_one_turn() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
        session_timeout_minutes=15,
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    added = await engine.handle_turn(start.session_id, "Cho minh 1 tra dao cam sa va 1 matcha latte")

    assert len(added.cart) == 2
    assert {item.item_id for item in added.cart} == {"tra-dao", "matcha"}


@pytest.mark.anyio
async def test_conversation_engine_checkout_keywords_support_voice_only_flow() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
        session_timeout_minutes=15,
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    added = await engine.handle_turn(start.session_id, "cho minh 1 tra dao cam sa")
    assert len(added.cart) == 1

    ask_confirmation = await engine.handle_turn(start.session_id, "dat luon")
    assert ask_confirmation.needs_confirmation is True

    created = await engine.handle_turn(start.session_id, "xac nhan")
    assert created.order_created is True
    assert created.order_id == "ORD-TEST"


@pytest.mark.anyio
async def test_simple_scenes_skip_llm_call() -> None:
    """Simple scenes (greeting, cart_updated, reset, etc.) must NOT call LLM."""
    settings = Settings(
        ai_base_url="http://fake-llm:1111/v1",
        ai_api_key="fake-key",
        ai_model="gpt-4o-mini",
        core_backend_url="http://127.0.0.1:8001",
        bridge_base_url="http://127.0.0.1:1111",
        llm_mode="bridge_only",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)
    assert engine.provider_client is not None

    # Override provider_client with a mock that tracks calls
    call_count = 0
    async def tracked_compose(_payload):
        nonlocal call_count
        call_count += 1
        return {"reply_text": "mock bridge reply", "voice_style": "cute_friendly"}

    engine.provider_client.compose_reply = tracked_compose

    # Simple scene: greeting
    start = await engine.start_session()
    assert start.reply_text  # Should have a greeting
    assert call_count == 0, "Greeting should NOT call LLM"

    # Simple scene: cart_updated (add item)
    added = await engine.handle_turn(start.session_id, "cho minh 1 tra dao cam sa")
    assert len(added.cart) == 1
    assert call_count == 0, "Adding item should NOT call LLM"

    # Simple scene: reset
    reset = await engine.reset_session(start.session_id)
    assert reset.reply_text
    assert call_count == 0, "Reset should NOT call LLM"


@pytest.mark.anyio
async def test_menu_cache_avoids_repeated_calls() -> None:
    """Menu should be cached, not fetched on every turn."""
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    list_menu_call_count = 0
    original_list_menu = core_client.list_menu

    async def tracked_list_menu():
        nonlocal list_menu_call_count
        list_menu_call_count += 1
        return await original_list_menu()

    core_client.list_menu = tracked_list_menu
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()

    # Multiple turns should reuse cached menu
    await engine.handle_turn(start.session_id, "cho minh 1 tra dao cam sa")
    await engine.handle_turn(start.session_id, "them 1 matcha latte")
    await engine.handle_turn(start.session_id, "xong")

    # Should have called list_menu only once (cache serves subsequent calls)
    assert list_menu_call_count == 1, (
        f"Expected 1 menu fetch (cached), got {list_menu_call_count}"
    )


@pytest.mark.anyio
async def test_save_feedback_writes_to_backend_data_dir() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    log_path = Path(__file__).resolve().parents[1] / "data" / "feedback.jsonl"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else None

    try:
        await engine.save_feedback("SES-TEST", 5, "tot", ["user: xin chao", "assistant: chao ban"])

        assert log_path.exists()
        payload = json.loads(log_path.read_text(encoding="utf-8").splitlines()[-1])
        assert payload["session_id"] == "SES-TEST"
        assert payload["rating"] == 5
        assert payload["transcript_history"] == ["user: xin chao", "assistant: chao ban"]
        assert payload["needs_improvement"] is False
        assert payload["improvement_tags"] == []
        assert payload["review_status"] == "new"
        assert payload["analysis_version"] == 1
    finally:
        if existing is None:
            if log_path.exists():
                log_path.unlink()
        else:
            log_path.write_text(existing, encoding="utf-8")


@pytest.mark.anyio
async def test_save_feedback_auto_tags_intent_mismatch_transcript() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    log_path = Path(__file__).resolve().parents[1] / "data" / "feedback.jsonl"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else None

    transcript_history = [
        "user: bo bo 14 tra dao cam sa",
        "assistant: em da them 14 tra dao cam sa vao gio hang",
        "user: bo 14 tra dao cam sa",
        "assistant: em da bo 14 tra dao cam sa khoi gio hang",
        "user: bo 14 tra dao cam sa",
        "assistant: em da them 14 tra dao cam sa vao gio hang",
    ]

    try:
        await engine.save_feedback("SES-FEED-5", 3, "", transcript_history)

        payload = json.loads(log_path.read_text(encoding="utf-8").splitlines()[-1])
        assert payload["session_id"] == "SES-FEED-5"
        assert payload["needs_improvement"] is True
        assert "low_rating" in payload["improvement_tags"]
        assert "intent_action_mismatch" in payload["improvement_tags"]
        assert "repeated_remove_command" in payload["improvement_tags"]
    finally:
        if existing is None:
            if log_path.exists():
                log_path.unlink()
        else:
            log_path.write_text(existing, encoding="utf-8")


@pytest.mark.anyio
async def test_save_feedback_auto_tags_conversation_loop_for_short_ack_flow() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    log_path = Path(__file__).resolve().parents[1] / "data" / "feedback.jsonl"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else None

    transcript_history = [
        "user: co",
        "assistant: ban muon thu socola da xay hay muon minh goi y them?",
        "user: co",
        "assistant: ban muon goi mon gi hom nay? minh co ca phe va tra sua.",
    ]

    try:
        await engine.save_feedback("SES-FEED-6", 4, "", transcript_history)

        payload = json.loads(log_path.read_text(encoding="utf-8").splitlines()[-1])
        assert payload["session_id"] == "SES-FEED-6"
        assert payload["needs_improvement"] is True
        assert "conversation_loop" in payload["improvement_tags"]
    finally:
        if existing is None:
            if log_path.exists():
                log_path.unlink()
        else:
            log_path.write_text(existing, encoding="utf-8")


@pytest.mark.anyio
async def test_handle_turn_stream_uses_injected_speech_service() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    speech_service = FakeSpeechService()
    engine = ConversationEngine(settings, core_client, speech_service)

    start = await engine.start_session()
    chunks = [chunk async for chunk in engine.handle_turn_stream(start.session_id, "cho minh 1 tra dao cam sa")]

    assert any(chunk["type"] == "text" for chunk in chunks)
    assert any(chunk["type"] == "audio" for chunk in chunks)
    assert speech_service.calls


@pytest.mark.anyio
async def test_quantity_word_before_item_is_extracted_correctly() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    added = await engine.handle_turn(start.session_id, "them hai tra dao cam sa")

    assert len(added.cart) == 1
    assert added.cart[0].quantity == 2


@pytest.mark.anyio
async def test_unrelated_number_before_item_does_not_become_quantity() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    added = await engine.handle_turn(start.session_id, "phim 300 matcha latte")

    assert len(added.cart) == 1
    assert added.cart[0].quantity == 1


@pytest.mark.anyio
async def test_remove_phrase_can_decrement_quantity_instead_of_deleting_all() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        voice_lang="vi-VN",
        voice_style="cute_friendly",
        tts_voice="vietnam",
        tts_rate="165",
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
    )
    core_client = FakeCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    await engine.handle_turn(start.session_id, "them hai tra dao cam sa")
    removed = await engine.handle_turn(start.session_id, "bo mot tra dao cam sa")

    assert len(removed.cart) == 1
    assert removed.cart[0].quantity == 1


def test_fallback_reply_soft_redirects_singing_request() -> None:
    reply = render_fallback_reply(
        {
            "scene": "fallback",
            "seed": "",
            "user_text": "hat cho toi mot bai di",
        }
    )

    assert "món" in reply or "uống" in reply
    assert "chỉ phục vụ" not in reply


def test_greeting_reply_can_softly_handle_heart_to_heart_chat() -> None:
    reply = render_fallback_reply(
        {
            "scene": "greeting",
            "seed": "",
            "user_text": "hom nay toi hoi buon, cho toi tam su xiu",
        }
    )

    assert any(keyword in reply for keyword in ("tâm trạng", "nói chuyện", "gợi ý món", "hợp gu"))
