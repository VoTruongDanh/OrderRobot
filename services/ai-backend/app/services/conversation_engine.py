from __future__ import annotations

import asyncio
import base64
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from threading import Lock
from uuid import uuid4

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
}
CONFIRM_KEYWORDS = {"xac nhan", "dong y", "ok", "oke", "dat di", "chot don"}
RESET_KEYWORDS = {"huy", "lam lai", "dat lai", "bo het"}
REMOVE_KEYWORDS = {"bo", "xoa", "huy mon", "khong lay"}
RECOMMEND_KEYWORDS = {"goi y", "tu van", "nen uong", "nen an", "de uong", "it ngot", "mon nao"}
CHECKOUT_KEYWORDS = {"xong", "dat luon", "len don", "chot don", "thanh toan"}
SEGMENT_SPLIT_PATTERN = re.compile(r"\s*(?:,|\bva\b|\bvoi\b|\bcung\b|\bthem\b)\s*")


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

        menu = await self.core_client.list_menu()
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
        matches: list[MenuItem] = []
        for item in menu:
            normalized_name = normalize_text(item.name)
            if normalized_name in normalized_transcript:
                matches.append(item)
                continue
            name_tokens = [token for token in normalized_name.split() if len(token) > 2]
            if name_tokens and all(token in normalized_transcript for token in name_tokens):
                matches.append(item)
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
            score = 0
            for token in tokens:
                if token in haystack:
                    score += 2
                if token in normalize_text(item.name):
                    score += 4
                if token in " ".join(normalize_text(tag) for tag in item.tags):
                    score += 3
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
        
        This method enables progressive response delivery:
        1. LLM streams text sentence by sentence
        2. Each sentence is immediately sent to TTS
        3. Audio chunks stream back as they're generated
        
        Result: User hears the first sentence while later sentences are still being generated.
        """
        # Note: Streaming only provides benefit when provider is enabled and supports streaming
        # For fallback responses, we just use regular handle_turn
        if not self.provider_client:
            response = await self.handle_turn(session_id, transcript)
            yield {"type": "text", "content": response.reply_text, "cart": [item.model_dump() for item in response.cart]}
            
            # Stream audio for fallback response
            from app.services.speech_service import SpeechService
            speech_service = SpeechService(self.settings, self.core_client)
            try:
                async for audio_chunk in speech_service.synthesize_stream(response.reply_text):
                    yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}
            except Exception:
                pass
            return

        # For provider-enabled streaming, we need to handle the conversation logic inline
        # to stream LLM output as it arrives
        with self.lock:
            self._cleanup_expired_sessions()
            state = self.sessions.get(session_id)
            if state is None:
                state = SessionState(session_id=session_id)
                self.sessions[session_id] = state
            self._touch_state(state)
            state.history.append(transcript)

        menu = await self.core_client.list_menu()
        normalized = normalize_text(transcript)

        # Determine the decision (same logic as handle_turn)
        decision = None
        
        if state.cart and contains_any(normalized, CONFIRM_KEYWORDS):
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
                decision = Decision(
                    scene="order_created",
                    reply_seed=f"Đã xong rồi ạ. Em đã lên đơn thành công với mã {order.order_id}. Cảm ơn mình nha.",
                    order_created=True,
                    order_id=order.order_id,
                )
        
        # For complex decisions, fall back to regular response
        if decision is None:
            response = await self.handle_turn(session_id, transcript)
            yield {"type": "text", "content": response.reply_text, "cart": [item.model_dump() for item in response.cart]}
            
            from app.services.speech_service import SpeechService
            speech_service = SpeechService(self.settings, self.core_client)
            try:
                async for audio_chunk in speech_service.synthesize_stream(response.reply_text):
                    yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}
            except Exception:
                pass
            return

        # Stream the decision response
        cart = build_cart_items(state.cart, menu)
        prompt_payload = {
            "scene": decision.scene,
            "seed": decision.reply_seed,
            "cart_summary": [
                {"name": item.name, "quantity": item.quantity, "line_total": str(item.line_total)}
                for item in cart
            ],
            "recommended_items": [],
            "needs_confirmation": decision.needs_confirmation,
            "order_created": decision.order_created,
            "voice_style": self.settings.voice_style,
        }

        from app.services.speech_service import SpeechService
        speech_service = SpeechService(self.settings, self.core_client)
        
        try:
            # Stream from LLM sentence by sentence
            async for sentence in self.provider_client.compose_reply_stream(prompt_payload):
                yield {"type": "text", "content": sentence}
                
                # Immediately stream audio for this sentence
                async for audio_chunk in speech_service.synthesize_stream(sentence):
                    yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}
        except Exception:
            # Fallback to seed text
            yield {"type": "text", "content": decision.reply_seed}
            async for audio_chunk in speech_service.synthesize_stream(decision.reply_seed):
                yield {"type": "audio", "content": base64.b64encode(audio_chunk).decode("ascii")}

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
        menu = menu or await self.core_client.list_menu()
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

        if self.provider_client is not None:
            provider_reply = await self.provider_client.compose_reply(prompt_payload)
            reply_text = provider_reply["reply_text"]
            voice_style = provider_reply["voice_style"]
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
    digit_match = re.search(r"\b(\d+)\b", normalized_text)
    if digit_match:
        return max(1, min(int(digit_match.group(1)), 20))

    for word, value in QUANTITY_WORDS.items():
        if word in normalized_text:
            return value
    return 1


def render_fallback_reply(payload: dict[str, object]) -> str:
    scene = str(payload["scene"])
    seed = str(payload["seed"])
    cart_summary = payload.get("cart_summary", [])
    recommended_items = payload.get("recommended_items", [])

    if scene == "greeting":
        return "Xin chào mình ạ. Em là robot gọi món, mình muốn uống gì hôm nay để em tư vấn nhé?"
    if scene in {"cart_updated", "remove_item", "reset", "fallback"}:
        return seed
    if scene == "clarify_item":
        return f"{seed} Em đang thấy vài lựa chọn gần đúng cho mình đây."
    if scene == "recommendation":
        item_names = (
            ", ".join(item["name"] for item in recommended_items[:3])
            if recommended_items
            else "một vài món dễ uống"
        )
        return f"{seed} Em gợi ý {item_names}. Mình ưng ý món nào để em thêm vào giỏ nhé?"
    if scene == "ask_confirmation":
        if cart_summary:
            details = ", ".join(f"{item['quantity']} {item['name']}" for item in cart_summary)
            return f"{seed} Hiện giờ mình đang có {details}. Nếu đúng rồi mình nói 'xác nhận' giúp em nha."
        return f"{seed} Mình nói 'xác nhận' giúp em nhé."
    if scene == "order_created":
        return seed
    if scene == "cart_follow_up":
        if cart_summary:
            details = ", ".join(f"{item['quantity']} {item['name']}" for item in cart_summary)
            return f"{seed} Giỏ hàng hiện có {details} ạ."
        return seed
    return seed
