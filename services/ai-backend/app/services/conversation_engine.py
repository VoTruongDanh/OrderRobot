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
    # RÃµ rÃ ng, khÃ´ng nháº§m láº«n:
    "xac nhan", "dong y", "ok", "oke", "okey", "okay",
    "dat di", "chot don", "xac nhan don", "len don di",
    "dung roi", "dung vay", "chuan roi", "chinh xac",
    "duoc roi", "lay luon", "tien hanh di", "xac nhan luon",
    # CÃ¢u xÃ¡c nháº­n ngáº¯n nhÆ°ng Ä‘áº·c thÃ¹ (khÃ´ng cáº¯t ra):
    "vang em", "da vang", "uh huh", "oke luon",
}
RESET_KEYWORDS = {"huy", "lam lai", "dat lai", "bo het", "xoa het", "xoa tat ca", "bat dau lai", "reset"}
REMOVE_KEYWORDS = {
    "bo", "xoa", "huy mon", "khong lay", "bo di", "xoa di", "xoa mon", "bo mon",
    "khong can", "bo ra", "xoa ra", "huy mon nay", "bo mon nay", "khong muon",
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
    # ThÆ°á»ng xá»­ lÃ½ thÃªm lÃºc chá»‘t
    "xong", "dat luon", "len don", "chot don", "thanh toan", "xong roi", "het roi",
    # Tá»« thá»‹ trÆ°á»ng Ä‘áº·t hÃ ng
    "dat hang", "order", "order luon", "dat luon di", "dat don",
    "dat ngay", "dat thoi", "toi muon dat", "cho toi dat",
    "lay luon", "lay di", "lay thoi", "cho toi lay",
    # XÃ¡c nháº­n mua
    "chot", "mua luon", "mua di", "tinh tien", "thanh toan luon",
    "tra tien", "xong di", "oke dat hang", "ok dat hang",
}
SEGMENT_SPLIT_PATTERN = re.compile(r"\s*(?:,|\bva\b|\bvoi\b|\bcung\b|\bthem\b)\s*")

# Chitchat / non-ordering keywords â€” respond naturally instead of trying to match menu
_CHITCHAT_PATTERNS = [
    re.compile(r"ten (toi|minh|em|anh|chi) la"),  # â€œtÃªn tÃ´i lÃ  Xâ€
    re.compile(r"toi ten (la )?"),                  # â€œtÃ´i tÃªn lÃ  Xâ€
    re.compile(r"^(chao|hi|hello|xin chao)"),       # greetings
    re.compile(r"o dau"),                           # â€œá»Ÿ Ä‘Ã¢uâ€
    re.compile(r"may gio"),                         # â€œmáº¥y giá»â€
    re.compile(r"cam on"),                          # â€œcáº£m Æ¡nâ€
    re.compile(r"^(da|vang|ok|oke|uhm)$"),          # acknowledgments
    re.compile(r"the la"),                          # â€œtháº¿ lÃ â€
    re.compile(r"khong tin"),                       # â€œkhÃ´ng tinâ€
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
    "cho vai": "tra vai",   # "chá»£ váº£i" misheard â†’ "trÃ  váº£i"
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
            reply_seed="Chao mung ban. Hom nay ban muon thu mon nao de minh tu van ngay?",
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
            reply_seed="Minh da lam moi gio hang roi. Ban muon goi mon nao tiep theo?",
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
                    reply_seed="Minh da xoa gio hang cu roi. Ban muon minh goi y mon nao tiep khong?",
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
                        reply_seed=f"Da xong. Minh da len don thanh cong voi ma {order.order_id}. Cam on ban nha.",
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
                    reply_seed="Minh doc lai gio hang de ban xac nhan nhe.",
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
                        reply_seed=f"Minh da bo {removed} khoi gio hang roi. Ban muon sua gi them khong?",
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
                        reply_seed="Minh tim duoc vai mon hop gu cua ban roi.",
                        recommended_item_ids=[candidate.item.item_id for candidate in recommended],
                        user_text=transcript,
                    ),
                    menu,
                )

        # Chitchat / name / non-ordering input â€” respond naturally
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
                f"Minh da them {added_summary} vao gio hang."
                if not state.awaiting_confirmation
                else f"Minh da them {added_summary}. Minh doc lai gio hang de ban xac nhan nhe."
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
                    reply_seed=f"Xin loi, {unavailable_names} dang tam het. Minh goi y ban doi sang mon khac nhe.",
                    recommended_item_ids=[candidate.item.item_id for candidate in alternatives],
                    user_text=transcript,
                ),
                menu,
            )

        if available_matches:
            # Auto-add: best match confidence >= 85% â†’ add directly
            best_match, best_conf = max(available_matches, key=lambda x: x[1])
            high_conf_matches = [(item, conf) for item, conf in available_matches if conf >= _AUTO_ADD_THRESHOLD]
            
            if len(high_conf_matches) == 1 or (len(available_matches) >= 1 and best_conf >= _AUTO_ADD_THRESHOLD):
                # Single high-confidence match or one clearly dominates â†’ auto-add
                item = best_match
                quantity = extract_quantity(normalized, item_name=normalize_text(item.name))
                state.cart[item.item_id] = state.cart.get(item.item_id, 0) + quantity
                state.awaiting_confirmation = contains_any(normalized, CHECKOUT_KEYWORDS)
                scene = "ask_confirmation" if state.awaiting_confirmation else "cart_updated"
                seed = (
                    f"Minh da them {quantity} {item.name} vao gio hang."
                    if not state.awaiting_confirmation
                    else f"Minh da them {quantity} {item.name}. Minh doc lai gio hang de ban xac nhan nhe."
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

            # Multiple matches below auto-add threshold â†’ ask for clarification
            return await self._build_response(
                session_id,
                Decision(
                    scene="clarify_item",
                    reply_seed="Minh thay co may mon gan giong. Ban muon goi mon nao?",
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
                    reply_seed="Minh co vai goi y de uong, de chon cho ban day.",
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
                    reply_seed="Minh chua nghe ro mon moi. Gio hang cua ban van dang co san, ban muon minh doc lai de xac nhan khong?",
                ),
                menu,
            )

        return await self._build_response(
            session_id,
            Decision(
                scene="fallback",
                reply_seed="Minh nghe chua ro. Ban co the noi ten mon, khau vi nhu it ngot, hoac bao minh tu van mon de uong nhe.",
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
            
            # 1. Exact substring match â†’ confidence 1.0
            if normalized_name in corrected:
                exact_matches.append((item, 1.0))
                matched_ids.add(item.item_id)
                continue
            
            # 2. Token-based match (all significant tokens present) â†’ confidence 0.95
            name_tokens = [token for token in normalized_name.split() if len(token) > 2]
            if name_tokens and all(token in corrected for token in name_tokens):
                exact_matches.append((item, 0.95))
                matched_ids.add(item.item_id)
                continue
            
            # 3. Fuzzy match â†’ confidence = actual similarity ratio
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
            "scene": response.scene,
            "emotion_hint": response.emotion_hint,
            "action_hints": list(response.action_hints),
            "order_created": response.order_created,
            "order_id": response.order_id,
        }

        # Stream audio with the shared service so we keep runtime caches warm.
        if self.speech_service is None:
            return

        try:
            async for audio_chunk in self.speech_service.synthesize_stream(response.reply_text):
                yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}
        except Exception:
            pass

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

        auto_tags, auto_notes = self._analyze_feedback_issues(
            rating=rating,
            comment=comment,
            transcript_history=transcript_history,
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
            "comment": comment,
            "transcript_history": transcript_history,
            "needs_improvement": final_needs_improvement,
            "improvement_tags": merged_tags,
            "review_status": review_status,
            "analysis_notes": auto_notes,
            "analysis_version": 1,
            "created_at": datetime.now(UTC).isoformat(),
        }

        backend_root = Path(__file__).resolve().parents[2]
        log_path = backend_root / "data" / "feedback.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(feedback_data, ensure_ascii=False) + "\n")

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

        mismatch_count = 0
        ack_loop_count = 0

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
    ) -> ConversationResponse:
        state = self.sessions[session_id]
        menu = menu or await self._get_menu()
        cart = build_cart_items(state.cart, menu)
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

        reply_text = ensure_frontend_safe_reply(decision.scene, reply_text)
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
            scene=decision.scene,
            emotion_hint=self._map_scene_to_emotion(decision.scene),
            action_hints=self._map_scene_to_action_hints(decision.scene),
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
    - "so luong X" â†’ X  
    - Digits like "3 ly" â†’ 3
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


_GREETING_REPLIES = [
    "Chao ban. Hom nay ban muon thu mon nao de minh tu van?",
    "Xin chao. Minh san sang phuc vu, ban muon goi gi?",
    "Chao mung ban. Ban muon uong gi hom nay de minh goi y?",
    "Hi ban. Minh la robot goi mon. Ban can minh giup gi?",
]

_CART_UPDATED_SUFFIXES = [
    " Ban muon goi them gi khong?",
    " Ban can gi them khong?",
    " Ban muon order them khong?",
    "",
]

_RESET_REPLIES = [
    "Minh da xoa gio hang roi. Ban muon goi mon nao tiep?",
    "Gio hang da duoc lam moi. Ban chon lai mon nao nhe?",
    "Minh da reset gio hang roi. Ban bat dau lai nhe!",
]

_FALLBACK_REPLIES = [
    "Minh nghe chua ro. Ban co the noi ten mon hoac bao minh tu van nhe.",
    "Minh chua hieu y ban. Ban thu noi ten mon cu the giup minh nhe.",
    "Xin loi, minh nghe khong ro. Ban noi lai ten mon hoac hoi minh goi y nhe.",
]

_SOFT_REDIRECT_PATTERNS = {
    "sing": [re.compile(r"\bhat\b"), re.compile(r"\bca\b")],
    "poem": [re.compile(r"\btho\b"), re.compile(r"\blam tho\b")],
    "heart": [re.compile(r"\btam su\b"), re.compile(r"\bbuon\b"), re.compile(r"\bmet\b"), re.compile(r"\bco don\b")],
}

_SOFT_REDIRECT_REPLIES = {
    "sing": [
        "Minh xin no mot cau hat de thuong thoi nhe, gio ban chon mon de minh phuc vu lien nhe.",
        "Minh hat do nen xin phep chieu ban bang do uong ngon hon nhe, ban muon goi mon gi?",
    ],
    "poem": [
        "Minh gui mot van tho ngan trong long thoi, con ngoai doi moi ban chon mon hop mood nhe.",
        "Minh lam tho it chu thoi keo quen order mat, ban muon minh goi y mon nao hop tam trang?",
    ],
    "heart": [
        "Neu ban dang met hay buon thi de minh o day noi chuyen mot chut roi goi y mon hop tam trang cho ban nhe.",
        "Nghe ban noi vay la minh muon cham ban bang mot mon that hop gu roi do, ban thich ngot diu hay dam vi hon?",
    ],
}

_ORDER_CREATED_SUFFIXES = [
    " Hen gap lai ban nhe!",
    " Chuc ban ngon mieng nhe!",
    " Cam on ban nhieu!",
    "",
]

_MOJIBAKE_MARKERS = ("Ã", "Ä", "á»", "áº", "Æ", "â€")
_SAFE_SCENE_REPLIES = {
    "greeting_intro": "Chao mung ban. Hom nay ban muon thu mon nao?",
    "greeting": "Xin chao. Ban muon goi mon gi hom nay?",
    "cart_updated": "Minh da them vao gio hang. Ban muon goi them gi khong?",
    "ask_confirmation": "Minh doc lai gio hang. Neu dung thi noi xac nhan.",
    "order_created": "Don cua ban da tao thanh cong. Cam on ban.",
    "recommendation": "Minh co vai goi y de uong. Ban muon thu mon nao?",
    "clarify_item": "Minh thay co vai mon gan giong. Ban muon mon nao?",
    "remove_item": "Minh da cap nhat gio hang theo yeu cau.",
    "reset": "Minh da lam moi gio hang. Ban muon goi mon nao tiep?",
    "fallback": "Minh chua nghe ro. Ban noi ten mon hoac yeu cau ngan gon giup minh nhe.",
    "cart_follow_up": "Gio hang van dang giu. Ban muon minh doc lai khong?",
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


def ensure_frontend_safe_reply(scene: str, value: object) -> str:
    repaired = repair_mojibake_text(value)
    if not repaired.strip():
        return _SAFE_SCENE_REPLIES.get(scene, _SAFE_SCENE_REPLIES["fallback"])
    if any(marker in repaired for marker in _MOJIBAKE_MARKERS):
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
            return repair_mojibake_text(f"Minh thay co may mon gan giong: {names}. Ban muon goi mon nao?")
        return repair_mojibake_text(f"{seed} Ban noi ro ten mon giup minh nhe.")
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
            return repair_mojibake_text(f"{seed}\n{items_text}\nBan thich mon nao de minh them vao gio nhe?")
        return repair_mojibake_text(f"{seed} Ban muon minh goi y them khong?")
    if scene == "ask_confirmation":
        if cart_summary:
            details = ", ".join(
                f"{item['quantity']} {item['name']} ({item['line_total']}d)"
                for item in cart_summary
            )
            total = sum(int(item['line_total']) for item in cart_summary)
            return repair_mojibake_text(
                f"Minh doc lai gio hang nhe: {details}. "
                f"Tong cong {total:,}d. "
                f"Ban noi 'xac nhan' de minh len don, "
                f"hoac noi ten mon de them nha."
            )
        return repair_mojibake_text(f"{seed} Ban noi 'xac nhan' giup minh nhe.")
    if scene == "order_created":
        return repair_mojibake_text(seed + random.choice(_ORDER_CREATED_SUFFIXES))
    if scene == "cart_follow_up":
        if cart_summary:
            details = ", ".join(f"{item['quantity']} {item['name']}" for item in cart_summary)
            return repair_mojibake_text(f"{seed} Gio hang hien co {details}.")
        return repair_mojibake_text(seed)
    return repair_mojibake_text(seed)


def _render_soft_redirect(user_text: str) -> str | None:
    normalized = normalize_text(user_text)
    if not normalized:
        return None

    for key, patterns in _SOFT_REDIRECT_PATTERNS.items():
        if any(pattern.search(normalized) for pattern in patterns):
            return ensure_frontend_safe_reply("fallback", random.choice(_SOFT_REDIRECT_REPLIES[key]))
    return None

