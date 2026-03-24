from __future__ import annotations

from typing import Any

import httpx

from app.models import CreateOrderRequest, CreateOrderResponse, MenuItem


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
        return CreateOrderResponse(order_id=data["order_id"])

