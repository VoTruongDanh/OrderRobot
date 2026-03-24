from __future__ import annotations

from typing import Protocol

from app.models import MenuItem, OrderRecord


class MenuRepository(Protocol):
    def list_menu(self) -> list[MenuItem]:
        ...

    def search_menu(self, query: str) -> list[MenuItem]:
        ...

    def get_items_by_ids(self, item_ids: list[str]) -> dict[str, MenuItem]:
        ...


class OrderRepository(Protocol):
    def create_order(self, record: OrderRecord) -> OrderRecord:
        ...

    def get_order(self, order_id: str) -> OrderRecord | None:
        ...
