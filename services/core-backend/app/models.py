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
    price: Decimal
    available: bool
    tags: list[str] = Field(default_factory=list)


class UpsertMenuItemRequest(BaseModel):
    item_id: str
    name: str
    category: str
    description: str
    price: Decimal
    available: bool
    tags: list[str] = Field(default_factory=list)


class CreateOrderLineInput(BaseModel):
    item_id: str
    quantity: int = Field(gt=0, le=20)


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
    status: Literal["confirmed"] = "confirmed"
