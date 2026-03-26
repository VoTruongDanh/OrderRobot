from __future__ import annotations

from datetime import UTC, datetime
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field


class MenuItem(BaseModel):
    item_id: str
    name: str
    category: str
    description: str
    price: Decimal
    available: bool
    tags: list[str] = Field(default_factory=list)


class CartItem(BaseModel):
    item_id: str
    name: str
    quantity: int = Field(gt=0)
    unit_price: Decimal = Field(ge=0)
    line_total: Decimal = Field(ge=0)
    
    def model_dump(self, **kwargs):
        """Override to convert Decimal to float for JSON serialization."""
        data = super().model_dump(**kwargs)
        data["unit_price"] = float(data["unit_price"])
        data["line_total"] = float(data["line_total"])
        return data


class SessionStartRequest(BaseModel):
    source: Literal["camera", "manual"] = "camera"


class TurnRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=500)


class BridgeDebugChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    rule: str | None = Field(default=None, max_length=500)


class BridgeDebugChatResponse(BaseModel):
    reply_text: str
    source: Literal["bridge", "fallback"]
    bridge_enabled: bool
    latency_ms: int = Field(ge=0)
    detail: str | None = None


class BridgeTemporaryChatResetResponse(BaseModel):
    ok: bool
    source: Literal["bridge", "fallback"]
    detail: str | None = None


class FeedbackRequest(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = None
    transcript_history: list[str] = Field(default_factory=list)


class TTSConfigRequest(BaseModel):
    voice: str | None = None
    rate: int | None = Field(default=None, ge=100, le=300)


class SpeechSynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    voice: str | None = None
    rate: int | None = Field(default=None, ge=100, le=300)


class SpeechTranscriptionResponse(BaseModel):
    transcript: str = ""
    status: Literal["ok", "retry"] = "ok"
    message: str | None = None


class ConversationResponse(BaseModel):
    session_id: str
    reply_text: str
    cart: list[CartItem] = Field(default_factory=list)
    recommended_item_ids: list[str] = Field(default_factory=list)
    needs_confirmation: bool = False
    order_created: bool = False
    order_id: str | None = None
    voice_style: str


class CreateOrderLineItem(BaseModel):
    item_id: str
    quantity: int = Field(gt=0)


class CreateOrderRequest(BaseModel):
    session_id: str
    customer_text: str
    items: list[CreateOrderLineItem]


class CreateOrderResponse(BaseModel):
    order_id: str


@dataclass(slots=True)
class SessionState:
    session_id: str
    cart: dict[str, int] = field(default_factory=dict)
    history: list[str] = field(default_factory=list)
    awaiting_confirmation: bool = False
    greeted: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    last_interaction_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(slots=True)
class Decision:
    scene: str
    reply_seed: str
    recommended_item_ids: list[str] = field(default_factory=list)
    needs_confirmation: bool = False
    order_created: bool = False
    order_id: str | None = None
    user_text: str | None = None
