from __future__ import annotations

import asyncio
import base64
import difflib
import logging
import random
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from threading import Lock
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
    SessionState,
)
from app.services.core_backend_client import CoreBackendClient
from app.services.provider_client import ProviderClient


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
CONFIRM_KEYWORDS = {"xac nhan", "dong y", "ok", "oke", "dat di", "chot don", "xac nhan don", "len don di"}
RESET_KEYWORDS = {"huy", "lam lai", "dat lai", "bo het"}
REMOVE_KEYWORDS = {"bo", "xoa", "huy mon", "khong lay", "bo di", "xoa di", "xoa mon", "bo mon"}
RECOMMEND_KEYWORDS = {"goi y", "tu van", "nen uong", "nen an", "de uong", "it ngot", "mon nao", "co gi ngon", "ngon", "gioi thieu"}
CHECKOUT_KEYWORDS = {"xong", "dat luon", "len don", "chot don", "thanh toan", "xong roi", "het roi"}
SEGMENT_SPLIT_PATTERN = re.compile(r"\s*(?:,|\bva\b|\bvoi\b|\bcung\b|\bthem\b)\s*")

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
    "cho vai": "tra vai",   # "chợ vải" misheard → "trà vải"
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
}

# Minimum similarity ratio for fuzzy matching (0.0 - 1.0)
_FUZZY_THRESHOLD = 0.65

# Scenes that can be handled entirely locally without LLM
SIMPLE_SCENES = {"greeting", "reset", "cart_updated", "remove_item",
                 "order_created", "cart_follow_up", "fallback",
                 "ask_confirmation", "clarify_item"}
# Only recommendation truly benefits from LLM creativity
COMPLEX_SCENES = {"recommendation"}

MENU_CACHE_TTL = 60.0  # seconds


@dataclass(slots=True)
class Candidate:
    item: MenuItem
    score: int


class ConversationEngine:
    def __init__(self, settings: Settings, core_client: CoreBackendClient) -> None:
        self.settings = settings
        self.core_client = core_client
        self.provider_client = ProviderClient(settings) if settings.provider_enabled else None
        self.sessions: dict[str, SessionState] = {}
        self.lock = Lock()
        self._menu_cache: list[MenuItem] | None = None
        self._menu_cache_at: float = 0.0

    async def _get_menu(self) -> list[MenuItem]:
        """Get menu with caching (TTL=60s) to avoid HTTP round-trip every turn."""
        now = time.monotonic()
        if self._menu_cache is not None and (now - self._menu_cache_at) < MENU_CACHE_TTL:
            return self._menu_cache
        self._menu_cache = await self.core_client.list_menu()
        self._menu_cache_at = now
        return self._menu_cache

    async def start_session(self) -> ConversationResponse:
        session_id = f"SES-{uuid4().hex[:10]}"
        with self.lock:
            self._cleanup_expired_sessions()
            self.sessions[session_id] = SessionState(session_id=session_id, greeted=True)

        decision = Decision(
            scene="greeting",
            reply_seed="Chào mừng mình ạ. Hôm nay mình muốn thử món nào để em tư vấn ngay nhé?",
        )
        return await self._build_response(session_id, decision)

    async def reset_session(self, session_id: str) -> ConversationResponse:
        with self.lock:
            self._cleanup_expired_sessions()
            state = self.sessions.setdefault(session_id, SessionState(session_id=session_id))
            self._touch_state(state)
            state.cart.clear()
            state.history.clear()
            state.awaiting_confirmation = False

        decision = Decision(
            scene="reset",
            reply_seed="Em đã làm mới giỏ hàng rồi ạ. Mình muốn gọi món nào tiếp theo nè?",
        )
        return await self._build_response(session_id, decision)

    async def handle_turn(self, session_id: str, transcript: str) -> ConversationResponse:
        with self.lock:
            self._cleanup_expired_sessions()
            state = self.sessions.get(session_id)
            if state is None:
                state = SessionState(session_id=session_id)
                self.sessions[session_id] = state
            self._touch_state(state)
            state.history.append(transcript)

        menu = await self._get_menu()
        normalized = normalize_text(transcript)

        if state.cart and contains_any(normalized, RESET_KEYWORDS):
            state.cart.clear()
            state.awaiting_confirmation = False
            return await self._build_response(
                session_id,
                Decision(
                    scene="reset",
                    reply_seed="Em đã xóa giỏ hàng cũ rồi ạ. Mình muốn em gợi ý món nào tiếp không?",
                ),
                menu,
            )

        if state.cart and (
            contains_any(normalized, CONFIRM_KEYWORDS) or contains_any(normalized, CHECKOUT_KEYWORDS)
        ):
            if state.awaiting_confirmation:
                order = await self.core_client.create_order(
                    CreateOrderRequest(
                        session_id=session_id,
                        customer_text=transcript,
                        items=[
                            CreateOrderLineItem(item_id=item_id, quantity=quantity)
                            for item_id, quantity in state.cart.items()
                        ],
                    )
                )
                state.cart.clear()
                state.awaiting_confirmation = False
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="order_created",
                        reply_seed=f"Đã xong rồi ạ. Em đã lên đơn thành công với mã {order.order_id}. Cảm ơn mình nha.",
                        order_created=True,
                        order_id=order.order_id,
                    ),
                    menu,
                )

            state.awaiting_confirmation = True
            return await self._build_response(
                session_id,
                Decision(
                    scene="ask_confirmation",
                    reply_seed="Em đọc lại giỏ hàng để mình xác nhận nhé.",
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
                        reply_seed=f"Em đã bỏ {removed} khỏi giỏ hàng rồi ạ. Mình muốn sửa gì thêm không?",
                    ),
                    menu,
                )

        if contains_any(normalized, RECOMMEND_KEYWORDS) or "?" in transcript:
            recommended = self._rank_items(normalized, menu)[:3]
            if recommended:
                return await self._build_response(
                    session_id,
                    Decision(
                        scene="recommendation",
                        reply_seed="Em tìm được vài món hợp gu của mình rồi ạ.",
                        recommended_item_ids=[candidate.item.item_id for candidate in recommended],
                    ),
                    menu,
                )

        segment_matches = self._extract_segment_matches(normalized, menu)
        if segment_matches:
            state.awaiting_confirmation = contains_any(normalized, CHECKOUT_KEYWORDS)
            for item, quantity in segment_matches:
                state.cart[item.item_id] = state.cart.get(item.item_id, 0) + quantity

            added_summary = ", ".join(f"{quantity} {item.name}" for item, quantity in segment_matches)
            scene = "ask_confirmation" if state.awaiting_confirmation else "cart_updated"
            seed = (
                f"Em đã thêm {added_summary} vào giỏ hàng."
                if not state.awaiting_confirmation
                else f"Em đã thêm {added_summary}. Em đọc lại giỏ hàng để mình xác nhận nhé."
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
        available_matches = [item for item in matched_items if item.available]
        unavailable_matches = [item for item in matched_items if not item.available]
        if unavailable_matches and not available_matches:
            alternatives = self._rank_items(normalized, menu)[:3]
            unavailable_names = ", ".join(item.name for item in unavailable_matches[:2])
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed=f"Em xin lỗi, {unavailable_names} đang tạm hết rồi ạ. Em gợi ý mình đổi sang món khác nhé.",
                    recommended_item_ids=[candidate.item.item_id for candidate in alternatives],
                ),
                menu,
            )

        if available_matches:
            quantity = extract_quantity(normalized)
            if len(available_matches) == 1:
                item = available_matches[0]
                state.cart[item.item_id] = state.cart.get(item.item_id, 0) + quantity
                state.awaiting_confirmation = contains_any(normalized, CHECKOUT_KEYWORDS)
                scene = "ask_confirmation" if state.awaiting_confirmation else "cart_updated"
                seed = (
                    f"Em đã thêm {quantity} {item.name} vào giỏ hàng."
                    if not state.awaiting_confirmation
                    else f"Em đã thêm {quantity} {item.name}. Em đọc lại giỏ hàng để mình xác nhận nhé."
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

            return await self._build_response(
                session_id,
                Decision(
                    scene="clarify_item",
                    reply_seed="Em thấy mình đang nhắc tới nhiều món quá. Mình chọn giúp em 1 món cụ thể nhé.",
                    recommended_item_ids=[item.item_id for item in available_matches[:3]],
                ),
                menu,
            )

        ranked_items = self._rank_items(normalized, menu)[:3]
        if ranked_items:
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed="Em có vài gợi ý dễ uống, thân thiện và dễ chọn cho mình đây ạ.",
                    recommended_item_ids=[candidate.item.item_id for candidate in ranked_items],
                ),
                menu,
            )

        if state.cart:
            return await self._build_response(
                session_id,
                Decision(
                    scene="cart_follow_up",
                    reply_seed="Em chưa nghe rõ món mới. Hiện giỏ hàng của mình vẫn đang có sẵn, mình muốn em đọc lại để xác nhận không?",
                ),
                menu,
            )

        return await self._build_response(
            session_id,
            Decision(
                scene="fallback",
                reply_seed="Em nghe chưa rõ lắm. Mình có thể nói tên món, khẩu vị như ít ngọt, hoặc bảo em tư vấn món dễ uống nhé.",
            ),
            menu,
        )

    def _match_explicit_items(self, normalized_transcript: str, menu: list[MenuItem]) -> list[MenuItem]:
        """Match menu items using exact, token-based, and fuzzy matching."""
        matches: list[MenuItem] = []
        matched_ids: set[str] = set()
        
        # Apply STT alias corrections to the transcript
        corrected = _apply_stt_aliases(normalized_transcript)
        
        for item in menu:
            if item.item_id in matched_ids:
                continue
            normalized_name = normalize_text(item.name)
            
            # 1. Exact substring match
            if normalized_name in corrected:
                matches.append(item)
                matched_ids.add(item.item_id)
                continue
            
            # 2. Token-based match (all significant tokens present)
            name_tokens = [token for token in normalized_name.split() if len(token) > 2]
            if name_tokens and all(token in corrected for token in name_tokens):
                matches.append(item)
                matched_ids.add(item.item_id)
                continue
            
            # 3. Fuzzy match — compare each word sequence in transcript
            #    against the item name using SequenceMatcher
            if _fuzzy_match(corrected, normalized_name):
                matches.append(item)
                matched_ids.add(item.item_id)
        
        return matches

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
            matches = [item for item in self._match_explicit_items(segment, menu) if item.available]
            if len(matches) != 1:
                continue

            item = matches[0]
            quantity = extract_quantity(segment)
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
                if len(token) <= 1:
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
            
            score += 1
            if score > 0:
                scores.append(Candidate(item=item, score=score))
        scores.sort(key=lambda candidate: (-candidate.score, candidate.item.name))
        return scores

    def _remove_from_cart(self, state: SessionState, normalized_transcript: str, menu: list[MenuItem]) -> str | None:
        menu_map = {item.item_id: item for item in menu}
        for item in self._match_explicit_items(normalized_transcript, menu):
            if item.item_id in state.cart:
                del state.cart[item.item_id]
                state.awaiting_confirmation = False
                return item.name

        if state.cart:
            last_item_id = next(reversed(state.cart))
            item_name = menu_map.get(last_item_id).name if last_item_id in menu_map else "mon vua chon"
            del state.cart[last_item_id]
            state.awaiting_confirmation = False
            return item_name
        return None

    async def handle_turn_stream(self, session_id: str, transcript: str):
        """Stream conversation response with interleaved text and audio for lower latency.
        
        Simple scenes are handled locally (instant). Complex scenes use LLM streaming.
        """
        # Use handle_turn which already has smart LLM bypass
        response = await self.handle_turn(session_id, transcript)

        # Send text + cart as first chunk
        yield {
            "type": "text",
            "content": response.reply_text,
            "cart": [item.model_dump() for item in response.cart],
        }

        # Stream audio
        from app.services.speech_service import SpeechService
        speech_service = SpeechService(self.settings, self.core_client)
        try:
            async for audio_chunk in speech_service.synthesize_stream(response.reply_text):
                yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}
        except Exception:
            pass

    def active_session_count(self) -> int:
        with self.lock:
            self._cleanup_expired_sessions()
            return len(self.sessions)

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

    async def _build_response(
        self,
        session_id: str,
        decision: Decision,
        menu: list[MenuItem] | None = None,
    ) -> ConversationResponse:
        state = self.sessions[session_id]
        menu = menu or await self._get_menu()
        cart = build_cart_items(state.cart, menu)
        prompt_payload = {
            "scene": decision.scene,
            "seed": decision.reply_seed,
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

        # Only call LLM for complex scenes; simple scenes use local templates
        if self.provider_client is not None and decision.scene in COMPLEX_SCENES:
            try:
                provider_reply = await self.provider_client.compose_reply(prompt_payload)
                reply_text = provider_reply["reply_text"]
                voice_style = provider_reply["voice_style"]
            except Exception:
                logger.warning("LLM call failed for scene '%s', using local fallback", decision.scene)
                reply_text = render_fallback_reply(prompt_payload)
                voice_style = self.settings.voice_style
        else:
            reply_text = render_fallback_reply(prompt_payload)
            voice_style = self.settings.voice_style

        return ConversationResponse(
            session_id=session_id,
            reply_text=reply_text,
            cart=cart,
            recommended_item_ids=decision.recommended_item_ids,
            needs_confirmation=decision.needs_confirmation,
            order_created=decision.order_created,
            order_id=decision.order_id,
            voice_style=voice_style,
        )


def build_cart_items(cart: dict[str, int], menu: list[MenuItem]) -> list[CartItem]:
    menu_map = {item.item_id: item for item in menu}
    cart_items: list[CartItem] = []
    for item_id, quantity in cart.items():
        if item_id not in menu_map:
            continue
        item = menu_map[item_id]
        line_total = item.price * quantity
        cart_items.append(
            CartItem(
                item_id=item.item_id,
                name=item.name,
                quantity=quantity,
                unit_price=item.price,
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


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text.casefold())
    stripped = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    stripped = re.sub(r"[^a-z0-9\s]", " ", stripped)
    return re.sub(r"\s+", " ", stripped).strip()


def extract_quantity(normalized_text: str) -> int:
    # Pattern: "so luong X" or "X cai/ly/phan"
    qty_pattern = re.search(r"so luong\s+(\d+)", normalized_text)
    if qty_pattern:
        return max(1, min(int(qty_pattern.group(1)), 20))
    
    digit_match = re.search(r"\b(\d+)\b", normalized_text)
    if digit_match:
        return max(1, min(int(digit_match.group(1)), 20))

    for word, value in QUANTITY_WORDS.items():
        if word in normalized_text:
            return value
    return 1


def _apply_stt_aliases(text: str) -> str:
    """Apply STT alias corrections to normalized text."""
    result = text
    # Sort by longest key first to avoid partial replacements
    for alias, replacement in sorted(_STT_ALIASES.items(), key=lambda x: -len(x[0])):
        if alias in result:
            result = result.replace(alias, replacement)
    return result


def _fuzzy_match(transcript: str, item_name: str) -> bool:
    """Check if transcript fuzzy-matches the item name using SequenceMatcher.
    
    Returns True if similarity is above threshold.
    Handles cases like 'socola' matching 'socola da xay',
    'tra vai hoa hong' matching imprecise STT output, etc.
    """
    # Short item names need higher precision
    name_words = item_name.split()
    name_len = len(name_words)
    if name_len == 0:
        return False
    
    # Try sliding window of item name length across transcript
    transcript_words = transcript.split()
    if len(transcript_words) < 1:
        return False
    
    best_ratio = 0.0
    for start in range(len(transcript_words)):
        for end in range(start + max(1, name_len - 1), min(start + name_len + 2, len(transcript_words) + 1)):
            window = " ".join(transcript_words[start:end])
            ratio = difflib.SequenceMatcher(None, window, item_name).ratio()
            best_ratio = max(best_ratio, ratio)
    
    return best_ratio >= _FUZZY_THRESHOLD


_GREETING_REPLIES = [
    "Chào mình ạ! Hôm nay mình muốn thử món nào để em tư vấn nhé?",
    "Xin chào mình ạ. Em sẵn sàng phục vụ, mình muốn gọi gì nè?",
    "Chào mừng mình! Mình muốn uống gì hôm nay để em gợi ý nhé?",
    "Hi mình ạ! Em là robot gọi món. Mình cần em giúp gì nha?",
]

_CART_UPDATED_SUFFIXES = [
    " Mình muốn gọi thêm gì không ạ?",
    " Mình cần gì thêm không nè?",
    " Mình muốn order thêm không ạ?",
    "",
]

_RESET_REPLIES = [
    "Em đã xóa giỏ hàng rồi ạ. Mình muốn gọi món nào tiếp không?",
    "Giỏ hàng đã được làm mới. Mình chọn lại món nào nhé?",
    "Em đã reset giỏ hàng rồi ạ. Mình bắt đầu lại nha!",
]

_FALLBACK_REPLIES = [
    "Em nghe chưa rõ lắm. Mình có thể nói tên món hoặc bảo em tư vấn nhé.",
    "Em chưa hiểu ý mình. Mình thử nói tên món cụ thể giúp em nha.",
    "Em xin lỗi, nghe không rõ ạ. Mình nói lại tên món hoặc hỏi em gợi ý nhé.",
]

_ORDER_CREATED_SUFFIXES = [
    " Hẹn gặp lại mình ạ!",
    " Chúc mình ngon miệng nha!",
    " Cảm ơn mình nhiều ạ!",
    "",
]


def render_fallback_reply(payload: dict[str, object]) -> str:
    scene = str(payload["scene"])
    seed = str(payload["seed"])
    cart_summary = payload.get("cart_summary", [])
    recommended_items = payload.get("recommended_items", [])

    if scene == "greeting":
        return random.choice(_GREETING_REPLIES)
    if scene == "cart_updated":
        return seed + random.choice(_CART_UPDATED_SUFFIXES)
    if scene == "remove_item":
        return seed
    if scene == "reset":
        return random.choice(_RESET_REPLIES)
    if scene == "fallback":
        return random.choice(_FALLBACK_REPLIES)
    if scene == "clarify_item":
        if recommended_items:
            names = ", ".join(item["name"] for item in recommended_items[:3])
            return f"Em thấy có mấy món gần giống: {names}. Mình muốn gọi món nào ạ?"
        return f"{seed} Mình nói rõ tên món giúp em nhé."
    if scene == "recommendation":
        item_names = (
            ", ".join(item["name"] for item in recommended_items[:3])
            if recommended_items
            else "một vài món dễ uống"
        )
        return f"{seed} Em gợi ý {item_names}. Mình ưng ý món nào để em thêm vào giỏ nhé?"
    if scene == "ask_confirmation":
        if cart_summary:
            details = ", ".join(
                f"{item['quantity']} {item['name']} ({item['line_total']}đ)"
                for item in cart_summary
            )
            total = sum(int(item['line_total']) for item in cart_summary)
            return (
                f"Em đọc lại giỏ hàng nhé: {details}. "
                f"Tổng cộng {total:,}đ ạ. "
                f"Mình nói 'xác nhận' để em lên đơn, "
                f"hoặc nói tên món để thêm nha."
            )
        return f"{seed} Mình nói 'xác nhận' giúp em nhé."
    if scene == "order_created":
        return seed + random.choice(_ORDER_CREATED_SUFFIXES)
    if scene == "cart_follow_up":
        if cart_summary:
            details = ", ".join(f"{item['quantity']} {item['name']}" for item in cart_summary)
            return f"{seed} Giỏ hàng hiện có {details} ạ."
        return seed
    return seed
