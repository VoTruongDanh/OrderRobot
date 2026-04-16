from __future__ import annotations

import json
import logging
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import CreateOrderRequest, MenuItem, MenuItemSizeOption, OrderRecord, UpsertMenuItemRequest
from app.repositories.csv_repositories import CsvMenuRepository, CsvOrderRepository
from app.services.order_service import OrderService

logger = logging.getLogger(__name__)

settings = get_settings()
menu_repository = CsvMenuRepository(settings.menu_csv_path)
order_repository = CsvOrderRepository(settings.orders_csv_path)
order_service = OrderService(menu_repository, order_repository, settings)

app = FastAPI(title="Order Robot Core Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _reload_runtime_config() -> dict[str, object]:
    global settings, menu_repository, order_repository, order_service

    settings = get_settings()
    menu_repository = CsvMenuRepository(settings.menu_csv_path)
    order_repository = CsvOrderRepository(settings.orders_csv_path)
    order_service = OrderService(menu_repository, order_repository, settings)

    logger.info(
        "core_config_reload status=ok pos_store_id=%s pos_menu_source_mode=%s pos_menu_source_url=%s",
        settings.pos_store_id,
        settings.pos_menu_source_mode,
        settings.pos_menu_source_url,
    )
    return {
        "status": "ok",
        "pos_store_id": settings.pos_store_id,
        "pos_menu_source_mode": settings.pos_menu_source_mode,
        "pos_menu_source_url": settings.pos_menu_source_url,
    }


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "pos_store_id": settings.pos_store_id,
        "pos_menu_source_mode": settings.pos_menu_source_mode,
        "pos_menu_source_url": settings.pos_menu_source_url,
    }


@app.post("/config/reload")
def reload_config() -> dict[str, object]:
    return _reload_runtime_config()


@app.get("/menu", response_model=list[MenuItem])
def list_menu() -> list[MenuItem]:
    try:
        return order_service.list_menu()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _extract_remote_menu_records(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    candidates = [
        payload.get("items"),
        payload.get("data", {}).get("items") if isinstance(payload.get("data"), dict) else None,
        payload.get("data", {}).get("content") if isinstance(payload.get("data"), dict) else None,
        payload.get("data"),
        payload.get("content"),
        payload.get("results"),
        payload.get("records"),
        payload.get("rows"),
        payload.get("list"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
    return []


def _parse_decimal(value: object, fallback: str = "0") -> Decimal:
    if value is None:
        return Decimal(fallback)
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(fallback)


def _parse_bool(value: object, fallback: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        raw = value.strip().lower()
        if raw in {"1", "true", "yes", "y", "on", "available"}:
            return True
        if raw in {"0", "false", "no", "n", "off", "unavailable"}:
            return False
    return fallback


def _normalize_remote_menu_item(item: dict, index: int) -> MenuItem | None:
    product_obj = item.get("product", {}) if isinstance(item.get("product"), dict) else {}
    product_category = (
        product_obj.get("category", {})
        if isinstance(product_obj.get("category"), dict)
        else {}
    )
    item_id = str(
        item.get("item_id")
        or item.get("productId")
        or item.get("product_id")
        or product_obj.get("productId")
        or product_obj.get("product_id")
        or item.get("id")
        or item.get("itemId")
        or f"remote-item-{index}"
    ).strip()
    name = str(
        item.get("name")
        or item.get("item_name")
        or item.get("itemName")
        or item.get("productName")
        or item.get("product_name")
        or product_obj.get("productName")
        or product_obj.get("product_name")
        or item.get("title")
        or ""
    ).strip()
    if not name:
        return None
    category = str(
        item.get("category")
        or item.get("categoryName")
        or product_obj.get("categoryName")
        or product_category.get("categoryName")
        or item.get("group")
        or item.get("type")
        or item.get("kind")
        or "Khac"
    ).strip()
    description = str(
        item.get("description")
        or item.get("productDescription")
        or item.get("product_description")
        or product_obj.get("description")
        or ""
    ).strip()
    image_url = str(
        item.get("image_url")
        or item.get("image")
        or item.get("thumbnail")
        or item.get("photo")
        or item.get("productImageUrl")
        or item.get("product_image_url")
        or product_obj.get("imageUrl")
        or ""
    ).strip()
    tags = item.get("tags")
    normalized_tags = [str(tag).strip() for tag in tags] if isinstance(tags, list) else []
    has_availability = any(
        key in item for key in ("isAvailable", "available", "inStock", "productIsActive")
    ) or ("isActive" in product_obj)
    available = (
        _parse_bool(
            item.get(
                "isAvailable",
                item.get(
                    "available",
                    item.get("inStock", item.get("productIsActive", product_obj.get("isActive"))),
                ),
            ),
            True,
        )
        if has_availability
        else True
    )
    return MenuItem(
        item_id=item_id,
        name=name,
        category=category,
        description=description,
        image_url=image_url or None,
        price=_parse_decimal(
            item.get(
                "price",
                item.get(
                    "sellingPrice",
                    item.get("basePrice", item.get("productPrice", item.get("amount", 0))),
                ),
            ),
            "0",
        ),
        available=available,
        tags=normalized_tags,
    )


def _build_size_query_url(size_source: str, product_id: str) -> str:
    template = str(size_source or "").strip()
    if not template:
        return ""
    if "{productId}" in template:
        return template.replace("{productId}", product_id)
    parsed = urlparse(template)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["productId"] = product_id
    rebuilt_query = urlencode(query, doseq=True)
    return urlunparse(
        (parsed.scheme, parsed.netloc, parsed.path, parsed.params, rebuilt_query, parsed.fragment)
    )


def _extract_size_content(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    candidates = [
        payload.get("data", {}).get("content") if isinstance(payload.get("data"), dict) else None,
        payload.get("data", {}).get("items") if isinstance(payload.get("data"), dict) else None,
        payload.get("content"),
        payload.get("items"),
        payload.get("results"),
        payload.get("records"),
        payload.get("rows"),
        payload.get("list"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)]
    return []


def _pick_size_price(rows: list[dict], size_name: str | None = None) -> Decimal | None:
    if not rows:
        return None
    normalized_size_name = str(size_name or "").strip().lower()
    if normalized_size_name:
        for row in rows:
            row_size_name = str(
                row.get("size", {}).get("sizeName") if isinstance(row.get("size"), dict) else row.get("sizeName", "")
            ).strip().lower()
            if row_size_name == normalized_size_name:
                return _parse_decimal(row.get("priceAfterDiscount", row.get("priceBase", 0)), "0")

    def sort_key(row: dict) -> tuple[int, str]:
        raw_sort = (
            row.get("size", {}).get("sizeSortOrder")
            if isinstance(row.get("size"), dict)
            else row.get("sizeSortOrder", 9999)
        )
        try:
            order = int(raw_sort)
        except (TypeError, ValueError):
            order = 9999
        raw_name = (
            row.get("size", {}).get("sizeName")
            if isinstance(row.get("size"), dict)
            else row.get("sizeName", "")
        )
        return (order, str(raw_name or "").strip().lower())

    selected = sorted(rows, key=sort_key)[0]
    return _parse_decimal(selected.get("priceAfterDiscount", selected.get("priceBase", 0)), "0")


def _fetch_price_from_size_api(
    size_source: str,
    product_id: str,
    size_name: str | None = None,
) -> Decimal | None:
    target_url = _build_size_query_url(size_source, product_id)
    if not target_url:
        return None
    try:
        req = Request(
            target_url,
            headers={
                "Accept": "application/json",
                "User-Agent": "OrderRobot-Core/1.0",
            },
        )
        with urlopen(req, timeout=10) as response:
            body = response.read().decode("utf-8", errors="replace")
        payload = json.loads(body)
        content = _extract_size_content(payload)
        return _pick_size_price(content, size_name=size_name)
    except Exception:
        return None


def _extract_http_error_detail(exc: HTTPError, fallback: str) -> str:
    detail = fallback
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception:
        raw = ""
    if not raw.strip():
        return detail
    try:
        payload = json.loads(raw)
        if isinstance(payload, dict):
            return str(payload.get("message") or payload.get("error") or payload.get("detail") or detail)
        return detail
    except json.JSONDecodeError:
        return raw.strip() or detail


@app.post("/auth/login/proxy")
def proxy_auth_login(payload: dict[str, str] = Body(...)) -> object:
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password are required")

    target_url = str(settings.pos_auth_login_url or "").strip()
    if not target_url:
        raise HTTPException(status_code=500, detail="POS_AUTH_LOGIN_URL is not configured")

    body = json.dumps({"username": username, "password": password}).encode("utf-8")
    request = Request(
        target_url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "OrderRobot-Core/1.0",
        },
    )

    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read().decode("utf-8", errors="replace")
        if not raw.strip():
            return {}
        return json.loads(raw)
    except HTTPError as exc:
        detail = _extract_http_error_detail(exc, f"Remote auth HTTP {exc.code}")
        status = exc.code if 400 <= exc.code <= 599 else 502
        raise HTTPException(status_code=status, detail=detail) from exc
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"Remote auth unreachable: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Remote auth returned invalid JSON") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Remote auth request failed: {exc}") from exc


@app.get("/menu/proxy", response_model=list[MenuItem])
def proxy_menu(
    source: str = Query(..., min_length=8, max_length=2048),
    size_source: str | None = Query(default=None, min_length=8, max_length=2048),
    size_name: str | None = Query(default=None, min_length=1, max_length=32),
) -> list[MenuItem]:
    try:
        req = Request(
            source,
            headers={
                "Accept": "application/json",
                "User-Agent": "OrderRobot-Core/1.0",
            },
        )
        with urlopen(req, timeout=12) as response:
            body = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Remote menu HTTP {exc.code}") from exc
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"Remote menu unreachable: {exc.reason}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Remote menu request failed: {exc}") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Remote menu returned invalid JSON") from exc

    records = _extract_remote_menu_records(payload)
    items: list[MenuItem] = []
    size_price_cache: dict[str, Decimal | None] = {}
    for index, record in enumerate(records):
        normalized = _normalize_remote_menu_item(record, index)
        if normalized is not None:
            if size_source:
                product_id = str(
                    record.get("productId")
                    or record.get("product_id")
                    or (record.get("product", {}).get("productId") if isinstance(record.get("product"), dict) else "")
                    or (record.get("product", {}).get("id") if isinstance(record.get("product"), dict) else "")
                    or record.get("id")
                    or record.get("item_id")
                    or record.get("itemId")
                    or ""
                ).strip()
                if product_id:
                    if product_id not in size_price_cache:
                        size_price_cache[product_id] = _fetch_price_from_size_api(
                            size_source=size_source,
                            product_id=product_id,
                            size_name=size_name,
                        )
                    size_price = size_price_cache[product_id]
                    if size_price is not None and size_price >= 0:
                        normalized.price = size_price
            items.append(normalized)

    if not items:
        raise HTTPException(status_code=502, detail="Remote menu payload has no supported items")
    return items


@app.get("/menu/{item_id}", response_model=MenuItem)
def get_menu_item(item_id: str) -> MenuItem:
    if settings.pos_menu_source_mode == "remote_strict":
        try:
            menu_items = order_service.list_menu()
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        item = next((entry for entry in menu_items if entry.item_id == item_id), None)
    else:
        item = menu_repository.get_menu_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Khong tim thay mon.")
    return item


@app.get("/menu/{item_id}/sizes", response_model=list[MenuItemSizeOption])
def get_menu_item_sizes(item_id: str) -> list[MenuItemSizeOption]:
    return order_service.get_item_size_options(item_id)


@app.get("/menu/search", response_model=list[MenuItem])
def search_menu(q: str = Query(default="", min_length=0, max_length=120)) -> list[MenuItem]:
    if settings.pos_menu_source_mode != "remote_strict":
        return menu_repository.search_menu(q)
    try:
        menu_items = order_service.list_menu()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    normalized_query = q.casefold().strip()
    if not normalized_query:
        return menu_items
    tokens = [token for token in normalized_query.split() if token]
    matches: list[tuple[int, MenuItem]] = []
    for item in menu_items:
        haystack = " ".join([item.name, item.category, item.description, " ".join(item.tags)]).casefold()
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


@app.put("/menu/{item_id}", response_model=MenuItem)
def upsert_menu_item(item_id: str, payload: UpsertMenuItemRequest) -> MenuItem:
    if payload.item_id != item_id:
        raise HTTPException(status_code=400, detail="item_id trong path va body phai giong nhau.")
    return menu_repository.upsert_menu_item(MenuItem(**payload.model_dump()))


@app.post("/orders", response_model=OrderRecord)
def create_order(payload: CreateOrderRequest) -> OrderRecord:
    try:
        logger.info(
            "Creating order",
            extra={
                "session_id": payload.session_id,
                "items": [
                    {
                        "item_id": item.item_id,
                        "quantity": item.quantity,
                        "size_name": item.size_name,
                        "size_id": item.size_id,
                    }
                    for item in payload.items
                ],
            },
        )
        return order_service.create_order(payload)
    except ValueError as exc:
        logger.error(
            "Order creation failed: %s",
            str(exc),
            extra={
                "session_id": payload.session_id,
                "item_count": len(payload.items),
                "error": str(exc),
            },
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/orders", response_model=list[OrderRecord])
def list_orders(
    session_id: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[OrderRecord]:
    return order_service.list_orders(session_id=session_id, limit=limit)


@app.get("/orders/{order_id}", response_model=OrderRecord)
def get_order(order_id: str) -> OrderRecord:
    order = order_service.get_order(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Khong tim thay hoa don.")
    return order


@app.get("/pos/contract-check")
def pos_contract_check() -> dict[str, object]:
    diagnostics = order_service.get_pos_contract_diagnostics()
    if diagnostics.get("ok"):
        return diagnostics
    raise HTTPException(status_code=503, detail=diagnostics)
