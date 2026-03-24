from __future__ import annotations

import csv
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from app.models import MenuItem, OrderLineItem, OrderRecord


MENU_HEADERS = [
    "item_id",
    "name",
    "category",
    "description",
    "price",
    "available",
    "tags",
]

ORDER_HEADERS = [
    "order_id",
    "session_id",
    "created_at",
    "customer_text",
    "items_json",
    "total_amount",
    "status",
]


class CsvMenuRepository:
    def __init__(self, csv_path: Path) -> None:
        self.csv_path = csv_path
        self.csv_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.csv_path.exists():
            with self.csv_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=MENU_HEADERS)
                writer.writeheader()

    def _read_rows(self) -> list[MenuItem]:
        with self.csv_path.open("r", newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            return [self._row_to_menu_item(row) for row in reader]

    @staticmethod
    def _row_to_menu_item(row: dict[str, str]) -> MenuItem:
        tags = [tag.strip() for tag in row.get("tags", "").split(",") if tag.strip()]
        return MenuItem(
            item_id=row["item_id"],
            name=row["name"],
            category=row["category"],
            description=row["description"],
            price=Decimal(row["price"]),
            available=row["available"].strip().lower() == "true",
            tags=tags,
        )

    def list_menu(self) -> list[MenuItem]:
        return self._read_rows()

    def search_menu(self, query: str) -> list[MenuItem]:
        normalized_query = query.casefold().strip()
        if not normalized_query:
            return self.list_menu()

        tokens = [token for token in normalized_query.split() if token]
        matches: list[tuple[int, MenuItem]] = []
        for item in self._read_rows():
            haystack = " ".join(
                [
                    item.name,
                    item.category,
                    item.description,
                    " ".join(item.tags),
                ]
            ).casefold()
            score = 0
            for token in tokens:
                if token in haystack:
                    score += 2
                if token in item.name.casefold():
                    score += 3
                if token in item.category.casefold():
                    score += 1
            if normalized_query in haystack:
                score += 4
            if score > 0:
                if item.available:
                    score += 1
                matches.append((score, item))

        matches.sort(key=lambda pair: (-pair[0], pair[1].name))
        return [item for _, item in matches]

    def get_items_by_ids(self, item_ids: list[str]) -> dict[str, MenuItem]:
        item_lookup = {item.item_id: item for item in self._read_rows()}
        return {item_id: item_lookup[item_id] for item_id in item_ids if item_id in item_lookup}


class CsvOrderRepository:
    def __init__(self, csv_path: Path) -> None:
        self.csv_path = csv_path
        self.csv_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.csv_path.exists():
            with self.csv_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=ORDER_HEADERS)
                writer.writeheader()

    def create_order(self, record: OrderRecord) -> OrderRecord:
        items_json = json.dumps(
            [item.model_dump(mode="json") for item in record.items],
            ensure_ascii=False,
        )
        row = {
            "order_id": record.order_id,
            "session_id": record.session_id,
            "created_at": record.created_at.isoformat(),
            "customer_text": record.customer_text,
            "items_json": items_json,
            "total_amount": str(record.total_amount),
            "status": record.status,
        }

        with self.csv_path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=ORDER_HEADERS)
            writer.writerow(row)
        return record

    def get_order(self, order_id: str) -> OrderRecord | None:
        with self.csv_path.open("r", newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if row.get("order_id") != order_id:
                    continue
                return self._row_to_order_record(row)
        return None

    @staticmethod
    def _row_to_order_record(row: dict[str, str]) -> OrderRecord:
        raw_items = json.loads(row.get("items_json", "[]"))
        items = [
            OrderLineItem(
                item_id=item["item_id"],
                name=item["name"],
                quantity=int(item["quantity"]),
                unit_price=Decimal(str(item["unit_price"])),
                line_total=Decimal(str(item["line_total"])),
            )
            for item in raw_items
        ]
        return OrderRecord(
            order_id=row["order_id"],
            session_id=row["session_id"],
            created_at=datetime.fromisoformat(row["created_at"]),
            customer_text=row.get("customer_text", ""),
            items=items,
            total_amount=Decimal(row["total_amount"]),
            status=row.get("status", "confirmed"),
        )
