from __future__ import annotations

import asyncio
import base64
from collections import Counter
import difflib
import json
import logging
from pathlib import Path
import random
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import uuid4

logger = logging.getLogger(__name__)

from app.config import Settings
from app.models import (
    CartItem,
    ConversationResponse,
    CreateOrderLineItem,
    CreateOrderRequest,
    Decision,
    MenuItem,
    MenuItemSizeOption,
    SessionState,
)
from app.services.core_backend_client import CoreBackendClient
from app.services.provider_client import ProviderClient

if TYPE_CHECKING:
    from app.services.speech_service import SpeechService


QUANTITY_WORDS = {
    "mot": 1,
    "hai": 2,
    "ba": 3,
    "bon": 4,
    "nam": 5,
    "sau": 6,
    "bay": 7,
    "tam": 8,
    "chin": 9,
    "muoi": 10,
}
QUANTITY_CONTEXT_WORDS = {
    "cho", "them", "lay", "mua", "dat", "order", "bo", "xoa", "bot", "giam",
}
QUANTITY_SKIP_PREVIOUS_WORDS = {"phim", "ma", "so", "tap", "bai", "model"}
GENERIC_NOUN_HINTS = {
    "ca", "phe", "tra", "sua", "matcha", "socola", "cookie", "cream", "chanh", "day",
    "bac", "xiu", "latte", "americano", "cappuccino", "flan", "tiramisu", "dao", "cam",
    "sa", "vai", "hong",
}
CONFIRM_KEYWORDS = {
    # Rõ ràng, không nhầm lẫn:
    "xac nhan", "dong y", "ok", "oke", "okey", "okay",
    "dat di", "chot don", "xac nhan don", "len don di",
    "dung roi", "dung vay", "chuan roi", "chinh xac",
    "duoc roi", "lay luon", "tien hanh di", "xac nhan luon",
    # Câu xác nhận ngắn nhưng đặc thù (không cắt ra):
    "vang em", "da vang", "uh huh", "oke luon",
}
RESET_KEYWORDS = {"huy", "lam lai", "dat lai", "bo het", "xoa het", "xoa tat ca", "bat dau lai", "reset"}
REMOVE_KEYWORDS = {
    "bo", "xoa", "huy mon", "khong lay", "bo di", "xoa di", "xoa mon", "bo mon",
    "khong can", "bo ra", "xoa ra", "huy mon nay", "bo mon nay", "khong muon",
    "bot", "giam",
}
ADD_INTENT_KEYWORDS = {
    "them", "cho", "goi", "dat", "lay", "order", "mua",
}
RECOMMEND_KEYWORDS = {
    "goi y", "tu van", "nen uong", "nen an", "de uong", "it ngot", "mon nao",
    "co gi ngon", "ngon", "gioi thieu", "co gi", "thu gi", "uong gi",
    "an gi", "ban co gi", "cho em xem", "cho toi xem", "menu",
}
CHECKOUT_KEYWORDS = {
    # Thường xử lý thêm lúc chốt
    "xong", "dat luon", "len don", "chot don", "thanh toan", "xong roi", "het roi",
    # Từ thị trường đặt hàng
    "dat hang", "order", "order luon", "dat luon di", "dat don",
    "dat ngay", "dat thoi", "toi muon dat", "cho toi dat",
    "lay luon", "lay di", "lay thoi", "cho toi lay",
    # Xác nhận mua
    "chot", "mua luon", "mua di", "tinh tien", "thanh toan luon",
    "tra tien", "xong di", "oke dat hang", "ok dat hang",
}
SEGMENT_SPLIT_PATTERN = re.compile(r"\s*(?:,|\bva\b|\bvoi\b|\bcung\b|\bthem\b)\s*")
SIZE_ALIAS_MAP = {
    "s": "S",
    "small": "S",
    "nho": "S",
    "size s": "S",
    "c nho": "S",
    "co nho": "S",
    "m": "M",
    "medium": "M",
    "vua": "M",
    "size m": "M",
    "c vua": "M",
    "co vua": "M",
    "l": "L",
    "large": "L",
    "lon": "L",
    "size l": "L",
    "c lon": "L",
    "co lon": "L",
    "xl": "XL",
    "x l": "XL",
    "extra large": "XL",
    "size xl": "XL",
}

# Chitchat / non-ordering keywords â€” respond naturally instead of trying to match menu
_CHITCHAT_PATTERNS = [
    re.compile(r"ten (toi|minh|em|anh|chi) la"),  # "tên tôi là X"
    re.compile(r"toi ten (la )?"),                  # "tôi tên là X"
    re.compile(r"\bten la\b"),                      # "tên là X"
    re.compile(r"\blam gi\b"),                      # "làm gì"
    re.compile(r"^(chao|hi|hello|xin chao)"),       # greetings
    re.compile(r"o dau"),                           # "ở đâu"
    re.compile(r"may gio"),                         # "mấy giờ"
    re.compile(r"cam on"),                          # "cảm ơn"
    re.compile(r"^(da|vang|ok|oke|uhm)$"),          # acknowledgments
    re.compile(r"the la"),                          # "thế là"
    re.compile(r"khong tin"),                       # "không tin"
]
_NON_ORDERING_REQUEST_PATTERNS = [
    re.compile(r"\bhat cho\b"),
    re.compile(r"\bhat (mot )?bai\b"),
    re.compile(r"\bcho toi (mot )?bai hat\b"),
    re.compile(r"\blam tho\b"),
    re.compile(r"\bdoc tho\b"),
    re.compile(r"\btam su\b"),
    re.compile(r"\bco don\b"),
]
_SPECIFIC_ITEM_REQUEST_PATTERNS = [
    re.compile(r"\b(?:toi|minh|em|anh|chi)\s+muon\s+(?:an|uong|goi|lay|mua)\b"),
    re.compile(r"\b(?:muon|goi|lay|mua|them)\s+(?:an|uong)\b"),
    re.compile(r"\bcho\s+(?:toi|minh|em|anh|chi)\s+(?:an|uong|goi|lay|mua)\b"),
]

# Vietnamese STT common misrecognitions and aliases
# Maps normalized (diacritics-stripped) words to their correct forms
_STT_ALIASES: dict[str, str] = {
    # Diacritics confusion
    "da xay": "da xay",
    "da xai": "da xay",
    "da xuy": "da xay",
    "day xay": "da xay",
    # Socola variants
    "so co la": "socola",
    "chocolate": "socola",
    "choco": "socola",
    "socolate": "socola",
    # Vowel confusion by STT
    "kim sua": "kem sua",
    "kin sua": "kem sua",
    # Common homophones / STT errors (only compound phrases to avoid false positives)
    "cho vai": "tra vai",   # "chợ vải" misheard -> "trà vải"
    "cha sua": "tra sua",
    "ba xi u": "bac xiu",
    "bac siu": "bac xiu",
    "bax xiu": "bac xiu",
    "cap phe": "ca phe",
    "cafe": "ca phe",
    "coffee": "ca phe",
    "cofe": "ca phe",
    "mat cha": "matcha",
    "mat tra": "matcha",
    "mac cha": "matcha",
    "flan": "flan",
    "plan": "flan",
    "phan": "flan",
    # Fruit/flavor confusion
    "trao": "tra dao",
    "chanh day": "chanh day",
    "chan day": "chanh day",
    "vai": "vai",
    "vay": "vai",
    # Action confusion
    "cho em": "cho",
    "gui em": "cho",
    "gui y di": "goi y di",
    "gui di": "goi y di",
    "gui i di": "goi y di",
    "gui y": "goi y",
    "gui i": "goi y",
    "goi i": "goi y",
    # Size phrases frequently misheard by STT
    "sai nho": "size nho",
    "sai vua": "size vua",
    "sai lon": "size lon",
    # Common drink-name STT variants
    "capuchino": "cappuccino",
    "capuccino": "cappuccino",
    "capuchinno": "cappuccino",
    "ca pu chi no": "cappuccino",
}
REMOVE_FALLBACK_GENERIC_TOKENS = {
    "bo", "xoa", "huy", "mon", "nay", "di", "ra", "bot", "nua",
    "khong", "lay", "can", "giup", "dum", "cho", "toi", "minh", "em", "anh", "chi",
}
GENERIC_REMOVE_UNIT_WORDS = {
    "ly", "cai", "phan", "chiec", "to", "dia", "bat", "chai", "lon", "coc", "tach",
}

# Minimum similarity ratio for fuzzy matching (0.0 - 1.0)
_FUZZY_THRESHOLD = 0.70
# Auto-add threshold: items with confidence >= this are added directly to cart
_AUTO_ADD_THRESHOLD = 0.85
# Recommendation ranking confidence floor for fallback matching path.
_MIN_RANK_SCORE_FOR_RECOMMENDATION = 6

# Scenes handled locally without LLM
SIMPLE_SCENES = {"reset", "cart_updated", "remove_item",
                 "order_created", "cart_follow_up",
                 "ask_confirmation", "clarify_item", "greeting_intro"}
# Scenes that benefit from bridge context and natural conversational style.
# Keep ordering-critical scenes local for deterministic behavior.
COMPLEX_SCENES = {"recommendation", "fallback", "greeting", "cart_follow_up"}
BRIDGE_LOCAL_ONLY_SCENES = {"cart_follow_up"}
BRIDGE_RESPONSE_BUDGET_SECONDS = 8.0
BRIDGE_SCENE_BUDGET_SECONDS = {
    "recommendation": 6.0,
    "fallback": 3.5,
    "greeting": 3.0,
    "cart_follow_up": 3.0,
}
QUICK_REPLY_CACHE_TTL_SECONDS = 300.0
QUICK_REPLY_CACHE_MAX_SIZE = 256
QUICK_REPLY_CACHE_SCENES = {"greeting", "fallback", "recommendation"}
STATIC_CACHE_MAX_QUERY_CHARS = 64
STATIC_CACHE_GREETING_KEYWORDS = {"chao", "xin chao", "hello", "hi"}
STATIC_CACHE_MENU_KEYWORDS = {"menu", "thuc don", "thực đơn", "co gi", "ban co gi", "co mon gi"}
STATIC_CACHE_CONFIRM_KEYWORDS = {"xac nhan", "xác nhận", "dong y", "chot don", "dat luon", "len don"}
ORDERING_HINT_KEYWORDS = (
    RECOMMEND_KEYWORDS
    | ADD_INTENT_KEYWORDS
    | CHECKOUT_KEYWORDS
    | CONFIRM_KEYWORDS
    | RESET_KEYWORDS
    | REMOVE_KEYWORDS
)
SIMPLE_GREETING_KEYWORDS = {"chao", "xin chao", "hello", "hi", "alo", "chao ban", "xin chao ban"}
PROFANITY_KEYWORDS = {"cut", "dit", "dm", "dmm", "cl", "cac", "lon", "deo"}
SHORT_NEGATIVE_REPLY_KEYWORDS = {
    "khong",
    "ko",
    "khong can",
    "khong them",
    "khong can them",
    "thoi",
    "thoi khong",
    "khong topping",
    "khong can topping",
}
BRIDGE_LONG_QUERY_WORDS_THRESHOLD = 20
BRIDGE_LONG_QUERY_CHARS_THRESHOLD = 120
BRIDGE_ESCALATION_KEYWORDS = {
    "moi nhat",
    "hom nay",
    "hien tai",
    "gia",
    "tin tuc",
    "tin nong",
    "thoi tiet",
    "ti gia",
    "chung khoan",
    "co phieu",
    "ty so",
    "ket qua",
    "so sanh",
    "giai thich",
    "tai sao",
    "vi sao",
    "news",
    "web",
    "google",
}

MENU_CACHE_TTL = 60.0  # seconds

ASSISTANT_ADD_MARKERS = (
    "da them",
    "them vao gio hang",
    "vao gio hang",
)
ASSISTANT_REMOVE_MARKERS = (
    "da bo",
    "da xoa",
    "khoi gio hang",
)
ASSISTANT_GENERIC_PROMPT_MARKERS = (
    "ban muon goi mon gi",
    "ban chon thu mot mon",
    "ban muon dung gi",
    "ban muon thu",
    "minh co ca phe",
    "minh co tra sua",
    "goi mon nao",
)
SHORT_ACK_USER_WORDS = {"co", "da", "ok", "oke", "uh", "uhm", "vang", "roi"}


@dataclass(slots=True)
class Candidate:
    item: MenuItem
    score: int


class ConversationEngine:
    def __init__(
        self,
        settings: Settings,
        core_client: CoreBackendClient,
        speech_service: "SpeechService | None" = None,
    ) -> None:
        self.settings = settings
        self.core_client = core_client
        self.speech_service = speech_service
        self.provider_client = ProviderClient(settings) if settings.bridge_enabled else None
        self.sessions: dict[str, SessionState] = {}
        self.lock = asyncio.Lock()
        self._menu_cache: list[MenuItem] | None = None
        self._menu_cache_at: float = 0.0
        self._quick_reply_cache: dict[str, tuple[float, str, str]] = {}
        self._local_only_turn_ids: set[str] = set()
        self._size_options_cache: dict[str, tuple[float, list[MenuItemSizeOption]]] = {}

    async def _get_menu(self) -> list[MenuItem]:
        """Get menu with caching (TTL=60s) to avoid HTTP round-trip every turn."""
        now = time.monotonic()
        if self._menu_cache is not None and (now - self._menu_cache_at) < MENU_CACHE_TTL:
            return self._menu_cache
        self._menu_cache = await self.core_client.list_menu()
        self._menu_cache_at = now
        return self._menu_cache

    async def _get_item_size_options(self, item_id: str) -> list[MenuItemSizeOption]:
        now = time.monotonic()
        cached = self._size_options_cache.get(item_id)
        if cached and (now - cached[0]) < MENU_CACHE_TTL:
            return cached[1]
        get_item_sizes = getattr(self.core_client, "get_item_sizes", None)
        if not callable(get_item_sizes):
            # Backward compatibility for old/mock core client without size endpoint.
            self._size_options_cache[item_id] = (now, [])
            return []
        try:
            options = await get_item_sizes(item_id)
        except Exception as exc:
            logger.warning("get_item_sizes_failed item_id=%s error=%s", item_id, exc)
            options = []
        options_sorted = sorted(options, key=lambda opt: (not opt.is_default, opt.size_name))
        self._size_options_cache[item_id] = (now, options_sorted)
        return options_sorted

    @staticmethod
    def _normalize_size_token(value: str) -> str:
        token = normalize_text(str(value or "")).strip().replace("-", " ")
        token = re.sub(r"\s+", " ", token)
        if token in SIZE_ALIAS_MAP:
            return SIZE_ALIAS_MAP[token]
        if token.startswith("size "):
            token = token.split(" ", 1)[1].strip()
        compact = token.replace(" ", "").upper()
        if compact in {"S", "M", "L", "XL", "XXL"}:
            return compact
        return str(value or "").strip().upper()

    def _find_size_in_text(self, normalized_text: str, options: list[MenuItemSizeOption]) -> MenuItemSizeOption | None:
        if not options:
            return None
        option_map: dict[str, MenuItemSizeOption] = {}
        for option in options:
            normalized_name = self._normalize_size_token(option.size_name)
            option_map[normalized_name] = option
            option_map[normalize_text(option.size_name).upper()] = option

        text = f" {normalized_text.strip()} "
        for alias, normalized_size in SIZE_ALIAS_MAP.items():
            if f" {alias} " in text and normalized_size in option_map:
                return option_map[normalized_size]

        explicit_match = re.search(r"\bsize\s*([a-z0-9]+)\b", normalized_text)
        if explicit_match:
            normalized_size = self._normalize_size_token(explicit_match.group(1))
            if normalized_size in option_map:
                return option_map[normalized_size]

        for normalized_size, option in option_map.items():
            if len(normalized_size) <= 4 and f" {normalized_size.lower()} " in text:
                return option
        return None

    @staticmethod
    def _format_size_options(options: list[MenuItemSizeOption]) -> str:
        names = [str(option.size_name).strip() for option in options if str(option.size_name).strip()]
        return ", ".join(names[:8])

    @staticmethod
    def _clear_pending_size(state: SessionState) -> None:
        state.pending_size_item_id = None
        state.pending_size_item_name = None
        state.pending_size_quantity = 1
        state.pending_size_options.clear()

    async def start_session(self) -> ConversationResponse:
        session_id = f"SES-{uuid4().hex[:10]}"
        async with self.lock:
            self._cleanup_expired_sessions()
            self.sessions[session_id] = SessionState(session_id=session_id, greeted=True)

        decision = Decision(
            scene="greeting_intro",
            reply_seed="Chào mừng bạn. Hôm nay bạn muốn thử món nào để mình tư vấn ngay?",
        )
        # Greeting must not block on core menu availability.
        # Cart is empty on session start, so menu lookup is unnecessary.
        return await self._build_response(session_id, decision, menu=[])

    async def reset_session(self, session_id: str) -> ConversationResponse:
        async with self.lock:
            self._cleanup_expired_sessions()
            state = self.sessions.setdefault(session_id, SessionState(session_id=session_id))
            self._touch_state(state)
            state.cart.clear()
            state.cart_unit_price_by_item.clear()
            state.cart_size_by_item.clear()
            state.cart_size_id_by_item.clear()
            self._clear_pending_size(state)
            state.history.clear()
            state.awaiting_confirmation = False

        decision = Decision(
            scene="reset",
            reply_seed="Mình đã làm mới giỏ hàng rồi. Bạn muốn gọi món nào tiếp theo?",
        )
        return await self._build_response(session_id, decision)

    async def handle_turn(
        self,
        session_id: str,
        transcript: str,
        turn_id: str | None = None,
        quick_checkout: bool = False,
    ) -> ConversationResponse:
        async with self.lock:
            self._cleanup_expired_sessions()
            state = self.sessions.get(session_id)
            if state is None:
                state = SessionState(session_id=session_id)
                self.sessions[session_id] = state
            self._touch_state(state)
            state.history.append(transcript)

        menu = await self._get_menu()
        normalized_raw = normalize_text(transcript)
        normalized = _apply_stt_aliases(normalized_raw)

        if (state.cart or state.pending_size_item_id) and contains_any(normalized, RESET_KEYWORDS):
            state.cart.clear()
            state.cart_unit_price_by_item.clear()
            state.cart_size_by_item.clear()
            state.cart_size_id_by_item.clear()
            self._clear_pending_size(state)
            state.awaiting_confirmation = False
            return await self._build_response(
                session_id,
                Decision(
                    scene="reset",
                    reply_seed="Mình đã xoá giỏ hàng cũ rồi. Bạn muốn mình gợi ý món nào tiếp không?",
                ),
                menu,
            )

        if state.pending_size_item_id:
            pending_item_id = state.pending_size_item_id
            pending_item_name = state.pending_size_item_name or "món đang chọn"
            pending_quantity = max(1, int(state.pending_size_quantity or 1))
            if contains_any(normalized, REMOVE_KEYWORDS):
                self._clear_pending_size(state)
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="remove_item",
                        reply_seed=f"Mình đã bỏ yêu cầu thêm {pending_item_name}. Bạn muốn chọn món khác không?",
                    ),
                    menu,
                )
            options = await self._get_item_size_options(pending_item_id)
            selected = self._find_size_in_text(normalized, options)
            if selected is not None:
                state.cart[pending_item_id] = state.cart.get(pending_item_id, 0) + pending_quantity
                state.cart_unit_price_by_item[pending_item_id] = selected.price
                state.cart_size_by_item[pending_item_id] = selected.size_name
                if selected.size_id is not None:
                    state.cart_size_id_by_item[pending_item_id] = int(selected.size_id)
                self._clear_pending_size(state)
                state.awaiting_confirmation = contains_any(normalized, CHECKOUT_KEYWORDS)
                scene = "ask_confirmation" if state.awaiting_confirmation else "cart_updated"
                seed = (
                    f"Mình đã thêm {pending_quantity} {pending_item_name} size {selected.size_name} vào giỏ hàng."
                    if not state.awaiting_confirmation
                    else (
                        f"Mình đã thêm {pending_quantity} {pending_item_name} size {selected.size_name}. "
                        "Mình đọc lại giỏ hàng để bạn xác nhận nhé."
                    )
                )
                return await self._build_response(
                    session_id,
                    Decision(
                        scene=scene,
                        reply_seed=seed,
                        needs_confirmation=state.awaiting_confirmation,
                        recommended_item_ids=[pending_item_id],
                    ),
                    menu,
                )

            fallback_options = options
            if not fallback_options and state.pending_size_options:
                fallback_options = [
                    MenuItemSizeOption(
                        item_id=pending_item_id,
                        size_name=size_name,
                        price=Decimal("0"),
                        is_default=False,
                    )
                    for size_name in state.pending_size_options
                ]
            options_text = self._format_size_options(fallback_options) or "S, M, L"
            return await self._build_response(
                session_id,
                Decision(
                    scene="clarify_size",
                    reply_seed=(
                        f"Món {pending_item_name} có các size: {options_text}. "
                        "Bạn chọn size nào để mình thêm vào giỏ?"
                    ),
                    recommended_item_ids=[pending_item_id],
                ),
                menu,
            )

        if state.cart and (
            quick_checkout
            or contains_any(normalized, CONFIRM_KEYWORDS)
            or contains_any(normalized, CHECKOUT_KEYWORDS)
        ):
            if quick_checkout:
                logger.info("quick_checkout_requested session_id=%s turn_id=%s cart_items=%s", session_id, turn_id or "", len(state.cart))
            pruned_items = self._prune_non_orderable_cart_items(state, menu)
            if pruned_items:
                removed_summary = ", ".join(pruned_items[:2])
                if len(pruned_items) > 2:
                    removed_summary += ", ..."
                if not state.cart:
                    return await self._build_response(
                        session_id,
                        Decision(
                            scene="recommendation",
                            reply_seed=(
                                f"Mình vừa cập nhật menu: {removed_summary} hiện không còn phục vụ "
                                "nên đã bỏ khỏi giỏ. Bạn muốn mình gợi ý món thay thế không?"
                            ),
                            user_text=transcript,
                        ),
                        menu,
                        turn_id=turn_id,
                    )
                state.awaiting_confirmation = True
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="ask_confirmation",
                        reply_seed=(
                            f"Mình vừa cập nhật menu: {removed_summary} hiện không còn phục vụ "
                            "nên đã bỏ khỏi giỏ. Mình đọc lại giỏ hiện tại để bạn xác nhận nhé."
                        ),
                        needs_confirmation=True,
                    ),
                    menu,
                )

            if quick_checkout:
                state.awaiting_confirmation = True

            if state.awaiting_confirmation:
                for item_id, quantity in list(state.cart.items()):
                    if item_id in state.cart_size_by_item:
                        continue
                    size_options = await self._get_item_size_options(item_id)
                    if len(size_options) > 1:
                        menu_item = next((item for item in menu if item.item_id == item_id), None)
                        item_name = menu_item.name if menu_item is not None else "món đã chọn"
                        self._clear_pending_size(state)
                        state.pending_size_item_id = item_id
                        state.pending_size_item_name = item_name
                        state.pending_size_quantity = quantity
                        state.pending_size_options = [opt.size_name for opt in size_options]
                        options_text = self._format_size_options(size_options)
                        return await self._build_response(
                            session_id,
                            Decision(
                                scene="clarify_size",
                                reply_seed=(
                                    f"Món {item_name} có nhiều size: {options_text}. "
                                    "Bạn chọn size trước rồi mình mới lên đơn nhé."
                                ),
                                recommended_item_ids=[item_id],
                            ),
                            menu,
                        )
                    if len(size_options) == 1:
                        state.cart_unit_price_by_item[item_id] = size_options[0].price
                        state.cart_size_by_item[item_id] = size_options[0].size_name
                        if size_options[0].size_id is not None:
                            state.cart_size_id_by_item[item_id] = int(size_options[0].size_id)

                order = await self.core_client.create_order(
                    CreateOrderRequest(
                        session_id=session_id,
                        customer_text=transcript,
                        items=[
                            CreateOrderLineItem(
                                item_id=item_id,
                                quantity=quantity,
                                size_name=state.cart_size_by_item.get(item_id),
                                size_id=state.cart_size_id_by_item.get(item_id),
                            )
                            for item_id, quantity in state.cart.items()
                        ],
                    )
                )
                state.cart.clear()
                state.cart_unit_price_by_item.clear()
                state.cart_size_by_item.clear()
                state.cart_size_id_by_item.clear()
                self._clear_pending_size(state)
                state.awaiting_confirmation = False
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="order_created",
                        reply_seed=f"Đã xong. Mình đã lên đơn thành công với mã {order.order_id}. Cảm ơn bạn nhé.",
                        order_created=True,
                        order_id=order.order_id,
                        payment_status=order.payment_status,
                        payment_qr_content=order.payment_qr_content,
                        payment_qr_image_url=order.payment_qr_image_url,
                        payment_amount=order.payment_amount,
                        payment_expires_at=order.payment_expires_at,
                        sync_error_code=order.sync_error_code,
                        sync_error_detail=order.sync_error_detail,
                    ),
                    menu,
                )

            state.awaiting_confirmation = True
            return await self._build_response(
                session_id,
                Decision(
                    scene="ask_confirmation",
                    reply_seed="Mình đọc lại giỏ hàng để bạn xác nhận nhé.",
                    needs_confirmation=True,
                ),
                menu,
            )

        if state.cart and contains_any(normalized, REMOVE_KEYWORDS):
            removed = self._remove_from_cart(state, normalized, menu)
            if removed:
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="remove_item",
                        reply_seed=f"Mình đã bỏ {removed} khỏi giỏ hàng rồi. Bạn muốn sửa gì thêm không?",
                    ),
                    menu,
                )
            return await self._build_response(
                session_id,
                Decision(
                    scene="remove_item",
                    reply_seed="Mình chưa thấy món đó trong giỏ hàng hiện tại. Bạn nói lại đúng tên món cần bớt giúp mình nhé.",
                ),
                    menu,
                )

        if state.cart and _is_short_negative_reply_text(normalized):
            if state.awaiting_confirmation:
                state.awaiting_confirmation = False
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="cart_follow_up",
                        reply_seed=(
                            "Dạ ok, mình chưa chốt đơn. Giỏ hàng vẫn được giữ nguyên, "
                            "khi nào bạn muốn đặt thì nói xác nhận nhé."
                        ),
                    ),
                    menu,
                    turn_id=turn_id,
                )
            state.awaiting_confirmation = True
            return await self._build_response(
                session_id,
                Decision(
                    scene="ask_confirmation",
                    reply_seed=(
                        "Dạ ok, mình giữ món hiện tại và không thêm topping. "
                        "Mình đọc lại giỏ hàng để bạn xác nhận nhé."
                    ),
                    needs_confirmation=True,
                ),
                menu,
            )

        non_ordering_request = _is_non_ordering_request_text(normalized)
        has_ordering_hint = contains_any(normalized, ORDERING_HINT_KEYWORDS) and not non_ordering_request
        if _contains_profanity_text(normalized):
            return await self._build_response(
                session_id,
                Decision(
                    scene="fallback",
                    reply_seed="",
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        if non_ordering_request:
            return await self._build_response(
                session_id,
                Decision(
                    scene="fallback",
                    reply_seed="",
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        # Chitchat / self-intro / non-ordering input â€” avoid forcing recommendation mode.
        if _is_chitchat(normalized) and not has_ordering_hint:
            return await self._build_response(
                session_id,
                Decision(
                    scene="greeting",
                    reply_seed="",
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        recommendation_request = contains_any(normalized, RECOMMEND_KEYWORDS) or ("?" in transcript and has_ordering_hint)
        if recommendation_request:
            recommended = self._rank_items(normalized, menu)[:3]
            if recommended and recommended[0].score >= _MIN_RANK_SCORE_FOR_RECOMMENDATION:
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="recommendation",
                        reply_seed="Mình tìm được vài món hợp gu của bạn rồi.",
                        recommended_item_ids=[candidate.item.item_id for candidate in recommended],
                        user_text=transcript,
                    ),
                    menu,
                    turn_id=turn_id,
                )
            top_available_items = [item for item in menu if item.available][:3]
            fallback_recommendations = (
                [candidate.item.item_id for candidate in recommended]
                if recommended
                else [item.item_id for item in top_available_items]
            )
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed="Mình gợi ý nhanh vài món dễ chọn cho bạn nhé.",
                    recommended_item_ids=fallback_recommendations,
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        segment_matches = self._extract_segment_matches(normalized, menu)
        if segment_matches:
            state.awaiting_confirmation = contains_any(normalized, CHECKOUT_KEYWORDS)
            for item, quantity in segment_matches:
                size_options = await self._get_item_size_options(item.item_id)
                selected_size = self._find_size_in_text(normalized, size_options)
                if len(size_options) > 1 and selected_size is None:
                    self._clear_pending_size(state)
                    state.pending_size_item_id = item.item_id
                    state.pending_size_item_name = item.name
                    state.pending_size_quantity = quantity
                    state.pending_size_options = [opt.size_name for opt in size_options]
                    options_text = self._format_size_options(size_options)
                    return await self._build_response(
                        session_id,
                        Decision(
                            scene="clarify_size",
                            reply_seed=(
                                f"Món {item.name} có nhiều size: {options_text}. "
                                "Bạn chọn size nào rồi mình mới thêm vào giỏ nhé."
                            ),
                            recommended_item_ids=[item.item_id],
                        ),
                        menu,
                    )
                if selected_size is not None:
                    state.cart_unit_price_by_item[item.item_id] = selected_size.price
                    state.cart_size_by_item[item.item_id] = selected_size.size_name
                    if selected_size.size_id is not None:
                        state.cart_size_id_by_item[item.item_id] = int(selected_size.size_id)
                elif len(size_options) == 1:
                    state.cart_unit_price_by_item[item.item_id] = size_options[0].price
                    state.cart_size_by_item[item.item_id] = size_options[0].size_name
                    if size_options[0].size_id is not None:
                        state.cart_size_id_by_item[item.item_id] = int(size_options[0].size_id)

            for item, quantity in segment_matches:
                state.cart[item.item_id] = state.cart.get(item.item_id, 0) + quantity

            added_summary = ", ".join(
                (
                    f"{quantity} {item.name} size {state.cart_size_by_item[item.item_id]}"
                    if state.cart_size_by_item.get(item.item_id)
                    else f"{quantity} {item.name}"
                )
                for item, quantity in segment_matches
            )
            scene = "ask_confirmation" if state.awaiting_confirmation else "cart_updated"
            seed = (
                f"Mình đã thêm {added_summary} vào giỏ hàng."
                if not state.awaiting_confirmation
                else f"Mình đã thêm {added_summary}. Mình đọc lại giỏ hàng để bạn xác nhận nhé."
            )
            return await self._build_response(
                session_id,
                Decision(
                    scene=scene,
                    reply_seed=seed,
                    needs_confirmation=state.awaiting_confirmation,
                    recommended_item_ids=[item.item_id for item, _ in segment_matches],
                ),
                menu,
            )

        matched_items = self._match_explicit_items(normalized, menu)
        available_matches = [(item, conf) for item, conf in matched_items if item.available]
        unavailable_matches = [(item, conf) for item, conf in matched_items if not item.available]
        if unavailable_matches and not available_matches:
            alternatives = self._rank_items(normalized, menu)[:3]
            unavailable_names = ", ".join(item.name for item, _ in unavailable_matches[:2])
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed=f"Xin lỗi, {unavailable_names} đang tạm hết. Mình gợi ý bạn đổi sang món khác nhé.",
                    recommended_item_ids=[candidate.item.item_id for candidate in alternatives],
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        if available_matches:
            # Auto-add: best match confidence >= 85% -> add directly
            best_match, best_conf = max(available_matches, key=lambda x: x[1])
            high_conf_matches = [(item, conf) for item, conf in available_matches if conf >= _AUTO_ADD_THRESHOLD]
            has_size_hint = bool(re.search(r"\bsize\s*[a-z0-9]+\b", normalized))
            should_auto_add_single = len(available_matches) == 1 and (has_ordering_hint or has_size_hint)
            
            if should_auto_add_single or len(high_conf_matches) == 1 or best_conf >= _AUTO_ADD_THRESHOLD:
                # Single high-confidence match or one clearly dominates -> auto-add
                item = best_match
                quantity = extract_quantity(normalized, item_name=normalize_text(item.name))
                size_options = await self._get_item_size_options(item.item_id)
                selected_size = self._find_size_in_text(normalized, size_options)
                if len(size_options) > 1 and selected_size is None:
                    self._clear_pending_size(state)
                    state.pending_size_item_id = item.item_id
                    state.pending_size_item_name = item.name
                    state.pending_size_quantity = quantity
                    state.pending_size_options = [opt.size_name for opt in size_options]
                    options_text = self._format_size_options(size_options)
                    return await self._build_response(
                        session_id,
                        Decision(
                            scene="clarify_size",
                            reply_seed=(
                                f"Món {item.name} có các size: {options_text}. "
                                "Bạn chọn size nào để mình thêm vào giỏ?"
                            ),
                            recommended_item_ids=[item.item_id],
                        ),
                        menu,
                    )

                state.cart[item.item_id] = state.cart.get(item.item_id, 0) + quantity
                if selected_size is not None:
                    state.cart_unit_price_by_item[item.item_id] = selected_size.price
                    state.cart_size_by_item[item.item_id] = selected_size.size_name
                    if selected_size.size_id is not None:
                        state.cart_size_id_by_item[item.item_id] = int(selected_size.size_id)
                elif len(size_options) == 1:
                    state.cart_unit_price_by_item[item.item_id] = size_options[0].price
                    state.cart_size_by_item[item.item_id] = size_options[0].size_name
                    if size_options[0].size_id is not None:
                        state.cart_size_id_by_item[item.item_id] = int(size_options[0].size_id)
                state.awaiting_confirmation = contains_any(normalized, CHECKOUT_KEYWORDS)
                scene = "ask_confirmation" if state.awaiting_confirmation else "cart_updated"
                seed = (
                    (
                        f"Mình đã thêm {quantity} {item.name} size {state.cart_size_by_item[item.item_id]} vào giỏ hàng."
                        if state.cart_size_by_item.get(item.item_id)
                        else f"Mình đã thêm {quantity} {item.name} vào giỏ hàng."
                    )
                    if not state.awaiting_confirmation
                    else (
                        f"Mình đã thêm {quantity} {item.name}"
                        f"{' size ' + state.cart_size_by_item[item.item_id] if state.cart_size_by_item.get(item.item_id) else ''}. "
                        "Mình đọc lại giỏ hàng để bạn xác nhận nhé."
                    )
                )
                return await self._build_response(
                    session_id,
                    Decision(
                        scene=scene,
                        reply_seed=seed,
                        needs_confirmation=state.awaiting_confirmation,
                        recommended_item_ids=[item.item_id],
                    ),
                    menu,
                )

            # Multiple matches below auto-add threshold -> ask for clarification
            return await self._build_response(
                session_id,
                Decision(
                    scene="clarify_item",
                    reply_seed="Mình thấy có mấy món gần giống. Bạn muốn gọi món nào?",
                    recommended_item_ids=[item.item_id for item, _ in available_matches[:3]],
                ),
                menu,
            )

        ranked_items = self._rank_items(normalized, menu)[:3]
        if (
            has_ordering_hint
            and ranked_items
            and ranked_items[0].score >= _MIN_RANK_SCORE_FOR_RECOMMENDATION
        ):
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed="Mình có vài gợi ý để uống, để chọn cho bạn đây.",
                    recommended_item_ids=[candidate.item.item_id for candidate in ranked_items],
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        if _is_specific_item_request_text(normalized):
            top_available_items = [item for item in menu if item.available][:3]
            fallback_recommendations = (
                [candidate.item.item_id for candidate in ranked_items]
                if ranked_items
                else [item.item_id for item in top_available_items]
            )
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed=(
                        "Xin lỗi, món bạn vừa nhắc tới hiện chưa có trong menu. "
                        "Mình gợi ý vài món đang phục vụ để bạn chọn nhé."
                    ),
                    recommended_item_ids=fallback_recommendations,
                    user_text=transcript,
                ),
                menu,
                turn_id=turn_id,
            )

        if state.cart:
            return await self._build_response(
                session_id,
                Decision(
                    scene="cart_follow_up",
                    reply_seed="Mình chưa nghe rõ món mới. Giỏ hàng của bạn vẫn đang có sẵn, bạn muốn mình đọc lại để xác nhận không?",
                ),
                menu,
                turn_id=turn_id,
            )

        return await self._build_response(
            session_id,
            Decision(
                scene="fallback",
                reply_seed="Mình nghe chưa rõ. Bạn có thể nói tên món, khẩu vị như ít ngọt, hoặc bảo mình tư vấn món để uống nhé.",
                user_text=transcript,
            ),
            menu,
            turn_id=turn_id,
        )

    def _match_explicit_items(self, normalized_transcript: str, menu: list[MenuItem]) -> list[tuple[MenuItem, float]]:
        """Match menu items using exact, token-based, and fuzzy matching.
        Returns list of (MenuItem, confidence) tuples where confidence is 0.0-1.0.
        """
        exact_matches: list[tuple[MenuItem, float]] = []
        fuzzy_matches: list[tuple[MenuItem, float]] = []
        matched_ids: set[str] = set()
        
        # Apply STT alias corrections to the transcript
        corrected = _apply_stt_aliases(normalized_transcript)
        transcript_candidates = [normalized_transcript, corrected]
        transcript_candidates = [candidate for candidate in dict.fromkeys(transcript_candidates) if candidate]
        
        for item in menu:
            if item.item_id in matched_ids:
                continue
            normalized_name = normalize_text(item.name)
            
            # 1. Exact substring match -> confidence 1.0
            if any(normalized_name in candidate for candidate in transcript_candidates):
                exact_matches.append((item, 1.0))
                matched_ids.add(item.item_id)
                continue
            
            # 2. Token-based match (all significant tokens present) -> confidence 0.95
            name_tokens = [token for token in normalized_name.split() if len(token) > 2]
            if name_tokens and any(all(token in candidate for token in name_tokens) for candidate in transcript_candidates):
                exact_matches.append((item, 0.95))
                matched_ids.add(item.item_id)
                continue
            
            # 3. Fuzzy match -> confidence = actual similarity ratio
            ratio = max(_fuzzy_match_ratio(candidate, normalized_name) for candidate in transcript_candidates)
            if ratio >= _FUZZY_THRESHOLD:
                fuzzy_matches.append((item, ratio))
                matched_ids.add(item.item_id)
        
        # Prioritize exact/token matches over fuzzy
        if exact_matches:
            exact_matches.sort(key=lambda x: -len(x[0].name))
            filtered: list[tuple[MenuItem, float]] = []
            for m, conf in exact_matches:
                if not any(normalize_text(m.name) in normalize_text(kept.name) for kept, _ in filtered):
                    filtered.append((m, conf))
            return filtered
            
        return fuzzy_matches

    def _extract_segment_matches(
        self,
        normalized_transcript: str,
        menu: list[MenuItem],
    ) -> list[tuple[MenuItem, int]]:
        segments = [
            segment.strip()
            for segment in SEGMENT_SPLIT_PATTERN.split(normalized_transcript)
            if segment.strip()
        ]
        if len(segments) <= 1:
            return []

        aggregated: dict[str, tuple[MenuItem, int]] = {}
        for segment in segments:
            matches = [(item, conf) for item, conf in self._match_explicit_items(segment, menu) if item.available]
            if len(matches) != 1:
                continue

            item, _conf = matches[0]
            quantity = extract_quantity(segment, item_name=normalize_text(item.name))
            existing = aggregated.get(item.item_id)
            aggregated[item.item_id] = (
                item,
                quantity if existing is None else existing[1] + quantity,
            )

        return list(aggregated.values())

    def _rank_items(self, normalized_transcript: str, menu: list[MenuItem]) -> list[Candidate]:
        scores: list[Candidate] = []
        tokens = [token for token in normalized_transcript.split() if token]
        corrected = _apply_stt_aliases(normalized_transcript)
        corrected_tokens = [token for token in corrected.split() if token]
        
        for item in menu:
            if not item.available:
                continue
            haystack = " ".join(
                [
                    normalize_text(item.name),
                    normalize_text(item.category),
                    normalize_text(item.description),
                    " ".join(normalize_text(tag) for tag in item.tags),
                ]
            )
            normalized_name = normalize_text(item.name)
            score = 0
            
            # Score using both original and corrected tokens
            for token in set(tokens + corrected_tokens):
                if len(token) <= 2:
                    continue
                if token in haystack:
                    score += 2
                if token in normalized_name:
                    score += 4
                if token in " ".join(normalize_text(tag) for tag in item.tags):
                    score += 3
            
            # Bonus for fuzzy name match
            if _fuzzy_match(corrected, normalized_name):
                score += 8
            
            # Only include items with actual token matches (no free base score)
            if score > 0:
                scores.append(Candidate(item=item, score=score))
        scores.sort(key=lambda candidate: (-candidate.score, candidate.item.name))
        return scores

    def _remove_from_cart(self, state: SessionState, normalized_transcript: str, menu: list[MenuItem]) -> str | None:
        menu_map = {item.item_id: item for item in menu}
        for item, _conf in self._match_explicit_items(normalized_transcript, menu):
            if item.item_id in state.cart:
                quantity_to_remove = extract_quantity(normalized_transcript, item_name=normalize_text(item.name))
                remaining = state.cart[item.item_id] - quantity_to_remove
                if remaining > 0:
                    state.cart[item.item_id] = remaining
                else:
                    del state.cart[item.item_id]
                    state.cart_unit_price_by_item.pop(item.item_id, None)
                    state.cart_size_by_item.pop(item.item_id, None)
                    state.cart_size_id_by_item.pop(item.item_id, None)
                state.awaiting_confirmation = False
                if quantity_to_remove > 1:
                    return f"{quantity_to_remove} {item.name}"
                return item.name

        if state.cart:
            if not _is_generic_remove_request_text(normalized_transcript):
                return None
            last_item_id = next(reversed(state.cart))
            item_name = menu_map.get(last_item_id).name if last_item_id in menu_map else "món vừa chọn"
            quantity_to_remove = extract_quantity(normalized_transcript)
            remaining = state.cart[last_item_id] - quantity_to_remove
            if remaining > 0:
                state.cart[last_item_id] = remaining
            else:
                del state.cart[last_item_id]
                state.cart_unit_price_by_item.pop(last_item_id, None)
                state.cart_size_by_item.pop(last_item_id, None)
                state.cart_size_id_by_item.pop(last_item_id, None)
            state.awaiting_confirmation = False
            if quantity_to_remove > 1:
                return f"{quantity_to_remove} {item_name}"
            return item_name
        return None

    def _prune_non_orderable_cart_items(self, state: SessionState, menu: list[MenuItem]) -> list[str]:
        menu_map = {item.item_id: item for item in menu}
        removed: list[str] = []
        for item_id in list(state.cart.keys()):
            menu_item = menu_map.get(item_id)
            if menu_item is None:
                removed.append(item_id.replace("-", " "))
                del state.cart[item_id]
                state.cart_unit_price_by_item.pop(item_id, None)
                state.cart_size_by_item.pop(item_id, None)
                state.cart_size_id_by_item.pop(item_id, None)
                continue
            if not menu_item.available:
                removed.append(menu_item.name)
                del state.cart[item_id]
                state.cart_unit_price_by_item.pop(item_id, None)
                state.cart_size_by_item.pop(item_id, None)
                state.cart_size_id_by_item.pop(item_id, None)
        if removed:
            state.awaiting_confirmation = False
        return removed

    async def handle_turn_stream(
        self,
        session_id: str,
        transcript: str,
        turn_id: str | None = None,
        include_audio: bool = True,
        quick_checkout: bool = False,
    ):
        """Stream conversation response with incremental text and optional audio chunks."""
        local_only_turn_id = str(turn_id or "").strip()
        if local_only_turn_id:
            self._local_only_turn_ids.add(local_only_turn_id)
        try:
            response = await self.handle_turn(
                session_id,
                transcript,
                turn_id=turn_id,
                quick_checkout=quick_checkout,
            )
        finally:
            if local_only_turn_id:
                self._local_only_turn_ids.discard(local_only_turn_id)

        final_reply_text = ensure_frontend_safe_reply(response.scene or "fallback", response.reply_text)
        bridge_source = "local_rule"
        streamed_any = False

        should_stream_from_bridge, bridge_reason = self._should_use_bridge(
            scene=response.scene or "",
            raw_user_text=transcript,
            normalized_user_text=normalize_text(transcript),
            recommended_count=len(response.recommended_item_ids),
            force_local=False,
        )
        if self.provider_client is not None and should_stream_from_bridge:
            try:
                prompt_payload = await self._build_stream_prompt_payload(response, transcript)
                streamed_parts: list[str] = []
                async for part in self.provider_client.compose_reply_stream(
                    prompt_payload,
                    session_id=session_id,
                    turn_id=turn_id,
                    latest_wins=True,
                ):
                    clean_part = ensure_frontend_safe_reply(response.scene or "fallback", part).strip()
                    if not clean_part:
                        continue
                    streamed_parts.append(clean_part)
                    streamed_any = True
                    yield {
                        "type": "text",
                        "content": clean_part,
                        "session_id": session_id,
                        "turn_id": turn_id,
                    }
                if streamed_parts:
                    final_reply_text = merge_stream_parts(streamed_parts)
                    bridge_source = "bridge_stream"
            except Exception as exc:
                bridge_source = "fallback"
                logger.warning(
                    "bridge_stream_failed session_id=%s turn_id=%s scene=%s error=%s",
                    session_id,
                    turn_id or "",
                    response.scene or "",
                    exc,
                )
                yield {
                    "type": "error",
                    "code": "bridge_stream_error",
                    "message": str(exc),
                    "session_id": session_id,
                    "turn_id": turn_id,
                }
        elif (response.scene or "") in COMPLEX_SCENES:
            logger.info(
                "bridge_stream_skipped reason=%s session_id=%s turn_id=%s scene=%s",
                bridge_reason,
                session_id,
                turn_id or "",
                response.scene or "",
            )

        if not streamed_any:
            for segment in chunk_text_for_stream(final_reply_text):
                yield {
                    "type": "text",
                    "content": segment,
                    "session_id": session_id,
                    "turn_id": turn_id,
                }

        response.reply_text = final_reply_text
        yield {
            "type": "text_final",
            "content": final_reply_text,
            "session_id": session_id,
            "turn_id": turn_id,
            "bridge_source": bridge_source,
            "cart": [item.model_dump() for item in response.cart],
            "scene": response.scene,
            "recommended_item_ids": list(response.recommended_item_ids),
            "needs_confirmation": response.needs_confirmation,
            "emotion_hint": response.emotion_hint,
            "action_hints": list(response.action_hints),
            "order_created": response.order_created,
            "order_id": response.order_id,
            "payment_status": response.payment_status,
            "payment_qr_content": response.payment_qr_content,
            "payment_qr_image_url": response.payment_qr_image_url,
            "payment_amount": str(response.payment_amount) if response.payment_amount is not None else None,
            "payment_expires_at": response.payment_expires_at.isoformat() if response.payment_expires_at else None,
            "sync_error_code": response.sync_error_code,
            "sync_error_detail": response.sync_error_detail,
        }

        # Stream audio with the shared service so we keep runtime caches warm.
        if not include_audio or self.speech_service is None:
            return

        try:
            tts_started_at = time.perf_counter()
            first_chunk_logged = False
            async for audio_chunk in self.speech_service.synthesize_stream(final_reply_text):
                if not first_chunk_logged:
                    first_chunk_logged = True
                    logger.info(
                        "tts_first_chunk_ms=%s session_id=%s turn_id=%s",
                        int((time.perf_counter() - tts_started_at) * 1000),
                        session_id,
                        turn_id or "",
                    )
                yield {
                    "type": "audio",
                    "content": base64.b64encode(audio_chunk).decode("ascii"),
                    "session_id": session_id,
                    "turn_id": turn_id,
                }
        except Exception:
            pass

    async def _build_stream_prompt_payload(
        self,
        response: ConversationResponse,
        transcript: str,
    ) -> dict[str, object]:
        menu = await self._get_menu()
        recommended_ids = set(response.recommended_item_ids or [])
        return {
            "scene": response.scene,
            "seed": ensure_frontend_safe_reply(response.scene or "fallback", response.reply_text),
            "cart_summary": [
                {
                    "name": item.name,
                    "quantity": item.quantity,
                    "line_total": str(item.line_total),
                }
                for item in response.cart
            ],
            "recommended_items": [
                item.model_dump(mode="json")
                for item in menu
                if item.item_id in recommended_ids
            ],
            "needs_confirmation": response.needs_confirmation,
            "order_created": response.order_created,
            "voice_style": response.voice_style or self.settings.voice_style,
            "user_text": transcript,
        }

    async def save_feedback(
        self,
        session_id: str,
        rating: int,
        comment: str | None,
        transcript_history: list[str],
        needs_improvement: bool | None = None,
        improvement_tags: list[str] | None = None,
        review_status: str = "new",
    ) -> None:
        """Save feedback and transcript logs to local JSONL for analytics."""
        async with self.lock:
            # We don't read from state.history because frontend sends the full synced transcript_history, removing any async timing mismatch
            pass

        normalized_comment = repair_mojibake_text(comment or "").strip() or None
        normalized_transcript_history = self._normalize_feedback_transcript_history(transcript_history)
        normalized_review_status = self._normalize_feedback_review_status(review_status)
        auto_tags, auto_notes = self._analyze_feedback_issues(
            rating=rating,
            comment=normalized_comment,
            transcript_history=normalized_transcript_history,
        )
        manual_tags = [
            normalize_text(tag).replace(" ", "_")
            for tag in (improvement_tags or [])
            if isinstance(tag, str) and tag.strip()
        ]
        merged_tags = sorted(set(auto_tags + manual_tags))
        final_needs_improvement = bool(merged_tags) if needs_improvement is None else bool(needs_improvement)

        feedback_data = {
            "session_id": session_id,
            "rating": rating,
            "comment": normalized_comment,
            "transcript_history": normalized_transcript_history,
            "needs_improvement": final_needs_improvement,
            "improvement_tags": merged_tags,
            "review_status": normalized_review_status,
            "analysis_notes": auto_notes,
            "analysis_version": 2,
            "created_at": datetime.now(UTC).isoformat(),
        }

        backend_root = Path(__file__).resolve().parents[2]
        log_path = backend_root / "data" / "feedback.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(feedback_data, ensure_ascii=False) + "\n")

    async def audit_feedback_log(self) -> dict[str, object]:
        log_path = self._feedback_log_path()
        if not log_path.exists():
            return {
                "path": str(log_path),
                "total_rows": 0,
                "invalid_json_rows": 0,
                "missing_metadata_rows": 0,
                "review_status_counts": {},
                "pending_review_session_ids": [],
            }

        rows = log_path.read_text(encoding="utf-8").splitlines()
        required_keys = {
            "needs_improvement",
            "improvement_tags",
            "review_status",
            "analysis_notes",
            "analysis_version",
        }
        invalid_json_rows = 0
        missing_metadata_rows = 0
        review_status_counter: Counter[str] = Counter()
        pending_review_session_ids: list[str] = []

        for raw_line in rows:
            if not raw_line.strip():
                continue
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                invalid_json_rows += 1
                continue

            if not isinstance(entry, dict):
                invalid_json_rows += 1
                continue

            if any(key not in entry for key in required_keys):
                missing_metadata_rows += 1

            review_status = self._normalize_feedback_review_status(str(entry.get("review_status", "new")))
            review_status_counter[review_status] += 1
            if review_status == "new":
                session_id = str(entry.get("session_id", "")).strip()
                if session_id:
                    pending_review_session_ids.append(session_id)

        return {
            "path": str(log_path),
            "total_rows": len(rows),
            "invalid_json_rows": invalid_json_rows,
            "missing_metadata_rows": missing_metadata_rows,
            "review_status_counts": dict(review_status_counter),
            "pending_review_session_ids": pending_review_session_ids,
        }

    async def repair_feedback_log(self) -> dict[str, object]:
        async with self.lock:
            log_path = self._feedback_log_path()
            if not log_path.exists():
                return {
                    "path": str(log_path),
                    "total_rows": 0,
                    "repaired_rows": 0,
                    "invalid_json_rows": 0,
                    "backup_path": "",
                }

            raw_lines = log_path.read_text(encoding="utf-8").splitlines()
            required_keys = {
                "needs_improvement",
                "improvement_tags",
                "review_status",
                "analysis_notes",
                "analysis_version",
            }
            repaired_lines: list[str] = []
            repaired_rows = 0
            invalid_json_rows = 0

            for raw_line in raw_lines:
                if not raw_line.strip():
                    continue
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    invalid_json_rows += 1
                    continue
                if not isinstance(entry, dict):
                    invalid_json_rows += 1
                    continue

                before = json.dumps(entry, ensure_ascii=False, sort_keys=True)
                rating = int(entry.get("rating", 5) or 5)
                comment = repair_mojibake_text(str(entry.get("comment", "") or "")).strip() or None
                transcript_history = self._normalize_feedback_transcript_history(
                    [str(item) for item in (entry.get("transcript_history") or []) if isinstance(item, str) or item is not None],
                )

                manual_tags = [
                    normalize_text(tag).replace(" ", "_")
                    for tag in (entry.get("improvement_tags") or [])
                    if isinstance(tag, str) and tag.strip()
                ]
                auto_tags, auto_notes = self._analyze_feedback_issues(
                    rating=rating,
                    comment=comment,
                    transcript_history=transcript_history,
                )
                merged_tags = sorted(set(auto_tags + manual_tags))

                repaired_entry = dict(entry)
                repaired_entry["comment"] = comment
                repaired_entry["transcript_history"] = transcript_history
                repaired_entry["improvement_tags"] = merged_tags
                repaired_entry["needs_improvement"] = bool(merged_tags) if repaired_entry.get("needs_improvement") is None else bool(repaired_entry.get("needs_improvement"))
                repaired_entry["review_status"] = self._normalize_feedback_review_status(
                    str(repaired_entry.get("review_status", "new")),
                )
                repaired_entry["analysis_notes"] = auto_notes
                repaired_entry["analysis_version"] = 2
                if not repaired_entry.get("created_at"):
                    repaired_entry["created_at"] = datetime.now(UTC).isoformat()
                for key in required_keys:
                    repaired_entry.setdefault(key, [] if key in {"improvement_tags", "analysis_notes"} else ("new" if key == "review_status" else False))

                after = json.dumps(repaired_entry, ensure_ascii=False, sort_keys=True)
                if after != before:
                    repaired_rows += 1
                repaired_lines.append(json.dumps(repaired_entry, ensure_ascii=False))

            backup_path = log_path.with_suffix(".jsonl.bak")
            backup_path.write_text("\n".join(raw_lines) + ("\n" if raw_lines else ""), encoding="utf-8")
            log_path.write_text("\n".join(repaired_lines) + ("\n" if repaired_lines else ""), encoding="utf-8")

            return {
                "path": str(log_path),
                "total_rows": len(raw_lines),
                "repaired_rows": repaired_rows,
                "invalid_json_rows": invalid_json_rows,
                "backup_path": str(backup_path),
            }

    async def triage_feedback_log(self, *, only_new: bool = True) -> dict[str, object]:
        async with self.lock:
            log_path = self._feedback_log_path()
            if not log_path.exists():
                return {
                    "path": str(log_path),
                    "total_rows": 0,
                    "triaged_rows": 0,
                    "skipped_rows": 0,
                    "backup_path": "",
                }

            raw_lines = log_path.read_text(encoding="utf-8").splitlines()
            triaged_rows = 0
            skipped_rows = 0
            next_lines: list[str] = []

            for raw_line in raw_lines:
                if not raw_line.strip():
                    continue
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    # Keep malformed rows untouched so we never destroy original evidence.
                    skipped_rows += 1
                    next_lines.append(raw_line)
                    continue
                if not isinstance(entry, dict):
                    skipped_rows += 1
                    next_lines.append(raw_line)
                    continue

                current_status = self._normalize_feedback_review_status(str(entry.get("review_status", "new")))
                if only_new and current_status != "new":
                    skipped_rows += 1
                    next_lines.append(json.dumps(entry, ensure_ascii=False))
                    continue

                rating = int(entry.get("rating", 5) or 5)
                comment = repair_mojibake_text(str(entry.get("comment", "") or "")).strip() or None
                transcript_history = self._normalize_feedback_transcript_history(
                    [
                        str(item)
                        for item in (entry.get("transcript_history") or [])
                        if isinstance(item, str) or item is not None
                    ],
                )
                auto_tags, auto_notes = self._analyze_feedback_issues(
                    rating=rating,
                    comment=comment,
                    transcript_history=transcript_history,
                )
                manual_tags = [
                    normalize_text(tag).replace(" ", "_")
                    for tag in (entry.get("improvement_tags") or [])
                    if isinstance(tag, str) and tag.strip()
                ]
                merged_tags = sorted(set(auto_tags + manual_tags))

                repaired_entry = dict(entry)
                repaired_entry["comment"] = comment
                repaired_entry["transcript_history"] = transcript_history
                repaired_entry["improvement_tags"] = merged_tags
                repaired_entry["needs_improvement"] = bool(repaired_entry.get("needs_improvement")) or bool(merged_tags)
                repaired_entry["review_status"] = "triaged"
                repaired_entry["analysis_notes"] = auto_notes
                repaired_entry["analysis_version"] = max(3, int(repaired_entry.get("analysis_version", 1) or 1))
                repaired_entry["triaged_at"] = datetime.now(UTC).isoformat()
                if not repaired_entry.get("created_at"):
                    repaired_entry["created_at"] = datetime.now(UTC).isoformat()

                triaged_rows += 1
                next_lines.append(json.dumps(repaired_entry, ensure_ascii=False))

            backup_path = log_path.with_suffix(".jsonl.triage-latest.bak")
            backup_path.write_text(
                "\n".join(raw_lines) + ("\n" if raw_lines else ""),
                encoding="utf-8",
            )
            log_path.write_text(
                "\n".join(next_lines) + ("\n" if next_lines else ""),
                encoding="utf-8",
            )

            return {
                "path": str(log_path),
                "total_rows": len(raw_lines),
                "triaged_rows": triaged_rows,
                "skipped_rows": skipped_rows,
                "only_new": only_new,
                "backup_path": str(backup_path),
            }

    @staticmethod
    def _feedback_log_path() -> Path:
        backend_root = Path(__file__).resolve().parents[2]
        return backend_root / "data" / "feedback.jsonl"

    @staticmethod
    def _normalize_feedback_review_status(review_status: str | None) -> str:
        value = str(review_status or "").strip().lower()
        if value in {"new", "triaged", "resolved"}:
            return value
        return "new"

    @staticmethod
    def _normalize_feedback_transcript_history(transcript_history: list[str]) -> list[str]:
        normalized_lines: list[str] = []
        for raw_line in transcript_history:
            cleaned = repair_mojibake_text(raw_line).strip()
            if cleaned:
                normalized_lines.append(cleaned)
        return normalized_lines

    def _analyze_feedback_issues(
        self,
        rating: int,
        comment: str | None,
        transcript_history: list[str],
    ) -> tuple[list[str], list[str]]:
        tags: set[str] = set()
        notes: list[str] = []

        normalized_comment = normalize_text(comment or "")
        if rating <= 3:
            tags.add("low_rating")
            notes.append(f"rating={rating} <= 3")

        if normalized_comment:
            if any(term in normalized_comment for term in ("cham", "lag", "tre", "ket noi", "reconnect")):
                tags.add("latency_or_connection")
                notes.append("comment indicates latency/connection issue")
            if any(term in normalized_comment for term in ("loi", "sai", "khong nghe", "diec")):
                tags.add("recognition_or_logic_issue")
                notes.append("comment indicates recognition/logic issue")

        user_messages = self._extract_role_messages(transcript_history, "user")
        user_counter = Counter(user_messages)
        parsed_lines = self._extract_feedback_lines_raw(transcript_history)

        mismatch_count = 0
        ack_loop_count = 0
        repeated_unclear_count = 0
        corrupted_text_count = 0

        for user_text, assistant_text in self._iter_user_assistant_pairs(transcript_history):
            user_normalized = normalize_text(user_text)
            assistant_normalized = normalize_text(assistant_text)

            user_remove = contains_any(user_normalized, REMOVE_KEYWORDS)
            user_add = contains_any(user_normalized, ADD_INTENT_KEYWORDS)
            assistant_add = contains_any_fragment(assistant_normalized, ASSISTANT_ADD_MARKERS)
            assistant_remove = contains_any_fragment(assistant_normalized, ASSISTANT_REMOVE_MARKERS)

            if (user_remove and assistant_add) or (user_add and assistant_remove):
                mismatch_count += 1

            if user_normalized in SHORT_ACK_USER_WORDS and contains_any_fragment(
                assistant_normalized,
                ASSISTANT_GENERIC_PROMPT_MARKERS,
            ):
                ack_loop_count += 1

        # Detect repeated "I can't hear/understand" loops.
        for line in parsed_lines:
            if line["role"] != "assistant":
                continue
            assistant_normalized = normalize_text(str(line.get("content") or ""))
            if (
                "nghe chua ro" in assistant_normalized
                or "chua hieu y ban" in assistant_normalized
                or "thu noi ten mon" in assistant_normalized
            ):
                repeated_unclear_count += 1

        # Detect text rendering/spacing corruption in assistant lines.
        for line in parsed_lines:
            if line["role"] != "assistant":
                continue
            content = str(line.get("content") or "").strip()
            if not content:
                continue
            repaired = _repair_vietnamese_spacing_text(content)
            if repaired and repaired != content:
                corrupted_text_count += 1

        if mismatch_count > 0:
            tags.add("intent_action_mismatch")
            notes.append(f"found {mismatch_count} add/remove mismatched turn(s)")

        repeated_remove_user_inputs = sum(
            count
            for text, count in user_counter.items()
            if count > 1 and contains_any(text, REMOVE_KEYWORDS)
        )
        if repeated_remove_user_inputs > 1:
            tags.add("repeated_remove_command")
            notes.append("user had repeated remove commands")

        if ack_loop_count >= 2:
            tags.add("conversation_loop")
            notes.append("multiple short-acknowledgement loops detected")

        if repeated_unclear_count >= 2:
            tags.add("repeated_unclear_response")
            notes.append(f"assistant repeated unclear-response {repeated_unclear_count} times")

        if corrupted_text_count > 0:
            tags.add("text_render_corruption")
            notes.append(f"found {corrupted_text_count} corrupted assistant line(s)")

        # Consecutive assistant lines at the beginning usually indicate duplicate auto-greeting.
        if len(parsed_lines) >= 2 and parsed_lines[0]["role"] == "assistant" and parsed_lines[1]["role"] == "assistant":
            tags.add("duplicate_greeting")
            notes.append("detected consecutive assistant greetings at session start")

        return sorted(tags), notes

    @staticmethod
    def _extract_role_messages(transcript_history: list[str], target_role: str) -> list[str]:
        messages: list[str] = []
        for raw in transcript_history:
            role, content = split_feedback_line(raw)
            if role == target_role and content:
                messages.append(content)
        return messages

    @staticmethod
    def _iter_user_assistant_pairs(transcript_history: list[str]) -> list[tuple[str, str]]:
        pairs: list[tuple[str, str]] = []
        pending_user: str | None = None
        for raw in transcript_history:
            role, content = split_feedback_line(raw)
            if role == "user":
                pending_user = content
                continue
            if role == "assistant" and pending_user:
                pairs.append((pending_user, content))
                pending_user = None
        return pairs

    @staticmethod
    def _extract_feedback_lines_raw(transcript_history: list[str]) -> list[dict[str, str]]:
        lines: list[dict[str, str]] = []
        for raw in transcript_history:
            role, content = split_feedback_line_raw(raw)
            if not role or not content:
                continue
            lines.append({"role": role, "content": content})
        return lines

    async def active_session_count(self) -> int:
        async with self.lock:
            self._cleanup_expired_sessions()
            return len(self.sessions)

    @staticmethod
    def _make_quick_reply_cache_key(scene: str, normalized_user_text: str) -> str:
        return f"{scene}:{normalized_user_text}"

    def _load_quick_reply_cache(
        self,
        *,
        scene: str,
        normalized_user_text: str,
    ) -> tuple[str, str] | None:
        if scene not in QUICK_REPLY_CACHE_SCENES or not normalized_user_text:
            return None
        cache_key = self._make_quick_reply_cache_key(scene, normalized_user_text)
        cached = self._quick_reply_cache.get(cache_key)
        if not cached:
            return None

        cached_at, cached_text, cached_voice_style = cached
        if (time.monotonic() - cached_at) > QUICK_REPLY_CACHE_TTL_SECONDS:
            self._quick_reply_cache.pop(cache_key, None)
            return None
        return cached_text, cached_voice_style

    def _save_quick_reply_cache(
        self,
        *,
        scene: str,
        normalized_user_text: str,
        reply_text: str,
        voice_style: str,
    ) -> None:
        if scene not in QUICK_REPLY_CACHE_SCENES or not normalized_user_text or not reply_text:
            return

        cache_key = self._make_quick_reply_cache_key(scene, normalized_user_text)
        self._quick_reply_cache[cache_key] = (time.monotonic(), reply_text, voice_style)
        if len(self._quick_reply_cache) <= QUICK_REPLY_CACHE_MAX_SIZE:
            return

        # Keep cache bounded with a cheap LRU-ish trim by insertion order.
        overflow = len(self._quick_reply_cache) - QUICK_REPLY_CACHE_MAX_SIZE
        for stale_key in list(self._quick_reply_cache.keys())[:overflow]:
            self._quick_reply_cache.pop(stale_key, None)

    def _try_static_keyword_reply(
        self,
        *,
        scene: str,
        normalized_user_text: str,
        menu: list[MenuItem],
    ) -> tuple[str, str] | None:
        if not normalized_user_text:
            return None
        if len(normalized_user_text) > STATIC_CACHE_MAX_QUERY_CHARS:
            return None

        if contains_any(normalized_user_text, STATIC_CACHE_GREETING_KEYWORDS):
            return (
                "Xin chào! Em là Order Robot. Hôm nay anh/chị muốn thử món nào để em tư vấn nhanh?",
                self.settings.voice_style,
            )

        if contains_any(normalized_user_text, STATIC_CACHE_MENU_KEYWORDS):
            top_items = [item.name for item in menu[:3]]
            if top_items:
                listed = ", ".join(top_items)
                return (
                    f"Menu hôm nay có {listed}. Anh/chị muốn em gợi ý món dễ uống, ít ngọt hay đang hot?",
                    self.settings.voice_style,
                )
            return (
                "Menu hôm nay đã sẵn sàng. Anh/chị muốn xem nhóm trà trái cây, latte hay cà phê?",
                self.settings.voice_style,
            )

        if scene in {"ask_confirmation", "cart_follow_up", "fallback"} and contains_any(
            normalized_user_text, STATIC_CACHE_CONFIRM_KEYWORDS
        ):
            return (
                "Dạ rõ. Em xác nhận đơn ngay cho anh/chị và sẽ đọc lại giỏ hàng để mình kiểm tra lần cuối nhé.",
                self.settings.voice_style,
            )
        return None

    def _should_use_bridge(
        self,
        *,
        scene: str,
        raw_user_text: str,
        normalized_user_text: str,
        recommended_count: int,
        force_local: bool,
    ) -> tuple[bool, str]:
        if force_local:
            return False, "forced_local_turn"
        if self.provider_client is None:
            return False, "provider_disabled"
        if scene not in COMPLEX_SCENES:
            return False, "simple_scene"
        if scene in BRIDGE_LOCAL_ONLY_SCENES:
            return False, "scene_local_fastpath"

        if not normalized_user_text:
            return scene == "recommendation" and recommended_count <= 0, "empty_user_text"

        token_count = len(normalized_user_text.split())
        char_count = len(normalized_user_text)
        contains_escalation_keyword = contains_any(normalized_user_text, BRIDGE_ESCALATION_KEYWORDS)
        has_long_or_hard_pattern = (
            token_count >= BRIDGE_LONG_QUERY_WORDS_THRESHOLD
            or char_count >= BRIDGE_LONG_QUERY_CHARS_THRESHOLD
        )

        if contains_escalation_keyword:
            return True, "escalation_keyword"

        if scene == "recommendation":
            if _is_non_ordering_request_text(normalized_user_text):
                return True, "recommendation_non_ordering_query"
            if recommended_count > 0 and not has_long_or_hard_pattern:
                return False, "recommendation_local_match"
            if has_long_or_hard_pattern:
                return True, "recommendation_long_query"
            return recommended_count <= 0, "recommendation_no_match"

        if scene == "fallback":
            if _contains_profanity_text(normalized_user_text):
                return True, "fallback_profanity"
            if _is_chitchat(normalized_user_text):
                return True, "fallback_chitchat"
            if has_long_or_hard_pattern:
                return True, "fallback_long_query"
            if token_count >= 2:
                return True, "fallback_contextual_short"
            return False, "fallback_local_short_noise"

        if scene == "greeting":
            if _is_simple_greeting_text(normalized_user_text):
                return False, "greeting_simple_local"
            return True, "greeting_contextual"

        return False, "default_local"

    def _cleanup_expired_sessions(self) -> None:
        now = datetime.now(UTC)
        ttl = timedelta(minutes=self.settings.session_timeout_minutes)
        expired_session_ids = [
            session_id
            for session_id, state in self.sessions.items()
            if now - state.last_interaction_at > ttl
        ]
        for session_id in expired_session_ids:
            del self.sessions[session_id]

    @staticmethod
    def _touch_state(state: SessionState) -> None:
        state.last_interaction_at = datetime.now(UTC)

    @staticmethod
    def _map_scene_to_emotion(scene: str) -> str:
        mapping = {
            "greeting_intro": "cute",
            "greeting": "happy",
            "cart_updated": "happy",
            "ask_confirmation": "focused",
            "order_created": "excited",
            "recommendation": "focused",
            "clarify_item": "focused",
            "clarify_size": "focused",
            "remove_item": "neutral",
            "reset": "neutral",
            "fallback": "neutral",
            "cart_follow_up": "focused",
        }
        return mapping.get(scene, "neutral")

    @staticmethod
    def _map_scene_to_action_hints(scene: str) -> list[str]:
        mapping = {
            "greeting_intro": ["waveHello", "maidCurtseyBloom", "smileBounce"],
            "greeting": ["waveHello", "waiterServingSpin"],
            "cart_updated": ["cheerSparkle"],
            "ask_confirmation": ["nodYes"],
            "order_created": ["confettiBurst", "pixelHeartStorm", "peacePose"],
            "recommendation": ["scan", "lightPulse", "animeStarTrail"],
            "clarify_item": ["scan"],
            "clarify_size": ["scan", "nodYes"],
            "remove_item": ["nodYes"],
            "reset": ["bowElegant"],
            "fallback": ["blushShy"],
            "cart_follow_up": ["lightPulse"],
        }
        return mapping.get(scene, [])

    async def _build_response(
        self,
        session_id: str,
        decision: Decision,
        menu: list[MenuItem] | None = None,
        turn_id: str | None = None,
    ) -> ConversationResponse:
        state = self.sessions[session_id]
        if menu is None:
            menu = await self._get_menu()
        cart = build_cart_items(
            state.cart,
            menu,
            cart_unit_price_by_item=state.cart_unit_price_by_item,
            cart_size_by_item=state.cart_size_by_item,
            cart_size_id_by_item=state.cart_size_id_by_item,
        )
        seed_text = ensure_frontend_safe_reply(decision.scene, decision.reply_seed)
        prompt_payload = {
            "scene": decision.scene,
            "seed": seed_text,
            "cart_summary": [
                {
                    "name": item.name,
                    "quantity": item.quantity,
                    "line_total": str(item.line_total),
                }
                for item in cart
            ],
            "recommended_items": [
                item.model_dump(mode="json")
                for item in menu
                if item.item_id in decision.recommended_item_ids
            ],
            "needs_confirmation": decision.needs_confirmation,
            "order_created": decision.order_created,
            "voice_style": self.settings.voice_style,
        }
        if decision.user_text:
            prompt_payload["user_text"] = decision.user_text

        normalized_user_text = normalize_text(str(decision.user_text or ""))
        is_local_only_turn = bool(turn_id and turn_id in self._local_only_turn_ids)

        static_cached_reply = self._try_static_keyword_reply(
            scene=decision.scene,
            normalized_user_text=normalized_user_text,
            menu=menu,
        )
        cached_reply = self._load_quick_reply_cache(
            scene=decision.scene,
            normalized_user_text=normalized_user_text,
        )
        if static_cached_reply is not None:
            reply_text, voice_style = static_cached_reply
            reply_source = "static_keyword_cache"
            route_reason = "keyword_cache_hit"
        elif cached_reply is not None:
            reply_text, voice_style = cached_reply
            reply_source = "quick_cache"
            route_reason = "cache_hit"
        else:
            should_use_bridge, route_reason = self._should_use_bridge(
                scene=decision.scene,
                raw_user_text=str(decision.user_text or ""),
                normalized_user_text=normalized_user_text,
                recommended_count=len(decision.recommended_item_ids),
                force_local=is_local_only_turn,
            )

            if should_use_bridge and self.provider_client is None:
                reply_text = render_lite_bridge_required_reply(prompt_payload)
                voice_style = self.settings.voice_style
                reply_source = "fallback"
                route_reason = "bridge_required_lite_reply"

            elif self.provider_client is not None and should_use_bridge:
                try:
                    bridge_started_at = time.perf_counter()
                    scene_budget = BRIDGE_SCENE_BUDGET_SECONDS.get(decision.scene, 3.5)
                    bridge_budget = max(
                        2.2,
                        min(scene_budget, self.settings.bridge_timeout_seconds, BRIDGE_RESPONSE_BUDGET_SECONDS),
                    )
                    async with asyncio.timeout(bridge_budget):
                        provider_reply = await self.provider_client.compose_reply(
                            prompt_payload,
                            session_id=session_id,
                            turn_id=turn_id,
                            latest_wins=True,
                        )
                    reply_text = provider_reply["reply_text"]
                    voice_style = provider_reply.get("voice_style", self.settings.voice_style)
                    reply_source = str(provider_reply.get("source") or "bridge")
                    reply_reason = str(provider_reply.get("reason") or "")
                    route_reason = route_reason or "bridge_route"
                    logger.info(
                        "bridge_ms=%s bridge_budget_ms=%s bridge_source=%s bridge_reason=%s session_id=%s turn_id=%s scene=%s",
                        int((time.perf_counter() - bridge_started_at) * 1000),
                        int(bridge_budget * 1000),
                        reply_source,
                        reply_reason,
                        session_id,
                        turn_id or "",
                        decision.scene,
                    )
                except TimeoutError:
                    logger.warning(
                        "Bridge call timeout after %ss for scene '%s' session_id=%s turn_id=%s; using local fallback",
                        bridge_budget,
                        decision.scene,
                        session_id,
                        turn_id or "",
                    )
                    reply_text = render_fallback_reply(prompt_payload)
                    voice_style = self.settings.voice_style
                    reply_source = "fallback"
                    route_reason = "bridge_timeout_fallback"
                except Exception as exc:
                    logger.warning("Bridge call failed for scene '%s': %s - using local fallback", decision.scene, exc)
                    reply_text = render_fallback_reply(prompt_payload)
                    voice_style = self.settings.voice_style
                    reply_source = "fallback"
                    route_reason = "bridge_error_fallback"
            else:
                reply_text = render_fallback_reply(prompt_payload)
                voice_style = self.settings.voice_style
                reply_source = "local_rule"

        self._save_quick_reply_cache(
            scene=decision.scene,
            normalized_user_text=normalized_user_text,
            reply_text=str(reply_text or ""),
            voice_style=str(voice_style or self.settings.voice_style),
        )

        reply_text = ensure_frontend_safe_reply(decision.scene, reply_text)
        logger.info(
            "reply_source=%s route_reason=%s scene=%s session_id=%s turn_id=%s",
            reply_source,
            route_reason,
            decision.scene,
            session_id,
            turn_id or "",
        )

        return ConversationResponse(
            session_id=session_id,
            reply_text=reply_text,
            cart=cart,
            recommended_item_ids=decision.recommended_item_ids,
            needs_confirmation=decision.needs_confirmation,
            order_created=decision.order_created,
            order_id=decision.order_id,
            payment_status=decision.payment_status,
            payment_qr_content=decision.payment_qr_content,
            payment_qr_image_url=decision.payment_qr_image_url,
            payment_amount=decision.payment_amount,
            payment_expires_at=decision.payment_expires_at,
            sync_error_code=decision.sync_error_code,
            sync_error_detail=decision.sync_error_detail,
            voice_style=voice_style,
            scene=decision.scene,
            emotion_hint=self._map_scene_to_emotion(decision.scene),
            action_hints=self._map_scene_to_action_hints(decision.scene),
        )


def build_cart_items(
    cart: dict[str, int],
    menu: list[MenuItem],
    *,
    cart_unit_price_by_item: dict[str, Decimal] | None = None,
    cart_size_by_item: dict[str, str] | None = None,
    cart_size_id_by_item: dict[str, int] | None = None,
) -> list[CartItem]:
    menu_map = {item.item_id: item for item in menu}
    unit_price_by_item = cart_unit_price_by_item or {}
    size_by_item = cart_size_by_item or {}
    size_id_by_item = cart_size_id_by_item or {}
    cart_items: list[CartItem] = []
    for item_id, quantity in cart.items():
        if item_id not in menu_map:
            continue
        item = menu_map[item_id]
        unit_price = unit_price_by_item.get(item_id, item.price)
        line_total = unit_price * quantity
        size_name = size_by_item.get(item_id)
        size_id = size_id_by_item.get(item_id)
        display_name = f"{item.name} ({size_name})" if size_name else item.name
        cart_items.append(
            CartItem(
                item_id=item.item_id,
                name=display_name,
                quantity=quantity,
                size_name=size_name,
                size_id=size_id,
                unit_price=unit_price,
                line_total=line_total,
            )
        )
    cart_items.sort(key=lambda item: item.name)
    return cart_items


def contains_any(text: str, keywords: set[str]) -> bool:
    for keyword in keywords:
        if " " in keyword:
            if keyword in text:
                return True
            continue
        if re.search(rf"\b{re.escape(keyword)}\b", text):
            return True
    return False


def contains_any_fragment(text: str, fragments: tuple[str, ...]) -> bool:
    return any(fragment in text for fragment in fragments)


def split_feedback_line(raw_line: str) -> tuple[str, str]:
    line = str(raw_line or "").strip()
    if ":" not in line:
        return "", normalize_text(line)

    role_text, content = line.split(":", 1)
    normalized_role = normalize_text(role_text)
    role = ""
    if normalized_role in {"user", "khach", "customer"}:
        role = "user"
    elif normalized_role in {"assistant", "robot", "bot"}:
        role = "assistant"

    return role, normalize_text(content)


def split_feedback_line_raw(raw_line: str) -> tuple[str, str]:
    line = str(raw_line or "").strip()
    if ":" not in line:
        return "", repair_mojibake_text(line).strip()

    role_text, content = line.split(":", 1)
    normalized_role = normalize_text(role_text)
    role = ""
    if normalized_role in {"user", "khach", "customer"}:
        role = "user"
    elif normalized_role in {"assistant", "robot", "bot"}:
        role = "assistant"

    return role, repair_mojibake_text(content).strip()


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text.casefold())
    stripped = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    stripped = stripped.replace("đ", "d").replace("ð", "d")
    stripped = re.sub(r"[^a-z0-9\s]", " ", stripped)
    return re.sub(r"\s+", " ", stripped).strip()


def _is_chitchat(normalized_text: str) -> bool:
    """Check if input is chitchat/non-ordering conversation."""
    for pattern in _CHITCHAT_PATTERNS:
        if pattern.search(normalized_text):
            return True
    # Very short input (1-2 chars) is usually acknowledgement/noise.
    if len(normalized_text) <= 2:
        return True
    return False


def _is_non_ordering_request_text(normalized_text: str) -> bool:
    if not normalized_text:
        return False
    return any(pattern.search(normalized_text) for pattern in _NON_ORDERING_REQUEST_PATTERNS)


def _is_specific_item_request_text(normalized_text: str) -> bool:
    if not normalized_text:
        return False
    if _is_non_ordering_request_text(normalized_text):
        return False
    if contains_any(normalized_text, RECOMMEND_KEYWORDS):
        return False
    if any(pattern.search(normalized_text) for pattern in _SPECIFIC_ITEM_REQUEST_PATTERNS):
        return True

    tokens = normalized_text.split()
    if len(tokens) < 3:
        return False
    if contains_any(normalized_text, {"menu", "co gi", "mon nao", "giup", "tu van", "goi y"}):
        return False
    return contains_any(normalized_text, {"muon", "goi", "lay", "mua", "them", "an", "uong"})


def _contains_profanity_text(normalized_text: str) -> bool:
    return contains_any(normalized_text, PROFANITY_KEYWORDS)


def _is_generic_remove_request_text(normalized_text: str) -> bool:
    tokens = [token for token in normalized_text.split() if token]
    if not tokens:
        return False
    if not contains_any(normalized_text, REMOVE_KEYWORDS):
        return False
    allowed_tokens = (
        REMOVE_FALLBACK_GENERIC_TOKENS
        | GENERIC_REMOVE_UNIT_WORDS
        | set(QUANTITY_WORDS.keys())
        | {"so", "luong"}
    )
    for token in tokens:
        if token.isdigit():
            continue
        if token in allowed_tokens:
            continue
        return False
    return True


def _is_simple_greeting_text(normalized_text: str) -> bool:
    compact = normalized_text.strip()
    if not compact:
        return False
    if compact in SIMPLE_GREETING_KEYWORDS:
        return True
    words = compact.split()
    if len(words) == 1 and words[0] in SIMPLE_GREETING_KEYWORDS:
        return True
    return False


def _is_short_negative_reply_text(normalized_text: str) -> bool:
    compact = str(normalized_text or "").strip()
    if not compact:
        return False
    if compact in SHORT_NEGATIVE_REPLY_KEYWORDS:
        return True
    tokens = [token for token in compact.split() if token]
    if len(tokens) > 5:
        return False
    soft_tokens = {"khong", "ko", "can", "them", "topping", "thoi", "a", "nhe", "da", "roi", "ok", "oke"}
    return bool(tokens) and all(token in soft_tokens for token in tokens)


def extract_quantity(normalized_text: str, item_name: str | None = None) -> int:
    """Extract quantity from normalized text.
    
    Rules:
    - "so luong X" -> X
    - Digits like "3 ly" -> 3
    - Vietnamese number words ONLY when followed by a unit word (ly, cai, phan...)
      or when they are at the very start followed by a noun.
    - Avoids false positives: "muoi" in "ca phe muoi", "ba" in "banh", "nam" in "nam quoc".
    """
    corrected_text = _apply_stt_aliases(normalized_text)
    unit_words = {"ly", "cai", "phan", "chiec", "to", "dia", "bat", "chai", "lon", "coc", "tach", "suon"}
    tokens = corrected_text.split()

    # Pattern: "so luong X"
    qty_pattern = re.search(r"so luong\s+(\d+)", corrected_text)
    if qty_pattern:
        return max(1, min(int(qty_pattern.group(1)), 20))

    if item_name:
        item_index = _find_subsequence(tokens, item_name.split())
        if item_index is not None:
            quantity = _extract_quantity_near_item(tokens, item_index)
            if quantity is not None:
                return quantity

    # Explicit digit with stronger context to avoid false positives like "phim 300 socola"
    for index, token in enumerate(tokens):
        if not token.isdigit():
            continue
        previous = tokens[index - 1] if index > 0 else ""
        next_token = tokens[index + 1] if index + 1 < len(tokens) else ""
        if previous in QUANTITY_SKIP_PREVIOUS_WORDS:
            continue
        if (
            index == 0
            or previous in QUANTITY_CONTEXT_WORDS
            or next_token in unit_words
            or next_token in GENERIC_NOUN_HINTS
        ):
            return max(1, min(int(token), 20))

    # Vietnamese number words â€” MUST be followed by a unit word to confirm it's a quantity
    for i, token in enumerate(tokens):
        if token in QUANTITY_WORDS:
            previous = tokens[i - 1] if i > 0 else ""
            next_token = tokens[i + 1] if i + 1 < len(tokens) else ""
            if (
                next_token in unit_words
                or next_token in GENERIC_NOUN_HINTS
                or i == 0
                or previous in QUANTITY_CONTEXT_WORDS
            ):
                return QUANTITY_WORDS[token]
    return 1


def _find_subsequence(tokens: list[str], pattern: list[str]) -> int | None:
    if not pattern or len(pattern) > len(tokens):
        return None
    for index in range(len(tokens) - len(pattern) + 1):
        if tokens[index : index + len(pattern)] == pattern:
            return index
    return None


def _extract_quantity_near_item(tokens: list[str], item_index: int) -> int | None:
    for lookback in (1, 2):
        qty_index = item_index - lookback
        if qty_index < 0:
            continue

        token = tokens[qty_index]
        previous = tokens[qty_index - 1] if qty_index - 1 >= 0 else ""
        if previous in QUANTITY_SKIP_PREVIOUS_WORDS:
            continue
        if lookback > 1 and previous and previous not in QUANTITY_CONTEXT_WORDS:
            continue

        if token.isdigit():
            return max(1, min(int(token), 20))
        if token in QUANTITY_WORDS:
            return QUANTITY_WORDS[token]
    return None


def _apply_stt_aliases(text: str) -> str:
    """Apply STT alias corrections to normalized text."""
    result = text
    # Sort by longest key first to avoid partial replacements
    for alias, replacement in sorted(_STT_ALIASES.items(), key=lambda x: -len(x[0])):
        if alias in result:
            result = result.replace(alias, replacement)
    return result


def _fuzzy_match_ratio(transcript: str, item_name: str) -> float:
    """Return best fuzzy match ratio between transcript and item name.
    
    Uses sliding window of item name length across transcript words.
    Returns 0.0-1.0 similarity ratio.
    """
    name_words = item_name.split()
    name_len = len(name_words)
    if name_len == 0:
        return 0.0
    
    transcript_words = transcript.split()
    if len(transcript_words) < 1:
        return 0.0
    
    best_ratio = 0.0
    for start in range(len(transcript_words)):
        for end in range(start + max(1, name_len - 1), min(start + name_len + 2, len(transcript_words) + 1)):
            window = " ".join(transcript_words[start:end])
            ratio = difflib.SequenceMatcher(None, window, item_name).ratio()
            best_ratio = max(best_ratio, ratio)
    
    return best_ratio


def _fuzzy_match(transcript: str, item_name: str) -> bool:
    """Legacy wrapper: returns True if fuzzy ratio >= threshold."""
    return _fuzzy_match_ratio(transcript, item_name) >= _FUZZY_THRESHOLD


def merge_stream_parts(parts: list[str]) -> str:
    merged = ""
    for raw_part in parts:
        part = str(raw_part or "").strip()
        if not part:
            continue
        if not merged:
            merged = part
            continue
        if part[0] in ".,!?;:)":
            merged += part
        else:
            merged += f" {part}"
    return merged.strip()


def chunk_text_for_stream(text: str) -> list[str]:
    normalized = str(text or "").strip()
    if not normalized:
        return []
    segments = [
        segment.strip()
        for segment in re.split(r"(?<=[\.\!\?])\s+", normalized)
        if segment and segment.strip()
    ]
    if segments:
        return segments
    return [normalized]


_GREETING_REPLIES = [
    "Chào bạn. Hôm nay bạn muốn thử món nào để mình tư vấn?",
    "Xin chào. Mình sẵn sàng phục vụ, bạn muốn gọi gì?",
    "Chào mừng bạn. Bạn muốn uống gì hôm nay để mình gợi ý?",
    "Hi bạn. Mình là robot gọi món. Bạn cần mình giúp gì?",
    "Chào bạn nha. Bạn thích vị đậm, ngọt nhẹ hay thanh mát để mình gợi ý đúng gu?",
    "Xin chào bạn. Nếu chưa biết chọn gì, mình gợi ý nhanh vài món bán chạy nhé?",
    "Hello bạn ơi. Bạn muốn gọi mang đi hay dùng tại chỗ để mình tư vấn tiện hơn?",
    "Mừng bạn ghé quán. Bạn muốn mình đề xuất combo tiết kiệm hay món signature?",
    "Chào bạn. Bạn muốn ưu tiên cà phê, trà trái cây hay trà sữa hôm nay?",
    "Hi bạn. Mình luôn sẵn sàng, bạn muốn xem menu nổi bật trước không?",
]

_CART_UPDATED_SUFFIXES = [
    " Bạn muốn gọi thêm gì không?",
    " Bạn cần gì thêm không?",
    " Bạn muốn order thêm không?",
    "",
]

_RESET_REPLIES = [
    "Mình đã xoá giỏ hàng rồi. Bạn muốn gọi món nào tiếp?",
    "Giỏ hàng đã được làm mới. Bạn chọn lại món nào nhé?",
    "Mình đã reset giỏ hàng rồi. Bạn bắt đầu lại nhé!",
]

_FALLBACK_REPLIES = [
    "Mình nghe chưa rõ. Bạn có thể nói tên món hoặc bảo mình tư vấn nhé.",
    "Mình chưa hiểu ý bạn. Bạn thử nói tên món cụ thể giúp mình nhé.",
    "Xin lỗi, mình nghe không rõ. Bạn nói lại tên món hoặc hỏi mình gợi ý nhé.",
]

_LITE_BRIDGE_REQUIRED_REPLIES = [
    "Mình chỉ hiểu được yêu cầu gọi món. Bạn nói lại tên sản phẩm bạn muốn đặt giúp mình nhé.",
    "Mình chỉ hỗ trợ đặt món trong menu. Bạn nói lại món bạn muốn đặt giúp mình nhé.",
    "Mình chưa xử lý được yêu cầu này. Bạn nói lại đúng tên món hoặc sản phẩm bạn muốn đặt nhé.",
]

_SOFT_REDIRECT_PATTERNS = {
    "sing": [re.compile(r"\bhat\b"), re.compile(r"\bbai hat\b"), re.compile(r"\bhat cho\b")],
    "poem": [re.compile(r"\btho\b"), re.compile(r"\blam tho\b")],
    "heart": [re.compile(r"\btam su\b"), re.compile(r"\bbuon\b"), re.compile(r"\bmet\b"), re.compile(r"\bco don\b")],
}

_SOFT_REDIRECT_REPLIES = {
    "sing": [
        "Mình xin nợ một câu hát dễ thương thôi nhé, giờ bạn chọn món để mình phục vụ liền nhé.",
        "Mình hát dở nên xin phép chiều bạn bằng đồ uống ngon hơn nhé, bạn muốn gọi món gì?",
    ],
    "poem": [
        "Mình gửi một vần thơ ngắn trong lòng thôi, còn ngoài đời mời bạn chọn món hợp mood nhé.",
        "Mình làm thơ ít chữ thôi kẻo quên order mất, bạn muốn mình gợi ý món nào hợp tâm trạng?",
    ],
    "heart": [
        "Nếu bạn đang mệt hay buồn thì để mình ở đây nói chuyện một chút rồi gợi ý món hợp tâm trạng cho bạn nhé.",
        "Nghe bạn nói vậy là mình muốn chăm bạn bằng một món thật hợp gu rồi đó, bạn thích ngọt dịu hay đậm vị hơn?",
    ],
}

_ORDER_CREATED_SUFFIXES = [
    " Hẹn gặp lại bạn nhé!",
    " Chúc bạn ngon miệng nhé!",
    " Cảm ơn bạn nhiều!",
    "",
]

_MOJIBAKE_MARKERS = ("Ã", "Ä", "á»", "áº", "Æ", "â€")
_VI_DIACRITIC_CHARS = set("ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ")
_ASCII_VI_HINTS = (
    " minh ",
    " ban ",
    " mon ",
    " menu ",
    " hom nay ",
    " gio hang ",
    " goi ",
    " uong ",
    " khong ",
    " xin loi ",
)
_BROKEN_SPACING_PATTERN = re.compile(r"\b[bcdfghklmnpqrstvxđ]\b\s+[a-zà-ỹđ]{2,}\b", re.IGNORECASE)
_SPACELESS_JOINED_WORD_PATTERN = re.compile(
    r"\b("
    r"không|khong|mình|minh|bạn|ban|giúp|giup|gợi|goi|ý|y|sẵn|san|sàng|sang|menu|món|mon|nhé|nhe|nè|ne"
    r")(?=[a-zà-ỹđ])",
    re.IGNORECASE,
)
_CONSONANT_CLUSTER_SPLIT_PATTERN = re.compile(
    r"\b("
    r"b|c|d|đ|g|h|k|l|m|n|p|q|r|s|t|v|x|"
    r"ch|gh|gi|kh|ng|nh|ph|qu|th|tr"
    r")\s+"
    r"([aeiouyăâêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]"
    r"[a-zà-ỹđ]*)\b",
    re.IGNORECASE,
)
_COMMON_BROKEN_PHRASE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\buố\s+ng\b", re.IGNORECASE), "uống"),
    (re.compile(r"\bmuốn?t\s+h[êe]m\b", re.IGNORECASE), "muốn thêm"),
    (re.compile(r"\btênm\s+ón\b", re.IGNORECASE), "tên món"),
    (re.compile(r"\bkhôngp?h\s+ục\b", re.IGNORECASE), "không phục"),
)
_SAFE_SCENE_REPLIES = {
    "greeting_intro": "Chào mừng bạn. Hôm nay bạn muốn thử món nào?",
    "greeting": "Xin chào. Bạn muốn gọi món gì hôm nay?",
    "cart_updated": "Mình đã thêm vào giỏ hàng. Bạn muốn gọi thêm gì không?",
    "ask_confirmation": "Mình đọc lại giỏ hàng. Nếu đúng thì nói xác nhận.",
    "order_created": "Đơn của bạn đã tạo thành công. Cảm ơn bạn.",
    "recommendation": "Mình có vài gợi ý để uống. Bạn muốn thử món nào?",
    "clarify_item": "Mình thấy có vài món gần giống. Bạn muốn món nào?",
    "clarify_size": "Món này có nhiều size. Bạn chọn size S, M, L hoặc XL giúp mình nhé.",
    "remove_item": "Mình đã cập nhật giỏ hàng theo yêu cầu.",
    "reset": "Mình đã làm mới giỏ hàng. Bạn muốn gọi món nào tiếp?",
    "fallback": "Mình chưa nghe rõ. Bạn nói tên món hoặc yêu cầu ngắn gọn giúp mình nhé.",
    "cart_follow_up": "Giỏ hàng vẫn đang giữ. Bạn muốn mình đọc lại không?",
}


def repair_mojibake_text(value: object) -> str:
    text = str(value or "")
    if not text:
        return ""
    if not any(marker in text for marker in _MOJIBAKE_MARKERS):
        return text

    candidates = [text]
    for source_encoding in ("latin1", "cp1252"):
        try:
            candidates.append(text.encode(source_encoding, errors="ignore").decode("utf-8", errors="ignore"))
        except Exception:
            continue

    def score(candidate: str) -> tuple[int, int]:
        marker_hits = sum(candidate.count(marker) for marker in _MOJIBAKE_MARKERS)
        return (marker_hits, -len(candidate))

    return min(candidates, key=score)


def _looks_like_vietnamese_without_tone(text: str) -> bool:
    sample = str(text or "").strip()
    if len(sample) < 24:
        return False
    lower = sample.casefold()
    if any(char in lower for char in _VI_DIACRITIC_CHARS):
        return False
    if not any("a" <= char <= "z" for char in lower):
        return False
    normalized_ascii = f" {normalize_text(sample)} "
    hint_hits = sum(1 for hint in _ASCII_VI_HINTS if hint in normalized_ascii)
    return hint_hits >= 2


def _looks_like_broken_spacing_text(text: str) -> bool:
    sample = str(text or "").strip()
    if len(sample) < 20:
        return False
    if len(_BROKEN_SPACING_PATTERN.findall(sample)) >= 2:
        return True
    return False


def _repair_vietnamese_spacing_text(text: str) -> str:
    candidate = str(text or "")
    if not candidate:
        return ""

    previous = ""
    repaired = candidate
    for _ in range(3):
        if repaired == previous:
            break
        previous = repaired
        repaired = _SPACELESS_JOINED_WORD_PATTERN.sub(r"\1 ", repaired)
        repaired = _CONSONANT_CLUSTER_SPLIT_PATTERN.sub(r"\1\2", repaired)
        for pattern, replacement in _COMMON_BROKEN_PHRASE_PATTERNS:
            repaired = pattern.sub(replacement, repaired)
        repaired = re.sub(r"\s+", " ", repaired).strip()
    return repaired


def ensure_frontend_safe_reply(scene: str, value: object) -> str:
    repaired = repair_mojibake_text(value)
    repaired = _repair_vietnamese_spacing_text(repaired)
    if not repaired.strip():
        return _SAFE_SCENE_REPLIES.get(scene, _SAFE_SCENE_REPLIES["fallback"])
    if any(marker in repaired for marker in _MOJIBAKE_MARKERS):
        return _SAFE_SCENE_REPLIES.get(scene, _SAFE_SCENE_REPLIES["fallback"])
    if scene in {"greeting", "recommendation", "fallback", "cart_follow_up"} and _looks_like_vietnamese_without_tone(repaired):
        return _SAFE_SCENE_REPLIES.get(scene, _SAFE_SCENE_REPLIES["fallback"])
    if scene in {"greeting", "recommendation", "fallback", "cart_follow_up"} and _looks_like_broken_spacing_text(repaired):
        return _SAFE_SCENE_REPLIES.get(scene, _SAFE_SCENE_REPLIES["fallback"])
    return repaired


def render_fallback_reply(payload: dict[str, object]) -> str:
    scene = str(payload["scene"])
    seed = str(payload["seed"])
    cart_summary = payload.get("cart_summary", [])
    recommended_items = payload.get("recommended_items", [])
    user_text = str(payload.get("user_text", "")).strip()

    if scene == "greeting":
        soft_reply = _render_soft_redirect(user_text)
        if soft_reply:
            return repair_mojibake_text(soft_reply)
        return repair_mojibake_text(random.choice(_GREETING_REPLIES))
    if scene == "cart_updated":
        return repair_mojibake_text(seed + random.choice(_CART_UPDATED_SUFFIXES))
    if scene == "remove_item":
        return repair_mojibake_text(seed)
    if scene == "reset":
        return repair_mojibake_text(random.choice(_RESET_REPLIES))
    if scene == "fallback":
        soft_reply = _render_soft_redirect(user_text)
        if soft_reply:
            return repair_mojibake_text(soft_reply)
        return repair_mojibake_text(random.choice(_FALLBACK_REPLIES))
    if scene == "clarify_item":
        if recommended_items:
            names = ", ".join(item["name"] for item in recommended_items[:3])
            return repair_mojibake_text(f"Mình thấy có mấy món gần giống: {names}. Bạn muốn gọi món nào?")
        return repair_mojibake_text(f"{seed} Bạn nói rõ tên món giúp mình nhé.")
    if scene == "clarify_size":
        return repair_mojibake_text(f"{seed} Ví dụ: size M hoặc size L.")
    if scene == "recommendation":
        if recommended_items:
            lines = []
            for item in recommended_items[:3]:
                desc = item.get("description", "")
                if desc:
                    lines.append(f"- {item['name']}: {desc}")
                else:
                    lines.append(f"- {item['name']}")
            items_text = "\n".join(lines)
            return repair_mojibake_text(f"{seed}\n{items_text}\nBạn thích món nào để mình thêm vào giỏ nhé?")
        return repair_mojibake_text(f"{seed} Bạn muốn mình gợi ý thêm không?")
    if scene == "ask_confirmation":
        if cart_summary:
            def _to_int_amount(value: object) -> int:
                try:
                    return int(Decimal(str(value)))
                except Exception:
                    return 0

            details = ", ".join(
                f"{item['quantity']} {item['name']} ({_to_int_amount(item.get('line_total'))}d)"
                for item in cart_summary
            )
            total = sum(_to_int_amount(item.get("line_total")) for item in cart_summary)
            return repair_mojibake_text(
                f"Mình đọc lại giỏ hàng nhé: {details}. "
                f"Tổng cộng {total:,}đ. "
                f"Bạn nói 'xác nhận' để mình lên đơn, "
                f"hoặc nói tên món để thêm nha."
            )
        return repair_mojibake_text(f"{seed} Bạn nói 'xác nhận' giúp mình nhé.")
    if scene == "order_created":
        return repair_mojibake_text(seed + random.choice(_ORDER_CREATED_SUFFIXES))
    if scene == "cart_follow_up":
        if cart_summary:
            details = ", ".join(f"{item['quantity']} {item['name']}" for item in cart_summary)
            return repair_mojibake_text(f"{seed} Giỏ hàng hiện có {details}.")
        return repair_mojibake_text(seed)
    return repair_mojibake_text(seed)


def render_lite_bridge_required_reply(_: dict[str, object]) -> str:
    return repair_mojibake_text(random.choice(_LITE_BRIDGE_REQUIRED_REPLIES))


def _render_soft_redirect(user_text: str) -> str | None:
    normalized = normalize_text(user_text)
    if not normalized:
        return None

    for key, patterns in _SOFT_REDIRECT_PATTERNS.items():
        if any(pattern.search(normalized) for pattern in patterns):
            return ensure_frontend_safe_reply("fallback", random.choice(_SOFT_REDIRECT_REPLIES[key]))
    return None

