from __future__ import annotations

import csv
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
import json

from fastapi.testclient import TestClient
from app.config import Settings
from app.config import get_settings
from app.models import OrderLineItem, OrderRecord
from app.repositories.csv_repositories import CsvMenuRepository, CsvOrderRepository
from app.services.order_service import OrderService


def write_menu(csv_path: Path) -> None:
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "item_id",
                "name",
                "category",
                "description",
                "price",
                "available",
                "tags",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "item_id": "tra-dao",
                "name": "Tra dao",
                "category": "Tra trai cay",
                "description": "Thanh mat",
                "price": "48000",
                "available": "true",
                "tags": "de-uong,fruit",
            }
        )


def build_settings(tmp_path: Path, **overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "menu_csv_path": tmp_path / "menu.csv",
        "orders_csv_path": tmp_path / "orders.csv",
        "pos_api_base_url": "",
        "pos_api_token": "",
        "pos_api_username": "",
        "pos_api_password": "",
        "pos_auth_login_url": "",
        "pos_auth_refresh_url": "",
        "pos_store_id": None,
        "pos_order_type": "POS",
        "pos_payment_method": "ONLINE_PAYMENT",
        "pos_tag_number": "1",
        "pos_menu_source_mode": "local",
        "pos_menu_source_url": "",
        "pos_size_source_url": "",
        "pos_default_size_name": "M",
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_menu_and_order_flow(tmp_path: Path, monkeypatch) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    monkeypatch.setenv("MENU_CSV_PATH", str(menu_path))
    monkeypatch.setenv("ORDERS_CSV_PATH", str(orders_path))
    monkeypatch.setenv("POS_MENU_SOURCE_MODE", "local")
    monkeypatch.setenv("POS_MENU_SOURCE_URL", "")
    monkeypatch.setenv("POS_SIZE_SOURCE_URL", "")

    from app.main import app

    client = TestClient(app)

    menu_response = client.get("/menu")
    assert menu_response.status_code == 200
    assert menu_response.json()[0]["item_id"] == "tra-dao"

    order_response = client.post(
        "/orders",
        json={
            "session_id": "session-1",
            "customer_text": "cho minh 2 tra dao",
            "items": [{"item_id": "tra-dao", "quantity": 2}],
        },
    )
    assert order_response.status_code == 200
    payload = order_response.json()
    assert payload["total_amount"] == "96000"
    assert orders_path.exists()

    fetch_response = client.get(f"/orders/{payload['order_id']}")
    assert fetch_response.status_code == 200
    fetched = fetch_response.json()
    assert fetched["order_id"] == payload["order_id"]
    assert fetched["items"][0]["quantity"] == 2


def test_menu_upsert_and_list_orders_api(tmp_path: Path, monkeypatch) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    monkeypatch.setenv("MENU_CSV_PATH", str(menu_path))
    monkeypatch.setenv("ORDERS_CSV_PATH", str(orders_path))
    monkeypatch.setenv("POS_MENU_SOURCE_MODE", "local")
    monkeypatch.setenv("POS_MENU_SOURCE_URL", "")
    monkeypatch.setenv("POS_SIZE_SOURCE_URL", "")

    from app.main import app

    client = TestClient(app)

    upsert_response = client.put(
        "/menu/bac-xiu",
        json={
            "item_id": "bac-xiu",
            "name": "Bac xiu",
            "category": "Ca phe",
            "description": "Beo va nhe",
            "price": "39000",
            "available": True,
            "tags": ["ca-phe", "de-uong"],
        },
    )
    assert upsert_response.status_code == 200
    assert upsert_response.json()["item_id"] == "bac-xiu"

    fetch_menu_item = client.get("/menu/bac-xiu")
    assert fetch_menu_item.status_code == 200
    assert fetch_menu_item.json()["name"] == "Bac xiu"

    created = client.post(
        "/orders",
        json={
            "session_id": "session-2",
            "customer_text": "cho minh 1 bac xiu",
            "items": [{"item_id": "bac-xiu", "quantity": 1}],
        },
    )
    assert created.status_code == 200

    listed = client.get("/orders", params={"session_id": "session-2"})
    assert listed.status_code == 200
    payload = listed.json()
    assert len(payload) == 1
    assert payload[0]["session_id"] == "session-2"


def test_get_item_size_options_uses_product_id_even_when_item_not_in_local_menu(tmp_path: Path) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    settings = build_settings(
        tmp_path,
        menu_csv_path=menu_path,
        orders_csv_path=orders_path,
        pos_size_source_url="http://example.test/api/v1/product-size/filter?page=0&size=10&sort=",
        pos_default_size_name="M",
    )
    service = OrderService(
        CsvMenuRepository(menu_path),
        CsvOrderRepository(orders_path),
        settings,
    )

    def fake_request_json(
        url: str,
        *,
        method: str,
        body=None,
        extra_headers=None,
        require_auth: bool = False,
    ) -> dict:
        assert method == "GET"
        assert body is None
        assert require_auth is False
        assert "productId=7" in url
        return {
            "data": {
                "content": [
                    {"size": {"sizeId": 1, "sizeName": "S", "sizeSortOrder": 1}, "priceAfterDiscount": 42000},
                    {"size": {"sizeId": 2, "sizeName": "M", "sizeSortOrder": 2}, "priceAfterDiscount": 48000},
                    {"size": {"sizeId": 3, "sizeName": "L", "sizeSortOrder": 3}, "priceAfterDiscount": 54000},
                ]
            }
        }

    service._request_json = fake_request_json  # type: ignore[method-assign]

    options = service.get_item_size_options("7")
    assert [option.size_name for option in options] == ["S", "M", "L"]
    assert options[0].product_id == 7
    assert any(option.is_default and option.size_name == "M" for option in options)


def test_get_item_size_options_maps_legacy_item_id_to_product_id_via_remote_menu(tmp_path: Path) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    menu_source = "http://example.test/api/v1/product-availability/filter?storeId=9&page=0&size=100&sort="
    size_source = "http://example.test/api/v1/product-size/filter?page=0&size=10&sort="
    settings = build_settings(
        tmp_path,
        menu_csv_path=menu_path,
        orders_csv_path=orders_path,
        pos_menu_source_url=menu_source,
        pos_size_source_url=size_source,
        pos_default_size_name="M",
    )
    service = OrderService(
        CsvMenuRepository(menu_path),
        CsvOrderRepository(orders_path),
        settings,
    )

    def fake_request_json(
        url: str,
        *,
        method: str,
        body=None,
        extra_headers=None,
        require_auth: bool = False,
    ) -> dict:
        assert method == "GET"
        assert body is None
        assert require_auth is False
        if url.startswith(menu_source):
            return {
                "data": {
                    "content": [
                        {"id": "legacy-7", "name": "Latte", "productId": 7},
                    ]
                }
            }
        if url.startswith(size_source):
            assert "productId=7" in url
            return {
                "data": {
                    "content": [
                        {"size": {"sizeId": 2, "sizeName": "M", "sizeSortOrder": 2}, "priceAfterDiscount": 48000},
                        {"size": {"sizeId": 1, "sizeName": "S", "sizeSortOrder": 1}, "priceAfterDiscount": 42000},
                    ]
                }
            }
        raise AssertionError(f"Unexpected url in fake_request_json: {url}")

    service._request_json = fake_request_json  # type: ignore[method-assign]

    options = service.get_item_size_options("legacy-7")
    assert [option.size_name for option in options] == ["S", "M"]
    assert all(option.product_id == 7 for option in options)
    assert any(option.is_default and option.size_name == "M" for option in options)


def test_list_menu_remote_strict_fails_fast_when_remote_record_missing_required_fields(tmp_path: Path) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    menu_source = "http://example.test/api/v1/product-availability/filter?storeId=9&page=0&size=100&sort="
    settings = build_settings(
        tmp_path,
        menu_csv_path=menu_path,
        orders_csv_path=orders_path,
        pos_menu_source_mode="remote_strict",
        pos_menu_source_url=menu_source,
        pos_size_source_url="http://example.test/api/v1/product-size/filter?productId={productId}&page=0&size=10&sort=",
    )
    service = OrderService(
        CsvMenuRepository(menu_path),
        CsvOrderRepository(orders_path),
        settings,
    )

    def fake_request_json(
        url: str,
        *,
        method: str,
        body=None,
        extra_headers=None,
        require_auth: bool = False,
    ) -> dict:
        assert method == "GET"
        if url.startswith(menu_source):
            return {"data": {"content": [{"productId": 7}]}}  # missing name -> invalid schema in strict mode
        return {"data": {"content": []}}

    service._request_json = fake_request_json  # type: ignore[method-assign]

    try:
        service.list_menu()
        assert False, "Expected ValueError in remote_strict menu mode"
    except ValueError as exc:
        assert "schema" in str(exc).lower()


def test_get_order_marks_sync_error_when_remote_status_sync_fails(tmp_path: Path) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    settings = build_settings(
        tmp_path,
        menu_csv_path=menu_path,
        orders_csv_path=orders_path,
        pos_api_base_url="http://example.test/api/v1",
        pos_api_token="test-token",
        pos_menu_source_mode="remote_strict",
    )
    service = OrderService(
        CsvMenuRepository(menu_path),
        CsvOrderRepository(orders_path),
        settings,
    )
    service.order_repository.create_order(
        OrderRecord(
            order_id="12345",
            session_id="session-sync",
            created_at=datetime.now(UTC),
            customer_text="test",
            items=[
                OrderLineItem(
                    item_id="tra-dao",
                    name="Tra dao",
                    quantity=1,
                    unit_price=Decimal("48000"),
                    line_total=Decimal("48000"),
                )
            ],
            total_amount=Decimal("48000"),
            status="created",
        )
    )

    def failing_request_json(
        url: str,
        *,
        method: str,
        body=None,
        extra_headers=None,
        require_auth: bool = False,
    ) -> dict:
        raise ValueError("remote sync failed")

    service._request_json = failing_request_json  # type: ignore[method-assign]

    order = service.get_order("12345")
    assert order is not None
    assert order.payment_status == "SYNC_ERROR"
    assert order.sync_error_code == "POS_SYNC_FAILED"
    assert "remote sync failed" in str(order.sync_error_detail)


def test_normalize_remote_status_maps_pending_to_created() -> None:
    assert OrderService._normalize_remote_status("PENDING") == "CREATED"


def test_get_order_remote_pending_is_not_treated_as_unknown_status(tmp_path: Path) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    settings = build_settings(
        tmp_path,
        menu_csv_path=menu_path,
        orders_csv_path=orders_path,
        pos_api_base_url="http://example.test/api/v1",
        pos_api_token="test-token",
        pos_menu_source_mode="remote_strict",
    )
    service = OrderService(
        CsvMenuRepository(menu_path),
        CsvOrderRepository(orders_path),
        settings,
    )
    service.order_repository.create_order(
        OrderRecord(
            order_id="596",
            session_id="session-qr",
            created_at=datetime.now(UTC),
            customer_text="xac nhan",
            items=[
                OrderLineItem(
                    item_id="86",
                    name="Ga ran sot chua ngot",
                    quantity=1,
                    unit_price=Decimal("5500"),
                    line_total=Decimal("5500"),
                )
            ],
            total_amount=Decimal("5500"),
            status="created",
            payment_provider="sepay",
            payment_status="CREATED",
            payment_qr_content="CFB596",
            payment_qr_image_url="https://qr.sepay.vn/img?acc=SEPTT37867&bank=OCB&amount=5500&des=CFB596",
            payment_amount=Decimal("5500"),
        )
    )

    def success_request_json(
        url: str,
        *,
        method: str,
        body=None,
        extra_headers=None,
        require_auth: bool = False,
    ) -> dict:
        assert method == "GET"
        assert require_auth is True
        return {
            "data": {
                "orderId": 596,
                "orderStatus": "PENDING",
                "orderTotal": 5500,
            }
        }

    service._request_json = success_request_json  # type: ignore[method-assign]

    order = service.get_order("596")
    assert order is not None
    assert order.payment_status == "CREATED"
    assert order.sync_error_code is None
    assert order.sync_error_detail is None
    assert order.payment_qr_content == "CFB596"
    assert order.payment_qr_image_url and "qr.sepay.vn" in order.payment_qr_image_url


def test_order_csv_repository_migrates_legacy_header_without_data_loss(tmp_path: Path) -> None:
    orders_path = tmp_path / "orders.csv"
    with orders_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "order_id",
                "session_id",
                "created_at",
                "customer_text",
                "items_json",
                "total_amount",
                "status",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "order_id": "LEGACY-1",
                "session_id": "legacy-session",
                "created_at": "2026-04-01T12:00:00+00:00",
                "customer_text": "legacy order",
                "items_json": json.dumps(
                    [
                        {
                            "item_id": "tra-dao",
                            "name": "Tra dao",
                            "quantity": 1,
                            "unit_price": "48000",
                            "line_total": "48000",
                        }
                    ]
                ),
                "total_amount": "48000",
                "status": "confirmed",
            }
        )

    repository = CsvOrderRepository(orders_path)
    migrated = repository.get_order("LEGACY-1")
    assert migrated is not None
    assert migrated.order_id == "LEGACY-1"
    assert migrated.payment_status is None

    created = repository.create_order(
        OrderRecord(
            order_id="NEW-1",
            session_id="new-session",
            created_at=datetime.now(UTC),
            customer_text="new order",
            items=[
                OrderLineItem(
                    item_id="tra-dao",
                    name="Tra dao",
                    quantity=2,
                    unit_price=Decimal("48000"),
                    line_total=Decimal("96000"),
                )
            ],
            total_amount=Decimal("96000"),
            status="created",
            payment_provider="sepay",
            payment_status="CREATED",
            payment_qr_content="qr-content",
            payment_qr_image_url="http://qr.example/image.png",
            payment_amount=Decimal("96000"),
            sync_error_code=None,
            sync_error_detail=None,
        )
    )
    assert created.order_id == "NEW-1"

    all_orders = repository.list_orders(limit=10)
    ids = {order.order_id for order in all_orders}
    assert "LEGACY-1" in ids
    assert "NEW-1" in ids


def test_get_settings_syncs_menu_source_store_id_from_pos_store_id(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MENU_CSV_PATH", str(tmp_path / "menu.csv"))
    monkeypatch.setenv("ORDERS_CSV_PATH", str(tmp_path / "orders.csv"))
    monkeypatch.setenv("POS_STORE_ID", "12")
    monkeypatch.setenv(
        "POS_MENU_SOURCE_URL",
        "http://example.test/api/v1/product-availability/filter?storeId=9&page=0&size=100&sort=",
    )

    settings = get_settings()

    assert settings.pos_store_id == 12
    assert "storeId=12" in settings.pos_menu_source_url


def test_get_settings_infers_pos_store_id_from_menu_source_url_when_missing(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MENU_CSV_PATH", str(tmp_path / "menu.csv"))
    monkeypatch.setenv("ORDERS_CSV_PATH", str(tmp_path / "orders.csv"))
    monkeypatch.delenv("POS_STORE_ID", raising=False)
    monkeypatch.setenv(
        "POS_MENU_SOURCE_URL",
        "http://example.test/api/v1/product-availability/filter?storeId=15&page=0&size=100&sort=",
    )

    settings = get_settings()

    assert settings.pos_store_id == 15
    assert "storeId=15" in settings.pos_menu_source_url
