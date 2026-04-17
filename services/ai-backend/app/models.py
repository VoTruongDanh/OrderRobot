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


class MenuItemSizeOption(BaseModel):
    item_id: str
    product_id: int | None = None
    size_id: int | None = None
    size_name: str
    price: Decimal = Field(ge=0)
    is_default: bool = False


class CartItem(BaseModel):
    item_id: str
    name: str
    quantity: int = Field(gt=0)
    size_name: str | None = None
    size_id: int | None = None
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
    store_id: int | None = Field(default=None, ge=1)
    table_id: int | None = Field(default=None, ge=1)


class TurnRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=500)
    turn_id: str | None = Field(default=None, min_length=1, max_length=120)
    include_audio: bool = True
    quick_checkout: bool = False
    store_id: int | None = Field(default=None, ge=1)
    table_id: int | None = Field(default=None, ge=1)


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
    vieneu_mode: str | None = Field(default=None, max_length=24)
    vieneu_backbone_device: str | None = Field(default=None, max_length=24)
    vieneu_codec_repo: str | None = Field(default=None, max_length=1024)
    vieneu_codec_device: str | None = Field(default=None, max_length=24)
    vieneu_remote_api_base: str | None = Field(default=None, max_length=1024)
    vieneu_voice_id: str | None = Field(default=None, max_length=120)
    vieneu_ref_audio: str | None = Field(default=None, max_length=1024)
    vieneu_ref_text: str | None = Field(default=None, max_length=1000)
    vieneu_temperature: float | None = Field(default=None, ge=0.1, le=2.0)
    vieneu_top_k: int | None = Field(default=None, ge=1, le=200)
    vieneu_max_chars: int | None = Field(default=None, ge=32, le=512)
    vieneu_stream_frames_per_chunk: int | None = Field(default=None, ge=8, le=64)
    vieneu_stream_lookforward: int | None = Field(default=None, ge=0, le=32)
    vieneu_stream_lookback: int | None = Field(default=None, ge=8, le=256)
    vieneu_stream_overlap_frames: int | None = Field(default=None, ge=1, le=8)

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
            "tts_vieneu_mode": "vieneu_mode",
            "tts_vieneu_backbone_device": "vieneu_backbone_device",
            "tts_vieneu_codec_repo": "vieneu_codec_repo",
            "tts_vieneu_codec_device": "vieneu_codec_device",
            "tts_vieneu_remote_api_base": "vieneu_remote_api_base",
            "tts_vieneu_voice_id": "vieneu_voice_id",
            "tts_vieneu_ref_audio": "vieneu_ref_audio",
            "tts_vieneu_ref_text": "vieneu_ref_text",
            "tts_vieneu_temperature": "vieneu_temperature",
            "tts_vieneu_top_k": "vieneu_top_k",
            "tts_vieneu_max_chars": "vieneu_max_chars",
            "tts_vieneu_stream_frames_per_chunk": "vieneu_stream_frames_per_chunk",
            "tts_vieneu_stream_lookforward": "vieneu_stream_lookforward",
            "tts_vieneu_stream_lookback": "vieneu_stream_lookback",
            "tts_vieneu_stream_overlap_frames": "vieneu_stream_overlap_frames",
        }
        payload = dict(data)
        for legacy_key, canonical_key in aliases.items():
            if canonical_key not in payload and legacy_key in payload:
                payload[canonical_key] = payload[legacy_key]
        return payload


class EnvSyncRequest(BaseModel):
    fields: dict[str, str] = Field(default_factory=dict)


class EnvSyncResponse(BaseModel):
    status: Literal["ok"]
    env_path: str
    updated_keys: int = Field(ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class EnvLoadRequest(BaseModel):
    keys: list[str] = Field(default_factory=list)


class EnvLoadResponse(BaseModel):
    status: Literal["ok"]
    env_path: str
    fields: dict[str, str] = Field(default_factory=dict)
    loaded_keys: int = Field(ge=0)
    loaded_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SharedAdminStateSyncRequest(BaseModel):
    robot_scale_percent: int | None = None
    camera_preview_visible: bool | None = None
    mic_noise_filter_strength: int | None = None
    robot_studio_config: dict[str, object] | None = None


class SharedAdminStateResponse(BaseModel):
    status: Literal["ok"]
    state_path: str
    fields: dict[str, object] = Field(default_factory=dict)
    loaded_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


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
    payment_status: str | None = None
    payment_qr_content: str | None = None
    payment_qr_image_url: str | None = None
    payment_amount: Decimal | None = None
    payment_expires_at: datetime | None = None
    sync_error_code: str | None = None
    sync_error_detail: str | None = None
    voice_style: str
    scene: str | None = None
    emotion_hint: Literal["neutral", "happy", "cute", "excited", "focused"] | None = None
    action_hints: list[str] = Field(default_factory=list)


class CreateOrderLineItem(BaseModel):
    item_id: str
    quantity: int = Field(gt=0)
    size_name: str | None = None
    size_id: int | None = None


class CreateOrderRequest(BaseModel):
    session_id: str
    customer_text: str
    table_id: int | None = Field(default=None, ge=1)
    items: list[CreateOrderLineItem]


class CreateOrderResponse(BaseModel):
    order_id: str
    payment_status: str | None = None
    payment_qr_content: str | None = None
    payment_qr_image_url: str | None = None
    payment_amount: Decimal | None = None
    payment_expires_at: datetime | None = None
    sync_error_code: str | None = None
    sync_error_detail: str | None = None


@dataclass(slots=True)
class SessionState:
    session_id: str
    store_id: int | None = None
    table_id: int | None = None
    cart: dict[str, int] = field(default_factory=dict)
    cart_unit_price_by_item: dict[str, Decimal] = field(default_factory=dict)
    cart_size_by_item: dict[str, str] = field(default_factory=dict)
    cart_size_id_by_item: dict[str, int] = field(default_factory=dict)
    pending_size_item_id: str | None = None
    pending_size_item_name: str | None = None
    pending_size_quantity: int = 1
    pending_size_options: list[str] = field(default_factory=list)
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
    payment_status: str | None = None
    payment_qr_content: str | None = None
    payment_qr_image_url: str | None = None
    payment_amount: Decimal | None = None
    payment_expires_at: datetime | None = None
    sync_error_code: str | None = None
    sync_error_detail: str | None = None
    user_text: str | None = None

