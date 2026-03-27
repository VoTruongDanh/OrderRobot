from __future__ import annotations

from datetime import UTC, datetime
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, model_validator


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
    needs_improvement: bool | None = None
    improvement_tags: list[str] = Field(default_factory=list)
    review_status: Literal["new", "triaged", "resolved"] = "new"


class TTSConfigRequest(BaseModel):
    voice: str | None = None
    rate: int | None = Field(default=None, ge=100, le=300)
    engine: str | None = None
    vieneu_model_path: str | None = Field(default=None, max_length=1024)
    vieneu_voice_id: str | None = Field(default=None, max_length=120)
    vieneu_ref_audio: str | None = Field(default=None, max_length=1024)
    vieneu_ref_text: str | None = Field(default=None, max_length=1000)
    vieneu_temperature: float | None = Field(default=None, ge=0.1, le=2.0)
    vieneu_top_k: int | None = Field(default=None, ge=1, le=200)
    vieneu_max_chars: int | None = Field(default=None, ge=32, le=512)

    @model_validator(mode="before")
    @classmethod
    def _apply_legacy_aliases(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        aliases = {
            "tts_voice": "voice",
            "tts_rate": "rate",
            "tts_engine": "engine",
            "tts_vieneu_model_path": "vieneu_model_path",
            "tts_vieneu_voice_id": "vieneu_voice_id",
            "tts_vieneu_ref_audio": "vieneu_ref_audio",
            "tts_vieneu_ref_text": "vieneu_ref_text",
            "tts_vieneu_temperature": "vieneu_temperature",
            "tts_vieneu_top_k": "vieneu_top_k",
            "tts_vieneu_max_chars": "vieneu_max_chars",
        }
        payload = dict(data)
        for legacy_key, canonical_key in aliases.items():
            if canonical_key not in payload and legacy_key in payload:
                payload[canonical_key] = payload[legacy_key]
        return payload


class SpeechSynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    voice: str | None = None
    rate: int | None = Field(default=None, ge=100, le=300)
    engine: str | None = None
    vieneu_voice_id: str | None = Field(default=None, max_length=120)
    vieneu_ref_audio: str | None = Field(default=None, max_length=1024)
    vieneu_ref_text: str | None = Field(default=None, max_length=1000)
    vieneu_temperature: float | None = Field(default=None, ge=0.1, le=2.0)
    vieneu_top_k: int | None = Field(default=None, ge=1, le=200)
    vieneu_max_chars: int | None = Field(default=None, ge=32, le=512)

    @model_validator(mode="before")
    @classmethod
    def _apply_legacy_aliases(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        aliases = {
            "tts_voice": "voice",
            "tts_rate": "rate",
            "tts_engine": "engine",
            "tts_vieneu_voice_id": "vieneu_voice_id",
            "tts_vieneu_ref_audio": "vieneu_ref_audio",
            "tts_vieneu_ref_text": "vieneu_ref_text",
            "tts_vieneu_temperature": "vieneu_temperature",
            "tts_vieneu_top_k": "vieneu_top_k",
            "tts_vieneu_max_chars": "vieneu_max_chars",
        }
        payload = dict(data)
        for legacy_key, canonical_key in aliases.items():
            if canonical_key not in payload and legacy_key in payload:
                payload[canonical_key] = payload[legacy_key]
        return payload


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
    scene: str | None = None
    emotion_hint: Literal["neutral", "happy", "cute", "excited", "focused"] | None = None
    action_hints: list[str] = Field(default_factory=list)


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

