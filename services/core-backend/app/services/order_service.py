from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from app.models import CreateOrderRequest, OrderLineItem, OrderRecord
from app.repositories.contracts import MenuRepository, OrderRepository


class OrderService:
    def __init__(self, menu_repository: MenuRepository, order_repository: OrderRepository) -> None:
        self.menu_repository = menu_repository
        self.order_repository = order_repository

    def create_order(self, payload: CreateOrderRequest) -> OrderRecord:
        quantities = Counter[str]()
        for item in payload.items:
            quantities[item.item_id] += item.quantity

        menu_items = self.menu_repository.get_items_by_ids(list(quantities.keys()))
        missing_items = [item_id for item_id in quantities if item_id not in menu_items]
        if missing_items:
            missing_text = ", ".join(missing_items)
            raise ValueError(f"Khong tim thay mon trong menu: {missing_text}")

        line_items: list[OrderLineItem] = []
        total_amount = Decimal("0")
        for item_id, quantity in quantities.items():
            menu_item = menu_items[item_id]
            if not menu_item.available:
                raise ValueError(f"Mon '{menu_item.name}' hien tam het hang.")
            line_total = menu_item.price * quantity
            total_amount += line_total
            line_items.append(
                OrderLineItem(
                    item_id=menu_item.item_id,
                    name=menu_item.name,
                    quantity=quantity,
                    unit_price=menu_item.price,
                    line_total=line_total,
                )
            )

        order_record = OrderRecord(
            order_id=f"ORD-{uuid4().hex[:8].upper()}",
            session_id=payload.session_id,
            created_at=datetime.now(UTC),
            customer_text=payload.customer_text.strip(),
            items=line_items,
            total_amount=total_amount,
        )
        return self.order_repository.create_order(order_record)

    def get_order(self, order_id: str) -> OrderRecord | None:
        return self.order_repository.get_order(order_id)
