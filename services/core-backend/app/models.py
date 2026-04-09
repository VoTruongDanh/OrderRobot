from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MenuItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    item_id: str
    name: str
    category: str
    description: str
    image_url: str | None = None
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
    available: bool = True


class UpsertMenuItemRequest(BaseModel):
    item_id: str
    name: str
    category: str
    description: str
    image_url: str | None = None
    price: Decimal
    available: bool
    tags: list[str] = Field(default_factory=list)


class CreateOrderLineInput(BaseModel):
    item_id: str
    quantity: int = Field(gt=0, le=20)
    size_name: str | None = None
    size_id: int | None = None


class CreateOrderRequest(BaseModel):
    session_id: str
    customer_text: str = ""
    items: list[CreateOrderLineInput] = Field(min_length=1)


class OrderLineItem(BaseModel):
    item_id: str
    name: str
    quantity: int = Field(gt=0)
    unit_price: Decimal = Field(ge=0)
    line_total: Decimal = Field(ge=0)


class OrderRecord(BaseModel):
    order_id: str
    session_id: str
    created_at: datetime
    customer_text: str
    items: list[OrderLineItem]
    total_amount: Decimal = Field(ge=0)
    status: str = "confirmed"
    payment_provider: str | None = None
    payment_status: str | None = None
    payment_qr_content: str | None = None
    payment_qr_image_url: str | None = None
    payment_amount: Decimal | None = Field(default=None, ge=0)
    payment_expires_at: datetime | None = None
    sync_error_code: str | None = None
    sync_error_detail: str | None = None
