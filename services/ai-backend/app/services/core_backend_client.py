from __future__ import annotations

from typing import Any

import httpx

from app.models import CreateOrderRequest, CreateOrderResponse, MenuItem, MenuItemSizeOption


class CoreBackendClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout_seconds,
        )

    async def list_menu(self) -> list[MenuItem]:
        response = await self.client.get("/menu")
        response.raise_for_status()
        return [MenuItem.model_validate(item) for item in response.json()]

    async def create_order(self, payload: CreateOrderRequest) -> CreateOrderResponse:
        response = await self.client.post("/orders", json=payload.model_dump(mode="json"))
        response.raise_for_status()
        data: dict[str, Any] = response.json()
        return CreateOrderResponse(
            order_id=str(data["order_id"]),
            payment_status=data.get("payment_status"),
            payment_qr_content=data.get("payment_qr_content"),
            payment_qr_image_url=data.get("payment_qr_image_url"),
            payment_amount=data.get("payment_amount"),
            payment_expires_at=data.get("payment_expires_at"),
            sync_error_code=data.get("sync_error_code"),
            sync_error_detail=data.get("sync_error_detail"),
        )

    async def get_item_sizes(self, item_id: str) -> list[MenuItemSizeOption]:
        response = await self.client.get(f"/menu/{item_id}/sizes")
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, list):
            return []
        return [MenuItemSizeOption.model_validate(item) for item in data]

    async def aclose(self) -> None:
        await self.client.aclose()

