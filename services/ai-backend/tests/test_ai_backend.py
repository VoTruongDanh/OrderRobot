from __future__ import annotations

from decimal import Decimal

import pytest

from app.config import Settings
from app.models import CreateOrderResponse, MenuItem
from app.services.conversation_engine import ConversationEngine


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

    # Override provider_client with a mock that tracks calls
    call_count = 0
    original_compose = engine.provider_client.compose_reply

    async def tracked_compose(payload):
        nonlocal call_count
        call_count += 1
        return await original_compose(payload)

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
