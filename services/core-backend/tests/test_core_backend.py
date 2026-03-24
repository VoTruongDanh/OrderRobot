from __future__ import annotations

import csv
from pathlib import Path

from fastapi.testclient import TestClient


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


def test_menu_and_order_flow(tmp_path: Path, monkeypatch) -> None:
    menu_path = tmp_path / "menu.csv"
    orders_path = tmp_path / "orders.csv"
    write_menu(menu_path)

    monkeypatch.setenv("MENU_CSV_PATH", str(menu_path))
    monkeypatch.setenv("ORDERS_CSV_PATH", str(orders_path))

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
