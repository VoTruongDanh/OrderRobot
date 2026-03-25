from __future__ import annotations

import asyncio
import base64
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

# Chitchat / non-ordering keywords — respond naturally instead of trying to match menu
_CHITCHAT_PATTERNS = [
    re.compile(r"ten (toi|minh|em|anh|chi) la"),  # “tên tôi là X”
    re.compile(r"toi ten (la )?"),                  # “tôi tên là X”
    re.compile(r"^(chao|hi|hello|xin chao)"),       # greetings
    re.compile(r"o dau"),                           # “ở đâu”
    re.compile(r"may gio"),                         # “mấy giờ”
    re.compile(r"cam on"),                          # “cảm ơn”
    re.compile(r"^(da|vang|ok|oke|uhm)$"),          # acknowledgments
    re.compile(r"the la"),                          # “thế là”
    re.compile(r"khong tin"),                       # “không tin”
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
_FUZZY_THRESHOLD = 0.70
# Auto-add threshold: items with confidence >= this are added directly to cart
_AUTO_ADD_THRESHOLD = 0.85

# Scenes handled locally without LLM
SIMPLE_SCENES = {"reset", "cart_updated", "remove_item",
                 "order_created", "cart_follow_up",
                 "ask_confirmation", "clarify_item", "greeting_intro"}
# Scenes that benefit from LLM context and creativity
COMPLEX_SCENES = {"recommendation", "greeting", "fallback"}

MENU_CACHE_TTL = 60.0  # seconds


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
        async with self.lock:
            self._cleanup_expired_sessions()
            self.sessions[session_id] = SessionState(session_id=session_id, greeted=True)

        decision = Decision(
            scene="greeting_intro",
            reply_seed="Chào mừng mình ạ. Hôm nay mình muốn thử món nào để em tư vấn ngay nhé?",
        )
        return await self._build_response(session_id, decision)

    async def reset_session(self, session_id: str) -> ConversationResponse:
        async with self.lock:
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
        async with self.lock:
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
                        user_text=transcript,
                    ),
                    menu,
                )

        # Chitchat / name / non-ordering input — respond naturally
        if _is_chitchat(normalized):
            return await self._build_response(
                session_id,
                Decision(
                    scene="greeting",
                    reply_seed="",
                    user_text=transcript,
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
        available_matches = [(item, conf) for item, conf in matched_items if item.available]
        unavailable_matches = [(item, conf) for item, conf in matched_items if not item.available]
        if unavailable_matches and not available_matches:
            alternatives = self._rank_items(normalized, menu)[:3]
            unavailable_names = ", ".join(item.name for item, _ in unavailable_matches[:2])
            return await self._build_response(
                session_id,
                Decision(
                    scene="recommendation",
                    reply_seed=f"Em xin lỗi, {unavailable_names} đang tạm hết rồi ạ. Em gợi ý mình đổi sang món khác nhé.",
                    recommended_item_ids=[candidate.item.item_id for candidate in alternatives],
                    user_text=transcript,
                ),
                menu,
            )

        if available_matches:
            # Auto-add: best match confidence >= 85% → add directly
            best_match, best_conf = max(available_matches, key=lambda x: x[1])
            high_conf_matches = [(item, conf) for item, conf in available_matches if conf >= _AUTO_ADD_THRESHOLD]
            
            if len(high_conf_matches) == 1 or (len(available_matches) >= 1 and best_conf >= _AUTO_ADD_THRESHOLD):
                # Single high-confidence match or one clearly dominates → auto-add
                item = best_match
                quantity = extract_quantity(normalized, item_name=normalize_text(item.name))
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

            # Multiple matches below auto-add threshold → ask for clarification
            return await self._build_response(
                session_id,
                Decision(
                    scene="clarify_item",
                    reply_seed="Em thấy có mấy món gần giống. Mình muốn gọi món nào ạ?",
                    recommended_item_ids=[item.item_id for item, _ in available_matches[:3]],
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
                    user_text=transcript,
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
                user_text=transcript,
            ),
            menu,
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
        
        for item in menu:
            if item.item_id in matched_ids:
                continue
            normalized_name = normalize_text(item.name)
            
            # 1. Exact substring match → confidence 1.0
            if normalized_name in corrected:
                exact_matches.append((item, 1.0))
                matched_ids.add(item.item_id)
                continue
            
            # 2. Token-based match (all significant tokens present) → confidence 0.95
            name_tokens = [token for token in normalized_name.split() if len(token) > 2]
            if name_tokens and all(token in corrected for token in name_tokens):
                exact_matches.append((item, 0.95))
                matched_ids.add(item.item_id)
                continue
            
            # 3. Fuzzy match → confidence = actual similarity ratio
            ratio = _fuzzy_match_ratio(corrected, normalized_name)
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
                state.awaiting_confirmation = False
                if quantity_to_remove > 1:
                    return f"{quantity_to_remove} {item.name}"
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

        # Stream audio with the shared service so we keep runtime caches warm.
        if self.speech_service is None:
            return

        try:
            async for audio_chunk in self.speech_service.synthesize_stream(response.reply_text):
                yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}
        except Exception:
            pass

    async def save_feedback(self, session_id: str, rating: int, comment: str | None, transcript_history: list[str]) -> None:
        """Save feedback and transcript logs to local JSONL for analytics."""
        async with self.lock:
            # We don't read from state.history because frontend sends the full synced transcript_history, removing any async timing mismatch 
            pass

        feedback_data = {
            "session_id": session_id,
            "rating": rating,
            "comment": comment,
            "transcript_history": transcript_history,
            "created_at": datetime.now(UTC).isoformat()
        }

        backend_root = Path(__file__).resolve().parents[2]
        log_path = backend_root / "data" / "feedback.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(feedback_data, ensure_ascii=False) + "\n")

    async def active_session_count(self) -> int:
        async with self.lock:
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
        if decision.user_text:
            prompt_payload["user_text"] = decision.user_text

        reply_source = "local_rule"

        # Only call bridge provider for complex scenes; simple scenes use local templates.
        if self.provider_client is not None and decision.scene in COMPLEX_SCENES:
            try:
                provider_reply = await self.provider_client.compose_reply(prompt_payload)
                reply_text = provider_reply["reply_text"]
                voice_style = provider_reply.get("voice_style", self.settings.voice_style)
                reply_source = "bridge"
            except Exception as exc:
                logger.warning("Bridge call failed for scene '%s': %s - using local fallback", decision.scene, exc)
                reply_text = render_fallback_reply(prompt_payload)
                voice_style = self.settings.voice_style
                reply_source = "fallback"
        else:
            reply_text = render_fallback_reply(prompt_payload)
            voice_style = self.settings.voice_style

        logger.info("reply_source=%s scene=%s session_id=%s", reply_source, decision.scene, session_id)

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


def _is_chitchat(normalized_text: str) -> bool:
    """Check if input is chitchat/non-ordering conversation."""
    for pattern in _CHITCHAT_PATTERNS:
        if pattern.search(normalized_text):
            return True
    # Very short input (1-2 chars) that doesn't match any menu keyword
    if len(normalized_text) <= 3:
        return True
    return False


def extract_quantity(normalized_text: str, item_name: str | None = None) -> int:
    """Extract quantity from normalized text.
    
    Rules:
    - "so luong X" → X  
    - Digits like "3 ly" → 3
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

    # Vietnamese number words — MUST be followed by a unit word to confirm it's a quantity
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

_SOFT_REDIRECT_PATTERNS = {
    "sing": [re.compile(r"\bhat\b"), re.compile(r"\bca\b")],
    "poem": [re.compile(r"\btho\b"), re.compile(r"\blam tho\b")],
    "heart": [re.compile(r"\btam su\b"), re.compile(r"\bbuon\b"), re.compile(r"\bmet\b"), re.compile(r"\bco don\b")],
}

_SOFT_REDIRECT_REPLIES = {
    "sing": [
        "Em xin nợ một câu hát dễ thương thôi nha, còn bây giờ mình chọn món em phục vụ liền nè.",
        "Em hát dở nên xin phép chiều mình bằng đồ uống ngon hơn nha, mình muốn gọi món gì ạ?",
    ],
    "poem": [
        "Em xin gửi một vần thơ ngắn trong lòng thôi, còn ngoài đời em mời mình chọn món hợp mood nha.",
        "Em làm thơ ít chữ thôi kẻo quên order mất, mình muốn em gợi ý món nào cho hợp tâm trạng ạ?",
    ],
    "heart": [
        "Nếu mình đang mệt hay buồn thì để em ở đây nói chuyện một chút rồi gợi ý món hợp tâm trạng cho mình nha.",
        "Nghe mình nói vậy là em muốn chăm mình bằng một món thật hợp gu rồi đó, mình thích ngọt dịu hay đậm vị hơn ạ?",
    ],
}

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
    user_text = str(payload.get("user_text", "")).strip()

    if scene == "greeting":
        soft_reply = _render_soft_redirect(user_text)
        if soft_reply:
            return soft_reply
        return random.choice(_GREETING_REPLIES)
    if scene == "cart_updated":
        return seed + random.choice(_CART_UPDATED_SUFFIXES)
    if scene == "remove_item":
        return seed
    if scene == "reset":
        return random.choice(_RESET_REPLIES)
    if scene == "fallback":
        soft_reply = _render_soft_redirect(user_text)
        if soft_reply:
            return soft_reply
        return random.choice(_FALLBACK_REPLIES)
    if scene == "clarify_item":
        if recommended_items:
            names = ", ".join(item["name"] for item in recommended_items[:3])
            return f"Em thấy có mấy món gần giống: {names}. Mình muốn gọi món nào ạ?"
        return f"{seed} Mình nói rõ tên món giúp em nhé."
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
            return f"{seed}\n{items_text}\nMình thích món nào để em thêm vào giỏ nhé?"
        return f"{seed} Mình muốn em gợi ý thêm không ạ?"
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


def _render_soft_redirect(user_text: str) -> str | None:
    normalized = normalize_text(user_text)
    if not normalized:
        return None

    for key, patterns in _SOFT_REDIRECT_PATTERNS.items():
        if any(pattern.search(normalized) for pattern in patterns):
            return random.choice(_SOFT_REDIRECT_REPLIES[key])
    return None
