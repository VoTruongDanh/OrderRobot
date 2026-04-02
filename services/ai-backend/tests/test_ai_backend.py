from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.config import Settings, get_settings
from app.models import (
    CreateOrderResponse,
    MenuItem,
    MenuItemSizeOption,
    TTSConfigRequest,
    TurnRequest,
)
from app.services.conversation_engine import (
    ConversationEngine,
    ensure_frontend_safe_reply,
    normalize_text,
    render_fallback_reply,
)
from app.services.provider_client import append_stream_content, split_completed_sentences


class FakeCoreBackendClient:
    def __init__(self) -> None:
        self.created_orders: list[tuple[str, list[dict[str, object]]]] = []

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
                description="Mem va thÆ¡m",
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

    async def get_item_sizes(self, item_id: str) -> list[MenuItemSizeOption]:
        return []


class FakeSpeechService:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def synthesize_stream(self, text: str):
        self.calls.append(text)
        yield b"audio-chunk"


class FakeProviderClient:
    def __init__(self) -> None:
        self.compose_calls = 0
        self.stream_calls = 0

    async def compose_reply(self, _payload, **_kwargs):
        self.compose_calls += 1
        return {"reply_text": "Tra dao cam sa la mon de uong.", "voice_style": "cute_friendly"}

    async def compose_reply_stream(self, _payload, **_kwargs):
        self.stream_calls += 1
        for part in ["Tra dao cam sa", " la mon de uong."]:
            yield part


class FailingMenuCoreBackendClient(FakeCoreBackendClient):
    async def list_menu(self) -> list[MenuItem]:
        raise RuntimeError("list_menu should not be called for session greeting start")


class CappuccinoCoreBackendClient(FakeCoreBackendClient):
    async def list_menu(self) -> list[MenuItem]:
        base = await super().list_menu()
        base.append(
            MenuItem(
                item_id="cappuccino",
                name="Cappuccino",
                category="Coffee",
                description="Ca phe sua bong nhe",
                price=Decimal("52000"),
                available=True,
                tags=["ca-phe", "nong"],
            )
        )
        return base


class SizeAwareCoreBackendClient(FakeCoreBackendClient):
    async def get_item_sizes(self, item_id: str) -> list[MenuItemSizeOption]:
        if item_id != "tra-dao":
            return []
        return [
            MenuItemSizeOption(
                item_id="tra-dao",
                product_id=101,
                size_id=1,
                size_name="S",
                price=Decimal("45000"),
                is_default=True,
            ),
            MenuItemSizeOption(
                item_id="tra-dao",
                product_id=101,
                size_id=2,
                size_name="M",
                price=Decimal("48000"),
                is_default=False,
            ),
            MenuItemSizeOption(
                item_id="tra-dao",
                product_id=101,
                size_id=3,
                size_name="L",
                price=Decimal("52000"),
                is_default=False,
            ),
        ]


class MenuRemovesTraDaoAfterFirstFetchCoreBackendClient(FakeCoreBackendClient):
    def __init__(self) -> None:
        super().__init__()
        self._menu_fetch_count = 0

    async def list_menu(self) -> list[MenuItem]:
        self._menu_fetch_count += 1
        menu = await super().list_menu()
        if self._menu_fetch_count >= 2:
            return [item for item in menu if item.item_id != "tra-dao"]
        return menu


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


def test_get_settings_reads_bridge_keepalive_controls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODE", "bridge_only")
    monkeypatch.setenv("BRIDGE_KEEPALIVE_ENABLED", "false")
    monkeypatch.setenv("BRIDGE_KEEPALIVE_INTERVAL_SECONDS", "120")
    monkeypatch.setenv("BRIDGE_KEEPALIVE_TIMEOUT_SECONDS", "7")

    settings = get_settings()
    assert settings.bridge_keepalive_enabled is False
    assert settings.bridge_keepalive_interval_seconds == 120.0
    assert settings.bridge_keepalive_timeout_seconds == 7.0


def test_stream_buffer_splits_completed_sentences_incrementally() -> None:
    buffer = ""
    emitted: list[str] = []

    for token in ["Xin chao", " ban.", " Hom nay", " minh co", " gi ngon?"]:
        buffer = append_stream_content(buffer, token)
        sentences, buffer = split_completed_sentences(buffer)
        emitted.extend(sentences)

    assert emitted == ["Xin chao ban.", "Hom nay minh co gi ngon?"]
    assert buffer.strip() == ""


def test_stream_buffer_keeps_incomplete_tail_until_punctuation() -> None:
    buffer = append_stream_content("", "Tra dao cam sa la mon")
    emitted, buffer = split_completed_sentences(buffer)
    assert emitted == []
    assert "Tra dao cam sa la mon" in buffer

    buffer = append_stream_content(buffer, " de uong.")
    emitted, buffer = split_completed_sentences(buffer)
    assert emitted == ["Tra dao cam sa la mon de uong."]
    assert buffer.strip() == ""


def test_ensure_frontend_safe_reply_normalizes_no_tone_bridge_text_for_recommendation() -> None:
    raw = "Menu hom nay co Tra sua tran chau, Tra dao cam sa. Ban muon goi mon nao?"
    safe = ensure_frontend_safe_reply("recommendation", raw)
    assert safe == "Mình có vài gợi ý để uống. Bạn muốn thử món nào?"


def test_ensure_frontend_safe_reply_keeps_properly_accented_text() -> None:
    raw = "Mình có vài gợi ý để uống, bạn muốn thử món nào?"
    safe = ensure_frontend_safe_reply("recommendation", raw)
    assert safe == raw


def test_ensure_frontend_safe_reply_repairs_vietnamese_spacing_artifacts() -> None:
    raw = "Món này bên mình khôngph ục vụ ạ 😅 Bạn chọn món khác trong menu giúp mình nhé, mình sẵn sàng gợi ýcho bạn nè!"
    safe = ensure_frontend_safe_reply("fallback", raw)
    assert safe == "Món này bên mình không phục vụ ạ 😅 Bạn chọn món khác trong menu giúp mình nhé, mình sẵn sàng gợi ý cho bạn nè!"


def test_normalize_text_preserves_d_letter_for_vietnamese_intents() -> None:
    assert normalize_text("Đặt đi giúp mình") == "dat di giup minh"


def test_stream_buffer_heals_split_words_for_broken_chunks() -> None:
    buffer = append_stream_content("", "Da em c")
    buffer = append_stream_content(buffer, "hao anh chi a.")
    emitted, _ = split_completed_sentences(buffer)
    assert emitted == ["Da em chao anh chi a."]

    buffer = append_stream_content("", "Mon do ben em kho")
    buffer = append_stream_content(buffer, "ng phuc vu.")
    emitted, _ = split_completed_sentences(buffer)
    assert emitted == ["Mon do ben em khong phuc vu."]


def test_stream_buffer_joins_known_split_loan_words() -> None:
    buffer = append_stream_content("", "Moi anh chi xem me")
    buffer = append_stream_content(buffer, "nu hom nay.")
    emitted, _ = split_completed_sentences(buffer)
    assert emitted == ["Moi anh chi xem menu hom nay."]


def test_tts_config_request_accepts_legacy_and_new_payload_keys() -> None:
    legacy_payload = TTSConfigRequest.model_validate({"tts_voice": "vi-VN-HoaiMyNeural", "tts_rate": 165})
    assert legacy_payload.voice == "vi-VN-HoaiMyNeural"
    assert legacy_payload.rate == 165

    new_payload = TTSConfigRequest.model_validate({"voice": "vi-VN-NamMinhNeural", "rate": 180})
    assert new_payload.voice == "vi-VN-NamMinhNeural"
    assert new_payload.rate == 180


def test_turn_request_accepts_optional_turn_id() -> None:
    payload = TurnRequest.model_validate({"transcript": "xin chao", "turn_id": "turn-123"})
    assert payload.turn_id == "turn-123"


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
async def test_conversation_engine_requires_size_before_adding_item() -> None:
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
    core_client = SizeAwareCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    ask_size = await engine.handle_turn(start.session_id, "cho minh 1 tra dao cam sa")
    assert ask_size.scene == "clarify_size"
    assert ask_size.cart == []

    added = await engine.handle_turn(start.session_id, "size l")
    assert added.scene == "cart_updated"
    assert len(added.cart) == 1
    assert added.cart[0].item_id == "tra-dao"
    assert added.cart[0].size_name == "L"
    assert added.cart[0].unit_price == Decimal("52000")


@pytest.mark.anyio
async def test_conversation_engine_sends_selected_size_to_order_payload() -> None:
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
    core_client = SizeAwareCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    await engine.handle_turn(start.session_id, "cho minh 1 tra dao cam sa")
    await engine.handle_turn(start.session_id, "size m")
    await engine.handle_turn(start.session_id, "xac nhan")
    created = await engine.handle_turn(start.session_id, "xac nhan")

    assert created.order_created is True
    assert core_client.created_orders
    _session_id, items_payload = core_client.created_orders[-1]
    assert items_payload == [
        {
            "item_id": "tra-dao",
            "quantity": 1,
            "size_name": "M",
            "size_id": 2,
        }
    ]


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
async def test_start_session_does_not_require_core_menu() -> None:
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
    core_client = FailingMenuCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    assert start.session_id.startswith("SES-")
    assert start.scene == "greeting_intro"
    assert start.reply_text


@pytest.mark.anyio
async def test_conversation_response_includes_robot_metadata_hints() -> None:
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
    assert start.scene == "greeting_intro"
    assert start.emotion_hint in {"neutral", "happy", "cute", "excited", "focused"}
    assert isinstance(start.action_hints, list)

    updated = await engine.handle_turn(start.session_id, "cho minh 1 tra dao cam sa")
    assert updated.scene in {"cart_updated", "ask_confirmation"}
    assert updated.emotion_hint in {"neutral", "happy", "cute", "excited", "focused"}
    assert isinstance(updated.action_hints, list)


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
        assert payload["analysis_version"] == 2
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
    chunks = [
        chunk
        async for chunk in engine.handle_turn_stream(
            start.session_id,
            "cho minh 1 tra dao cam sa",
            turn_id="turn-test-1",
        )
    ]

    assert any(chunk["type"] == "text" for chunk in chunks)
    assert any(chunk["type"] == "audio" for chunk in chunks)
    assert all(chunk.get("turn_id") == "turn-test-1" for chunk in chunks)
    assert speech_service.calls


@pytest.mark.anyio
async def test_handle_turn_stream_emits_text_final_and_bridge_source_for_complex_scene() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        bridge_base_url="http://127.0.0.1:1122",
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
    speech_service = FakeSpeechService()
    provider_client = FakeProviderClient()
    engine = ConversationEngine(settings, core_client, speech_service)
    engine.provider_client = provider_client

    start = await engine.start_session()
    chunks = [
        chunk
        async for chunk in engine.handle_turn_stream(
            start.session_id,
            "So sanh tra dao va matcha hom nay, mon nao hop hon?",
            turn_id="turn-test-stream-final",
            include_audio=False,
        )
    ]

    text_chunks = [chunk for chunk in chunks if chunk.get("type") == "text"]
    final_chunks = [chunk for chunk in chunks if chunk.get("type") == "text_final"]
    assert text_chunks
    assert final_chunks
    assert final_chunks[-1].get("bridge_source") in {"bridge_stream", "fallback", "local_rule"}
    assert final_chunks[-1].get("turn_id") == "turn-test-stream-final"
    assert provider_client.stream_calls >= 1
    # Stream endpoint should not do an extra blocking bridge call before streaming.
    assert provider_client.compose_calls == 0


@pytest.mark.anyio
async def test_handle_turn_stream_routes_self_intro_to_greeting_bridge_scene() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        bridge_base_url="http://127.0.0.1:1122",
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
    speech_service = FakeSpeechService()
    provider_client = FakeProviderClient()
    engine = ConversationEngine(settings, core_client, speech_service)
    engine.provider_client = provider_client

    start = await engine.start_session()
    chunks = [
        chunk
        async for chunk in engine.handle_turn_stream(
            start.session_id,
            "tao ten la danh",
            turn_id="turn-test-stream-intro",
            include_audio=False,
        )
    ]

    final_chunks = [chunk for chunk in chunks if chunk.get("type") == "text_final"]
    assert final_chunks
    assert final_chunks[-1].get("scene") == "greeting"
    assert provider_client.stream_calls >= 1


@pytest.mark.anyio
async def test_handle_turn_stream_routes_profanity_to_bridge_fallback_scene() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        bridge_base_url="http://127.0.0.1:1122",
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
    speech_service = FakeSpeechService()
    provider_client = FakeProviderClient()
    engine = ConversationEngine(settings, core_client, speech_service)
    engine.provider_client = provider_client

    start = await engine.start_session()
    chunks = [
        chunk
        async for chunk in engine.handle_turn_stream(
            start.session_id,
            "cut",
            turn_id="turn-test-stream-profanity",
            include_audio=False,
        )
    ]

    final_chunks = [chunk for chunk in chunks if chunk.get("type") == "text_final"]
    assert final_chunks
    assert final_chunks[-1].get("scene") == "fallback"
    assert provider_client.stream_calls >= 1


@pytest.mark.anyio
async def test_non_ordering_song_request_routes_to_fallback_scene() -> None:
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
    reply = await engine.handle_turn(start.session_id, "hat cho toi mot bai")

    assert reply.scene == "fallback"
    assert reply.recommended_item_ids == []


@pytest.mark.anyio
async def test_song_request_stream_prefers_bridge_over_local_recommendation() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        bridge_base_url="http://127.0.0.1:1122",
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
    speech_service = FakeSpeechService()
    provider_client = FakeProviderClient()
    engine = ConversationEngine(settings, core_client, speech_service)
    engine.provider_client = provider_client

    start = await engine.start_session()
    chunks = [
        chunk
        async for chunk in engine.handle_turn_stream(
            start.session_id,
            "hat cho toi mot bai",
            turn_id="turn-test-song-bridge",
            include_audio=False,
        )
    ]

    final_chunks = [chunk for chunk in chunks if chunk.get("type") == "text_final"]
    assert final_chunks
    assert final_chunks[-1].get("scene") == "fallback"
    assert provider_client.stream_calls >= 1


@pytest.mark.anyio
async def test_non_ordering_chat_does_not_fall_into_recommendation_scene() -> None:
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
    reply = await engine.handle_turn(start.session_id, "lam gi")

    assert reply.scene == "greeting"
    assert reply.recommended_item_ids == []


@pytest.mark.anyio
async def test_recommendation_fast_path_skips_bridge_for_simple_query() -> None:
    settings = Settings(
        ai_base_url="",
        ai_api_key="",
        ai_model="",
        core_backend_url="http://127.0.0.1:8001",
        bridge_base_url="http://127.0.0.1:1122",
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
    provider_client = FakeProviderClient()
    engine = ConversationEngine(settings, core_client)
    engine.provider_client = provider_client

    start = await engine.start_session()
    response = await engine.handle_turn(start.session_id, "Mon nao de uong it ngot?")

    assert response.scene == "recommendation"
    assert response.reply_text
    assert provider_client.compose_calls == 0


@pytest.mark.anyio
async def test_unknown_specific_item_request_reports_not_in_menu() -> None:
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
    response = await engine.handle_turn(start.session_id, "Toi muon an kem chuoi")

    assert response.scene == "recommendation"
    assert len(response.cart) == 0
    assert response.recommended_item_ids != []
    assert "trong menu" in normalize_text(response.reply_text)


@pytest.mark.anyio
async def test_stt_alias_gui_di_routes_to_recommendation_with_items() -> None:
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
    response = await engine.handle_turn(start.session_id, "gui di")

    assert response.scene == "recommendation"
    assert response.recommended_item_ids != []


@pytest.mark.anyio
async def test_stt_alias_capuchino_still_adds_cappuccino_item() -> None:
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
    core_client = CappuccinoCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    response = await engine.handle_turn(start.session_id, "cho minh 1 capuchino")

    assert response.scene in {"cart_updated", "ask_confirmation"}
    added = next((item for item in response.cart if item.item_id == "cappuccino"), None)
    assert added is not None
    assert added.quantity == 1


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


@pytest.mark.anyio
async def test_remove_unknown_item_does_not_drop_last_cart_item() -> None:
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
    await engine.handle_turn(start.session_id, "them 1 tra dao cam sa")
    removed = await engine.handle_turn(start.session_id, "bo cappuccino")

    assert removed.scene == "remove_item"
    assert len(removed.cart) == 1
    assert removed.cart[0].item_id == "tra-dao"
    assert removed.cart[0].quantity == 1


@pytest.mark.anyio
async def test_checkout_prunes_items_not_in_latest_menu_api() -> None:
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
    core_client = MenuRemovesTraDaoAfterFirstFetchCoreBackendClient()
    engine = ConversationEngine(settings, core_client)

    start = await engine.start_session()
    added = await engine.handle_turn(start.session_id, "them 1 tra dao cam sa")
    assert len(added.cart) == 1

    # Force next turn to read latest menu from API (simulate menu changed remotely).
    engine._menu_cache = None
    engine._menu_cache_at = 0

    confirm = await engine.handle_turn(start.session_id, "xac nhan")

    assert confirm.scene == "recommendation"
    assert len(confirm.cart) == 0
    assert core_client.created_orders == []
    assert "khong con phuc vu" in normalize_text(confirm.reply_text)


@pytest.mark.anyio
async def test_generic_remove_with_quantity_decrements_last_item() -> None:
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
    await engine.handle_turn(start.session_id, "them 3 tra dao cam sa")
    removed = await engine.handle_turn(start.session_id, "bot 1 ly")

    assert removed.scene == "remove_item"
    assert len(removed.cart) == 1
    assert removed.cart[0].item_id == "tra-dao"
    assert removed.cart[0].quantity == 2


@pytest.mark.anyio
async def test_generic_remove_with_number_words_decrements_last_item() -> None:
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
    await engine.handle_turn(start.session_id, "them 3 tra dao cam sa")
    removed = await engine.handle_turn(start.session_id, "bot hai")

    assert removed.scene == "remove_item"
    assert len(removed.cart) == 1
    assert removed.cart[0].item_id == "tra-dao"
    assert removed.cart[0].quantity == 1


def test_fallback_reply_soft_redirects_singing_request() -> None:
    reply = render_fallback_reply(
        {
            "scene": "fallback",
            "seed": "",
            "user_text": "hat cho toi mot bai di",
        }
    )

    normalized_reply = normalize_text(reply)
    assert "mon" in normalized_reply or "uong" in normalized_reply
    assert "chi phuc vu" not in normalized_reply


def test_greeting_reply_can_softly_handle_heart_to_heart_chat() -> None:
    reply = render_fallback_reply(
        {
            "scene": "greeting",
            "seed": "",
            "user_text": "hom nay toi hoi buon, cho toi tam su xiu",
        }
    )

    normalized_reply = normalize_text(reply)
    assert any(
        keyword in normalized_reply
        for keyword in ("tam trang", "noi chuyen", "goi y mon", "hop gu")
    )

