from __future__ import annotations

import csv
import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from app.models import MenuItem, OrderLineItem, OrderRecord


MENU_HEADERS = [
    "item_id",
    "name",
    "category",
    "description",
    "image_url",
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
    "payment_provider",
    "payment_status",
    "payment_qr_content",
    "payment_qr_image_url",
    "payment_amount",
    "payment_expires_at",
    "sync_error_code",
    "sync_error_detail",
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
        # Use utf-8-sig so CSV files saved with BOM still parse correct headers (item_id, ...).
        with self.csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
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
            image_url=(row.get("image_url") or "").strip() or None,
            price=Decimal(row["price"]),
            available=row["available"].strip().lower() == "true",
            tags=tags,
        )

    def list_menu(self) -> list[MenuItem]:
        return self._read_rows()

    def get_menu_item(self, item_id: str) -> MenuItem | None:
        for item in self._read_rows():
            if item.item_id == item_id:
                return item
        return None

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

    def upsert_menu_item(self, item: MenuItem) -> MenuItem:
        items = self._read_rows()
        updated = False
        for index, existing in enumerate(items):
            if existing.item_id == item.item_id:
                items[index] = item
                updated = True
                break
        if not updated:
            items.append(item)

        with self.csv_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=MENU_HEADERS)
            writer.writeheader()
            for menu_item in items:
                writer.writerow(
                    {
                        "item_id": menu_item.item_id,
                        "name": menu_item.name,
                        "category": menu_item.category,
                        "description": menu_item.description,
                        "image_url": menu_item.image_url or "",
                        "price": str(menu_item.price),
                        "available": str(menu_item.available).lower(),
                        "tags": ",".join(menu_item.tags),
                    }
                )
        return item


class CsvOrderRepository:
    def __init__(self, csv_path: Path) -> None:
        self.csv_path = csv_path
        self.csv_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.csv_path.exists():
            with self.csv_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=ORDER_HEADERS)
                writer.writeheader()
        else:
            self._ensure_order_schema()

    def _ensure_order_schema(self) -> None:
        with self.csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            fieldnames = [str(name).strip() for name in (reader.fieldnames or []) if name is not None]
            rows: list[dict[str, str]] = []
            for row in reader:
                if not isinstance(row, dict):
                    continue
                normalized_row: dict[str, str] = {}
                for key, value in row.items():
                    if key is None:
                        continue
                    normalized_row[str(key).strip()] = "" if value is None else str(value)
                if not normalized_row:
                    continue
                rows.append(normalized_row)

        # Already newest schema.
        if fieldnames == ORDER_HEADERS:
            return

        # Rewrite with canonical header while preserving known values.
        with self.csv_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=ORDER_HEADERS)
            writer.writeheader()
            for row in rows:
                writer.writerow({header: row.get(header, "") for header in ORDER_HEADERS})

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
            "payment_provider": record.payment_provider or "",
            "payment_status": record.payment_status or "",
            "payment_qr_content": record.payment_qr_content or "",
            "payment_qr_image_url": record.payment_qr_image_url or "",
            "payment_amount": "" if record.payment_amount is None else str(record.payment_amount),
            "payment_expires_at": "" if record.payment_expires_at is None else record.payment_expires_at.isoformat(),
            "sync_error_code": record.sync_error_code or "",
            "sync_error_detail": record.sync_error_detail or "",
        }

        with self.csv_path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=ORDER_HEADERS)
            writer.writerow(row)
        return record

    def get_order(self, order_id: str) -> OrderRecord | None:
        with self.csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if row.get("order_id") != order_id:
                    continue
                return self._row_to_order_record(row)
        return None

    def list_orders(self, *, session_id: str | None = None, limit: int = 100) -> list[OrderRecord]:
        records: list[OrderRecord] = []
        with self.csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if session_id and row.get("session_id") != session_id:
                    continue
                records.append(self._row_to_order_record(row))

        records.sort(key=lambda record: record.created_at, reverse=True)
        return records[:limit]

    @staticmethod
    def _row_to_order_record(row: dict[str, str]) -> OrderRecord:
        try:
            raw_items = json.loads(row.get("items_json", "[]"))
        except json.JSONDecodeError:
            raw_items = []
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
        created_at_raw = str(row.get("created_at") or "").strip()
        try:
            created_at_value = datetime.fromisoformat(created_at_raw) if created_at_raw else datetime.now(UTC)
        except ValueError:
            created_at_value = datetime.now(UTC)
        return OrderRecord(
            order_id=row["order_id"],
            session_id=row["session_id"],
            created_at=created_at_value,
            customer_text=row.get("customer_text", ""),
            items=items,
            total_amount=Decimal(row["total_amount"]),
            status=row.get("status", "confirmed"),
            payment_provider=(row.get("payment_provider") or "").strip() or None,
            payment_status=(row.get("payment_status") or "").strip() or None,
            payment_qr_content=(row.get("payment_qr_content") or "").strip() or None,
            payment_qr_image_url=(row.get("payment_qr_image_url") or "").strip() or None,
            payment_amount=(
                Decimal(str(row.get("payment_amount")))
                if (row.get("payment_amount") or "").strip()
                else None
            ),
            payment_expires_at=(
                datetime.fromisoformat(str(row.get("payment_expires_at")))
                if (row.get("payment_expires_at") or "").strip()
                else None
            ),
            sync_error_code=(row.get("sync_error_code") or "").strip() or None,
            sync_error_detail=(row.get("sync_error_detail") or "").strip() or None,
        )
