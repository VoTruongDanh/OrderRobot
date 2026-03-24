from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import CreateOrderRequest, MenuItem, OrderRecord
from app.repositories.csv_repositories import CsvMenuRepository, CsvOrderRepository
from app.services.order_service import OrderService


settings = get_settings()
menu_repository = CsvMenuRepository(settings.menu_csv_path)
order_repository = CsvOrderRepository(settings.orders_csv_path)
order_service = OrderService(menu_repository, order_repository)

app = FastAPI(title="Order Robot Core Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/menu", response_model=list[MenuItem])
def list_menu() -> list[MenuItem]:
    return menu_repository.list_menu()


@app.get("/menu/search", response_model=list[MenuItem])
def search_menu(q: str = Query(default="", min_length=0, max_length=120)) -> list[MenuItem]:
    return menu_repository.search_menu(q)


@app.post("/orders", response_model=OrderRecord)
def create_order(payload: CreateOrderRequest) -> OrderRecord:
    try:
        return order_service.create_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/orders/{order_id}", response_model=OrderRecord)
def get_order(order_id: str) -> OrderRecord:
    order = order_service.get_order(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Khong tim thay hoa don.")
    return order
