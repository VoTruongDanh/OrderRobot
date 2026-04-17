from __future__ import annotations

import json
import logging
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from uuid import uuid4

from app.config import PosStoreProfile, Settings
from app.models import CreateOrderRequest, MenuItem, MenuItemSizeOption, OrderLineItem, OrderRecord
from app.repositories.contracts import MenuRepository, OrderRepository

logger = logging.getLogger(__name__)


def _parse_decimal(value: object, fallback: Decimal = Decimal("0")) -> Decimal:
    if value is None:
        return fallback
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return fallback


def _pick_first_text(data: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = data.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _normalize_qr_image_url(raw_image: str) -> str:
    image = str(raw_image or "").strip()
    if not image:
        return ""
    if image.startswith(("http://", "https://", "data:image/")):
        return image
    # Some gateways return raw base64 without data URL prefix.
    if re.fullmatch(r"[A-Za-z0-9+/=\r\n]+", image):
        compact = image.replace("\r", "").replace("\n", "")
        if len(compact) >= 32:
            return f"data:image/png;base64,{compact}"
    return image


def _normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value or "").strip().lower())
    without_marks = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    alnum = re.sub(r"[^a-z0-9]+", " ", without_marks)
    return re.sub(r"\s+", " ", alnum).strip()


ALLOWED_ORDER_TYPES = {"TAKEAWAY", "ONLINE", "POS", "TABLE_QR"}
ALLOWED_PAYMENT_METHODS = {"CASH", "ONLINE_PAYMENT", "CARD_PAYMENT", "WALLET"}
ALLOWED_ORDER_STATUS = {"CREATED", "PAID", "COMPLETED", "IN_PROGRESS", "REFUNDED", "CANCELLED"}


@dataclass(slots=True)
class PosAuthContext:
    key: str
    store_id: int | None
    token: str
    username: str
    password: str
    login_url: str
    refresh_url: str
    tag_number: str


@dataclass(slots=True)
class PosAuthSession:
    access_token: str = ""
    refresh_token: str = ""
    access_token_expires_at: datetime | None = None
    user_store_id: int | None = None
    user_role: str = ""
    user_email: str = ""


class OrderService:
    def __init__(
        self,
        menu_repository: MenuRepository,
        order_repository: OrderRepository,
        settings: Settings,
    ) -> None:
        self.menu_repository = menu_repository
        self.order_repository = order_repository
        self.settings = settings
        self._auth_sessions: dict[str, PosAuthSession] = {}

    @property
    def remote_pos_enabled(self) -> bool:
        has_static_token = bool(self.settings.pos_api_token)
        has_login_credentials = bool(self.settings.pos_api_username and self.settings.pos_api_password)
        has_store_profile = any(
            profile.token or (profile.username and profile.password)
            for profile in self.settings.pos_store_profiles.values()
        )
        return bool(
            self.settings.pos_api_base_url
            and (has_static_token or has_login_credentials or has_store_profile)
        )

    @property
    def remote_menu_strict_enabled(self) -> bool:
        return self.settings.pos_menu_source_mode == "remote_strict"

    def _resolve_store_id(self, store_id: int | None = None) -> int | None:
        if store_id is None:
            return self.settings.pos_store_id
        try:
            safe_store_id = int(store_id)
        except (TypeError, ValueError):
            return self.settings.pos_store_id
        return safe_store_id if safe_store_id > 0 else self.settings.pos_store_id

    def _resolve_menu_source_url(self, store_id: int | None = None) -> str:
        source = self.settings.pos_menu_source_url.strip()
        if not source:
            return ""
        resolved_store_id = self._resolve_store_id(store_id)
        if resolved_store_id is None:
            return source
        if "{storeId}" in source:
            return source.replace("{storeId}", str(resolved_store_id))
        parsed = urlparse(source)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["storeId"] = str(resolved_store_id)
        return urlunparse(
            (parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(query, doseq=True), parsed.fragment)
        )

    def _resolve_auth_context(self, store_id: int | None = None) -> PosAuthContext:
        resolved_store_id = self._resolve_store_id(store_id)
        profile: PosStoreProfile | None = None
        if resolved_store_id is not None:
            profile = self.settings.pos_store_profiles.get(resolved_store_id)

        token = str(profile.token if profile and profile.token else self.settings.pos_api_token).strip()
        username = str(profile.username if profile and profile.username else self.settings.pos_api_username).strip()
        password = str(profile.password if profile and profile.password else self.settings.pos_api_password)
        tag_number = str(
            profile.tag_number
            if profile and profile.tag_number
            else self.settings.pos_tag_number
        ).strip() or "1"
        key = f"store:{resolved_store_id}" if profile and resolved_store_id is not None else "default"
        return PosAuthContext(
            key=key,
            store_id=resolved_store_id,
            token=token,
            username=username,
            password=password,
            login_url=self.settings.pos_auth_login_url,
            refresh_url=self.settings.pos_auth_refresh_url,
            tag_number=tag_number,
        )

    def _get_auth_session(self, context: PosAuthContext) -> PosAuthSession:
        session = self._auth_sessions.get(context.key)
        if session is None:
            session = PosAuthSession()
            self._auth_sessions[context.key] = session
        return session

    def list_menu(self, *, store_id: int | None = None) -> list[MenuItem]:
        if not self.remote_menu_strict_enabled:
            return self.menu_repository.list_menu()
        if not self.settings.pos_menu_source_url.strip():
            raise ValueError("POS menu strict mode bat buoc cau hinh POS_MENU_SOURCE_URL.")
        if not self.settings.pos_size_source_url.strip():
            raise ValueError("POS menu strict mode bat buoc cau hinh POS_SIZE_SOURCE_URL.")

        items = self._fetch_remote_menu_items(store_id=store_id)
        remote_menu_lookup = self._fetch_remote_menu_lookup(store_id=store_id)
        enriched_items: list[MenuItem] = []
        for item in items:
            product_id = self._resolve_product_id(item.item_id, item, remote_menu_lookup)
            if product_id is None:
                raise ValueError(
                    f"POS menu strict mode: mon '{item.name}' (item_id={item.item_id}) thieu productId hop le."
                )
            size_info = self._resolve_product_size(product_id)
            if size_info is None:
                raise ValueError(
                    f"POS menu strict mode: productId={product_id} khong co size hop le tu POS size API."
                )
            price = _parse_decimal(size_info.get("price"), fallback=Decimal("-1"))
            if price < 0:
                raise ValueError(
                    f"POS menu strict mode: price size API khong hop le cho productId={product_id}."
                )
            tags = list(item.tags)
            tag_product_id = f"product_id:{product_id}"
            if tag_product_id not in tags:
                tags.append(tag_product_id)
            enriched_items.append(
                MenuItem(
                    item_id=item.item_id,
                    name=item.name,
                    category=item.category,
                    description=item.description,
                    image_url=item.image_url,
                    price=price,
                    available=item.available,
                    tags=tags,
                )
            )
        return enriched_items

    def create_order(self, payload: CreateOrderRequest, *, store_id: int | None = None) -> OrderRecord:
        # When remote_menu_strict_enabled, ALWAYS use remote API for menu validation
        use_remote_menu = self.remote_menu_strict_enabled
        remote_live_mode = self.remote_pos_enabled and self.remote_menu_strict_enabled
        guest_customer_mode = payload.table_id is not None and self.remote_menu_strict_enabled
        
        logger.info(
            "create_order: use_remote_menu=%s remote_live_mode=%s guest_customer_mode=%s (remote_pos_enabled=%s, remote_menu_strict_enabled=%s)",
            use_remote_menu,
            remote_live_mode,
            guest_customer_mode,
            self.remote_pos_enabled,
            self.remote_menu_strict_enabled,
        )
        
        quantities = Counter[str]()
        size_name_by_item: dict[str, str] = {}
        size_id_by_item: dict[str, int] = {}
        for item in payload.items:
            quantities[item.item_id] += item.quantity
            if item.size_name and item.item_id not in size_name_by_item:
                size_name_by_item[item.item_id] = str(item.size_name).strip()
            if item.size_id is not None and item.item_id not in size_id_by_item:
                size_id_by_item[item.item_id] = int(item.size_id)

        # Use remote API if remote_menu_strict_enabled, regardless of remote_pos_enabled
        if use_remote_menu:
            menu_items = self._get_remote_menu_items_by_ids(list(quantities.keys()), store_id=store_id)
        else:
            menu_items = self.menu_repository.get_items_by_ids(list(quantities.keys()))
            
        missing_items = [item_id for item_id in quantities if item_id not in menu_items]
        if missing_items:
            missing_text = ", ".join(missing_items)
            raise ValueError(f"Khong tim thay mon trong menu: {missing_text}")

        for item_id in quantities:
            menu_item = menu_items[item_id]
            if not menu_item.available:
                raise ValueError(f"Mon '{menu_item.name}' hien tam het hang.")

        if guest_customer_mode:
            return self._create_remote_customer_order(
                payload,
                quantities,
                menu_items,
                size_name_by_item=size_name_by_item,
                size_id_by_item=size_id_by_item,
                store_id=store_id,
            )

        if remote_live_mode:
            return self._create_remote_pos_order(
                payload,
                quantities,
                menu_items,
                size_name_by_item=size_name_by_item,
                size_id_by_item=size_id_by_item,
                store_id=store_id,
            )

        line_items: list[OrderLineItem] = []
        total_amount = Decimal("0")
        remote_menu_lookup: dict[str, int] | None = None
        for item_id, quantity in quantities.items():
            menu_item = menu_items[item_id]
            preferred_size_name = size_name_by_item.get(item_id)
            preferred_size_id = size_id_by_item.get(item_id)
            unit_price = menu_item.price
            resolved_size_name = preferred_size_name
            if self.settings.pos_size_source_url:
                product_id = self._safe_int(item_id)
                if product_id is None and self.settings.pos_menu_source_url:
                    if remote_menu_lookup is None:
                        remote_menu_lookup = self._fetch_remote_menu_lookup(store_id=store_id)
                    product_id = self._resolve_product_id(item_id, menu_item, remote_menu_lookup)
                if product_id is not None:
                    size_info = self._resolve_product_size(
                        product_id,
                        preferred_size_name=preferred_size_name,
                        preferred_size_id=preferred_size_id,
                    )
                    if size_info is not None:
                        unit_price = _parse_decimal(size_info.get("price"), fallback=menu_item.price)
                        resolved_size_name = str(size_info.get("size_name") or preferred_size_name or "").strip() or None
            line_total = unit_price * quantity
            total_amount += line_total
            display_name = menu_item.name
            if resolved_size_name:
                display_name = f"{menu_item.name} ({resolved_size_name})"
            line_items.append(
                OrderLineItem(
                    item_id=menu_item.item_id,
                    name=display_name,
                    quantity=quantity,
                    unit_price=unit_price,
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
            status="confirmed",
        )
        return self.order_repository.create_order(order_record)

    def _create_remote_customer_order(
        self,
        payload: CreateOrderRequest,
        quantities: Counter[str],
        menu_items: dict[str, MenuItem],
        *,
        size_name_by_item: dict[str, str],
        size_id_by_item: dict[str, int],
        store_id: int | None = None,
    ) -> OrderRecord:
        if payload.table_id is None:
            raise ValueError("Chua xac dinh duoc ban cua khach. Vui long mo kiosk voi ?tableid=<id>.")
        if not self.settings.pos_size_source_url:
            raise ValueError("Chua cau hinh POS_SIZE_SOURCE_URL de map size cho mon.")

        resolved_store_id = self._resolve_store_id(store_id)
        if resolved_store_id is not None:
            self._ensure_table_matches_store(payload.table_id, resolved_store_id)

        remote_menu_lookup = self._fetch_remote_menu_lookup(store_id=store_id)
        order_details: list[dict[str, int]] = []
        line_items: list[OrderLineItem] = []
        total_amount = Decimal("0")

        for item_id, quantity in quantities.items():
            menu_item = menu_items[item_id]
            product_id = self._resolve_product_id(item_id, menu_item, remote_menu_lookup)
            if product_id is None:
                raise ValueError(
                    f"Khong map duoc productId cho mon '{menu_item.name}' (item_id={item_id})."
                )

            preferred_size_name = size_name_by_item.get(item_id)
            preferred_size_id = size_id_by_item.get(item_id)
            size_info = self._resolve_product_size(
                product_id,
                preferred_size_name=preferred_size_name,
                preferred_size_id=preferred_size_id,
            )
            if size_info is None:
                raise ValueError(
                    f"Khong tim thay size cho productId={product_id}. "
                    "Kiem tra lai POS_SIZE_SOURCE_URL hoac product-size API."
                )

            unit_price = size_info["price"]
            line_total = unit_price * quantity
            total_amount += line_total
            line_items.append(
                OrderLineItem(
                    item_id=str(product_id),
                    name=menu_item.name,
                    quantity=quantity,
                    unit_price=unit_price,
                    line_total=line_total,
                )
            )
            order_details.append(
                {
                    "productId": product_id,
                    "sizeId": size_info["size_id"],
                    "quantity": quantity,
                }
            )

        remote_payload: dict[str, Any] = {
            "tableId": int(payload.table_id),
            "paymentMethod": str(self.settings.pos_payment_method).strip().upper(),
            "orderDetails": order_details,
        }
        note = payload.customer_text.strip()
        if note:
            remote_payload["note"] = note[:240]

        self._validate_remote_customer_order_payload(remote_payload)
        remote_order = self._request_json(
            f"{self.settings.pos_api_base_url}/orders/customer",
            method="POST",
            body=remote_payload,
            extra_headers={"Idempotency-Key": str(uuid4())},
            require_auth=False,
        )
        return self._build_remote_order_record(
            payload=payload,
            line_items=line_items,
            fallback_total_amount=total_amount,
            remote_order=remote_order,
            qr_require_auth=False,
        )

    def _create_remote_pos_order(
        self,
        payload: CreateOrderRequest,
        quantities: Counter[str],
        menu_items: dict[str, MenuItem],
        *,
        size_name_by_item: dict[str, str],
        size_id_by_item: dict[str, int],
        store_id: int | None = None,
    ) -> OrderRecord:
        if not self.settings.pos_size_source_url:
            raise ValueError("Chua cau hinh POS_SIZE_SOURCE_URL de map size cho mon.")
        auth_context = self._resolve_auth_context(store_id)
        self._ensure_auth_context_matches_store(auth_context, store_id)

        remote_menu_lookup = self._fetch_remote_menu_lookup(store_id=store_id)
        order_details: list[dict[str, int]] = []
        line_items: list[OrderLineItem] = []
        total_amount = Decimal("0")

        for item_id, quantity in quantities.items():
            menu_item = menu_items[item_id]
            product_id = self._resolve_product_id(item_id, menu_item, remote_menu_lookup)
            if product_id is None:
                raise ValueError(
                    f"Khong map duoc productId cho mon '{menu_item.name}' (item_id={item_id})."
                )

            preferred_size_name = size_name_by_item.get(item_id)
            preferred_size_id = size_id_by_item.get(item_id)
            size_info = self._resolve_product_size(
                product_id,
                preferred_size_name=preferred_size_name,
                preferred_size_id=preferred_size_id,
            )
            if size_info is None:
                raise ValueError(
                    f"Khong tim thay size cho productId={product_id}. "
                    "Kiem tra lai POS_SIZE_SOURCE_URL hoac product-size API."
                )

            unit_price = size_info["price"]
            line_total = unit_price * quantity
            total_amount += line_total
            line_items.append(
                OrderLineItem(
                    item_id=str(product_id),
                    name=menu_item.name,
                    quantity=quantity,
                    unit_price=unit_price,
                    line_total=line_total,
                )
            )
            order_details.append(
                {
                    "productId": product_id,
                    "sizeId": size_info["size_id"],
                    "quantity": quantity,
                }
            )

        remote_payload: dict[str, Any] = {
            "orderType": str(self.settings.pos_order_type).strip().upper(),
            "paymentMethod": str(self.settings.pos_payment_method).strip().upper(),
            "tagNumber": auth_context.tag_number,
            "orderDetails": order_details,
        }
        resolved_store_id = self._resolve_store_id(store_id)
        if resolved_store_id is not None:
            remote_payload["storeId"] = resolved_store_id
        note = payload.customer_text.strip()
        if note:
            remote_payload["note"] = note[:240]
        self._validate_remote_order_payload(remote_payload)

        remote_order = self._request_json(
            f"{self.settings.pos_api_base_url}/orders",
            method="POST",
            body=remote_payload,
            extra_headers={"Idempotency-Key": str(uuid4())},
            require_auth=True,
            auth_store_id=store_id,
        )
        return self._build_remote_order_record(
            payload=payload,
            line_items=line_items,
            fallback_total_amount=total_amount,
            remote_order=remote_order,
            qr_require_auth=True,
            qr_auth_store_id=store_id,
        )

    def _build_remote_order_record(
        self,
        *,
        payload: CreateOrderRequest,
        line_items: list[OrderLineItem],
        fallback_total_amount: Decimal,
        remote_order: dict[str, Any],
        qr_require_auth: bool,
        qr_auth_store_id: int | None = None,
    ) -> OrderRecord:
        remote_order_data = (
            remote_order.get("data", {}) if isinstance(remote_order, dict) else {}
        )
        remote_order_id = str(remote_order_data.get("orderId") or "").strip()
        if not remote_order_id:
            raise ValueError("POS API khong tra ve orderId.")

        remote_total_amount = _parse_decimal(
            remote_order_data.get("orderTotal"),
            fallback=fallback_total_amount,
        )
        remote_status = self._normalize_remote_status(str(remote_order_data.get("orderStatus") or "CREATED"))

        payment_status = remote_status
        payment_amount = remote_total_amount
        payment_qr_content = None
        payment_qr_image_url = None
        payment_expires_at = None
        sync_error_code = None
        sync_error_detail = None

        qr_payload: dict[str, Any] = {"orderId": int(remote_order_id)}
        qr_response = self._request_json(
            f"{self.settings.pos_api_base_url}/payments/sepay/qr",
            method="POST",
            body=qr_payload,
            require_auth=qr_require_auth,
            auth_store_id=qr_auth_store_id,
        )
        qr_data = qr_response.get("data", {}) if isinstance(qr_response, dict) else {}
        if isinstance(qr_data, dict):
            payment_status = self._normalize_remote_status(
                str(
                    qr_data.get("status")
                    or qr_data.get("paymentStatus")
                    or qr_data.get("orderStatus")
                    or payment_status
                )
            )
            payment_amount = _parse_decimal(
                qr_data.get("amount", qr_data.get("paymentAmount")),
                fallback=payment_amount,
            )
            qr_content = _pick_first_text(
                qr_data,
                (
                    "qrContent",
                    "qrValue",
                    "sepayQr",
                    "bankQr",
                    "paymentQrContent",
                ),
            )
            qr_image_url = _normalize_qr_image_url(
                _pick_first_text(
                    qr_data,
                    (
                        "qrImageUrl",
                        "qrUrl",
                        "qrCodeUrl",
                        "paymentQrImageUrl",
                        "qrImageBase64",
                    ),
                )
            )
            payment_qr_content = qr_content or None
            payment_qr_image_url = qr_image_url or None
            expires_at = _pick_first_text(qr_data, ("expiresAt", "expiredAt", "expireAt"))
            if expires_at:
                try:
                    payment_expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                except ValueError:
                    payment_expires_at = None
        if payment_status.startswith("UNKNOWN_"):
            sync_error_code = "POS_STATUS_UNKNOWN"
            sync_error_detail = (
                f"POS tra ve payment/order status ngoai enum docs: {payment_status.replace('UNKNOWN_', '')}"
            )
        elif remote_status.startswith("UNKNOWN_"):
            sync_error_code = "POS_STATUS_UNKNOWN"
            sync_error_detail = (
                f"POS tra ve orderStatus ngoai enum docs: {remote_status.replace('UNKNOWN_', '')}"
            )

        order_record = OrderRecord(
            order_id=remote_order_id,
            session_id=payload.session_id,
            created_at=datetime.now(UTC),
            customer_text=payload.customer_text.strip(),
            items=line_items,
            total_amount=remote_total_amount,
            status=remote_status.lower(),
            payment_provider="sepay",
            payment_status=payment_status,
            payment_qr_content=payment_qr_content,
            payment_qr_image_url=payment_qr_image_url,
            payment_amount=payment_amount,
            payment_expires_at=payment_expires_at,
            sync_error_code=sync_error_code,
            sync_error_detail=sync_error_detail,
        )
        return self.order_repository.create_order(order_record)

    def get_order(self, order_id: str, *, store_id: int | None = None) -> OrderRecord | None:
        order = self.order_repository.get_order(order_id)
        if order is None:
            return None

        remote_id = self._safe_int(order.order_id)
        if remote_id is None:
            return order

        if not self.remote_menu_strict_enabled:
            return order

        remote_status_normalized = ""
        try:
            if self.remote_pos_enabled:
                auth_context = self._resolve_auth_context(store_id)
                self._ensure_auth_context_matches_store(auth_context, store_id)
                request_kwargs: dict[str, Any] = {}
                # Keep compatibility with tests/mocks that don't expect `auth_store_id`
                # when `store_id` is not explicitly provided.
                if store_id is not None:
                    request_kwargs["auth_store_id"] = store_id

                remote_order = self._request_json(
                    f"{self.settings.pos_api_base_url}/orders/{remote_id}",
                    method="GET",
                    body=None,
                    require_auth=True,
                    **request_kwargs,
                )
                remote_data = remote_order.get("data", {}) if isinstance(remote_order, dict) else {}
                if isinstance(remote_data, dict):
                    remote_status = self._normalize_remote_status(
                        str(remote_data.get("orderStatus") or "")
                    )
                    if remote_status:
                        order.status = remote_status.lower()
                        order.payment_status = remote_status
                        remote_status_normalized = remote_status
                    remote_total = _parse_decimal(remote_data.get("orderTotal"), fallback=order.total_amount)
                    order.total_amount = remote_total
                    if order.payment_amount is None:
                        order.payment_amount = remote_total
                    if remote_status.startswith("UNKNOWN_"):
                        order.sync_error_code = "POS_STATUS_UNKNOWN"
                        order.sync_error_detail = (
                            f"POS tra ve orderStatus ngoai enum docs: {remote_status.replace('UNKNOWN_', '')}"
                        )
                    else:
                        order.sync_error_code = None
                        order.sync_error_detail = None
        except Exception as exc:
            qr_sync_error = self._try_refresh_order_from_public_qr(order, remote_id)
            if qr_sync_error is None:
                return order
            order.payment_status = "SYNC_ERROR"
            order.sync_error_code = "POS_SYNC_FAILED"
            order.sync_error_detail = str(exc)[:240]
            return order

        # Only fall back to public-QR refresh when we couldn't confidently map the remote status.
        # This avoids overwriting a known/valid status (e.g. PENDING -> CREATED) and matches
        # unit test expectations.
        if not order.sync_error_code and (not remote_status_normalized or remote_status_normalized.startswith("UNKNOWN_")):
            qr_sync_error = self._try_refresh_order_from_public_qr(order, remote_id)
            if qr_sync_error is not None and not order.sync_error_code:
                order.sync_error_code = "POS_QR_SYNC_FAILED"
                order.sync_error_detail = qr_sync_error[:240]
        return order

    def list_orders(self, *, session_id: str | None = None, limit: int = 100) -> list[OrderRecord]:
        return self.order_repository.list_orders(session_id=session_id, limit=limit)

    def get_pos_contract_diagnostics(self) -> dict[str, Any]:
        mode = self.settings.pos_menu_source_mode
        result: dict[str, Any] = {
            "ok": True,
            "mode": mode,
            "checks": {},
        }
        checks: dict[str, dict[str, Any]] = {}
        result["checks"] = checks

        required_values = {
            "POS_API_BASE_URL": bool(self.settings.pos_api_base_url.strip()),
            "POS_MENU_SOURCE_URL": bool(self.settings.pos_menu_source_url.strip()),
            "POS_SIZE_SOURCE_URL": bool(self.settings.pos_size_source_url.strip()),
            "POS_ORDER_TYPE": bool(self.settings.pos_order_type.strip()),
            "POS_PAYMENT_METHOD": bool(self.settings.pos_payment_method.strip()),
            "POS_TAG_NUMBER": bool(str(self.settings.pos_tag_number).strip()),
        }
        missing = [key for key, ready in required_values.items() if not ready]
        checks["config"] = {
            "ok": len(missing) == 0,
            "detail": "ok" if not missing else f"thieu bien: {', '.join(missing)}",
        }
        if missing:
            result["ok"] = False

        has_store_profile = any(
            profile.token or (profile.username and profile.password)
            for profile in self.settings.pos_store_profiles.values()
        )
        auth_ready = bool(self.settings.pos_api_token.strip()) or bool(
            self.settings.pos_api_username.strip()
            and self.settings.pos_api_password.strip()
            and self.settings.pos_auth_login_url.strip()
        ) or has_store_profile
        checks["auth_config"] = {
            "ok": auth_ready,
            "detail": (
                "ok"
                if auth_ready
                else "thieu POS_API_TOKEN hoac POS_API_USERNAME/POS_API_PASSWORD/POS_AUTH_LOGIN_URL hoac POS_STORE_PROFILE_MAP_JSON"
            ),
        }
        if not auth_ready:
            result["ok"] = False

        if mode != "remote_strict":
            checks["mode_guard"] = {
                "ok": True,
                "detail": "menu dang o local mode",
            }
            if not result["ok"]:
                result["message"] = "POS contract check failed"
            return result

        try:
            menu_items = self.list_menu()
            checks["menu"] = {
                "ok": len(menu_items) > 0,
                "detail": f"ok ({len(menu_items)} items)",
            }
            if not menu_items:
                result["ok"] = False
        except Exception as exc:
            checks["menu"] = {
                "ok": False,
                "detail": str(exc),
            }
            result["ok"] = False
            result["message"] = "POS contract check failed"
            return result

        if not self.remote_pos_enabled:
            checks["auth_runtime"] = {
                "ok": False,
                "detail": "thieu credential runtime de tao order thanh toan that",
            }
            result["ok"] = False
            result["message"] = "POS contract check failed"
            return result

        try:
            _ = self._resolve_bearer_token()
            checks["auth_runtime"] = {
                "ok": True,
                "detail": "ok",
            }
        except Exception as exc:
            checks["auth_runtime"] = {
                "ok": False,
                "detail": str(exc),
            }
            result["ok"] = False

        if not result["ok"]:
            result["message"] = "POS contract check failed"
        return result

    def get_item_size_options(self, item_id: str, *, store_id: int | None = None) -> list[MenuItemSizeOption]:
        menu_item = self.menu_repository.get_menu_item(item_id)
        if not self.settings.pos_size_source_url:
            if menu_item is None:
                return []
            return [self._build_default_size_option(item_id=item_id, menu_item=menu_item)]

        product_id = self._safe_int(item_id)
        if product_id is None and self.settings.pos_menu_source_url:
            if menu_item is not None:
                remote_menu_lookup = self._fetch_remote_menu_lookup(store_id=store_id)
                product_id = self._resolve_product_id(item_id, menu_item, remote_menu_lookup)
            else:
                product_id = self._resolve_product_id_from_remote_item_id(item_id, store_id=store_id)
        if product_id is None:
            if menu_item is None:
                return []
            return [self._build_default_size_option(item_id=item_id, menu_item=menu_item)]

        candidates = self._fetch_product_size_candidates(product_id)
        if not candidates:
            if menu_item is None:
                return []
            return [self._build_default_size_option(item_id=item_id, menu_item=menu_item)]

        preferred_size_name = _normalize_name(self.settings.pos_default_size_name)
        options: list[MenuItemSizeOption] = []
        for index, candidate in enumerate(candidates):
            raw_name = str(candidate.get("size_name") or "").strip()
            is_default = False
            if preferred_size_name:
                is_default = _normalize_name(raw_name) == preferred_size_name
            elif index == 0:
                is_default = True
            raw_size_available = (
                candidate.get("isAvailable")
                if candidate.get("isAvailable") is not None
                else candidate.get("available")
                if candidate.get("available") is not None
                else candidate.get("inStock")
                if candidate.get("inStock") is not None
                else candidate.get("isActive")
            )
            size_available = True
            if isinstance(raw_size_available, bool):
                size_available = raw_size_available
            elif isinstance(raw_size_available, (int, float)):
                size_available = raw_size_available != 0
            elif isinstance(raw_size_available, str):
                size_available = raw_size_available.strip().lower() in {"1", "true", "yes", "y", "on", "available"}
            options.append(
                MenuItemSizeOption(
                    item_id=item_id,
                    product_id=product_id,
                    size_id=self._safe_int(candidate.get("size_id")),
                    size_name=raw_name or f"Size-{index+1}",
                    price=_parse_decimal(candidate.get("price"), fallback=Decimal("0")),
                    is_default=is_default,
                    available=size_available,
                )
            )
        return options

    def _build_default_size_option(self, *, item_id: str, menu_item: MenuItem) -> MenuItemSizeOption:
        return MenuItemSizeOption(
            item_id=item_id,
            product_id=self._safe_int(item_id),
            size_id=None,
            size_name=self.settings.pos_default_size_name or "M",
            price=menu_item.price,
            is_default=True,
            available=True,
        )

    def _get_remote_menu_items_by_ids(
        self,
        item_ids: list[str],
        *,
        store_id: int | None = None,
    ) -> dict[str, MenuItem]:
        normalized_item_ids = [str(item_id).strip() for item_id in item_ids if str(item_id).strip()]
        if not normalized_item_ids:
            return {}
        remote_items = self._fetch_remote_menu_items(store_id=store_id)
        lookup = {item.item_id: item for item in remote_items}
        return {item_id: lookup[item_id] for item_id in normalized_item_ids if item_id in lookup}

    def _fetch_remote_menu_items(self, *, store_id: int | None = None) -> list[MenuItem]:
        source = self._resolve_menu_source_url(store_id)
        if not source:
            if self.remote_menu_strict_enabled:
                raise ValueError("POS_MENU_SOURCE_MODE=remote_strict nhung chua cau hinh POS_MENU_SOURCE_URL.")
            return []
        payload = self._request_json(source, method="GET", require_auth=False)
        records = self._extract_records(payload)
        items: list[MenuItem] = []
        for index, record in enumerate(records):
            normalized = self._normalize_remote_menu_item(record, index)
            if normalized is not None:
                items.append(normalized)
            elif self.remote_menu_strict_enabled:
                raise ValueError(
                    f"POS menu source item thu {index + 1} khong dung schema bat buoc (thieu item_id/name)."
                )
        if self.remote_menu_strict_enabled and not items:
            raise ValueError("POS menu source tra ve rong hoac payload khong dung schema.")
        return items

    def _normalize_remote_menu_item(self, record: dict[str, Any], index: int) -> MenuItem | None:
        product_obj = record.get("product", {}) if isinstance(record.get("product"), dict) else {}
        product_category = (
            product_obj.get("category", {})
            if isinstance(product_obj.get("category"), dict)
            else {}
        )
        raw_item_id = str(
            record.get("item_id")
            or record.get("productId")
            or record.get("product_id")
            or product_obj.get("productId")
            or product_obj.get("product_id")
            or record.get("id")
            or record.get("itemId")
            or ""
        ).strip()
        if not raw_item_id:
            return None
        safe_item_id = self._safe_int(raw_item_id)
        if safe_item_id is None or safe_item_id <= 0:
            if self.remote_menu_strict_enabled:
                raise ValueError(
                    f"POS menu source item thu {index + 1} khong co productId/itemId hop le."
                )
            return None
        item_id = str(safe_item_id)

        name = str(
            record.get("name")
            or record.get("item_name")
            or record.get("itemName")
            or record.get("productName")
            or record.get("product_name")
            or product_obj.get("productName")
            or product_obj.get("product_name")
            or record.get("title")
            or ""
        ).strip()
        if not name:
            return None

        category = str(
            record.get("category")
            or record.get("categoryName")
            or product_obj.get("categoryName")
            or product_category.get("categoryName")
            or record.get("group")
            or record.get("type")
            or record.get("kind")
            or "Khac"
        ).strip()
        description = str(
            record.get("description")
            or record.get("productDescription")
            or record.get("product_description")
            or product_obj.get("description")
            or ""
        ).strip()
        image_url = str(
            record.get("image_url")
            or record.get("image")
            or record.get("thumbnail")
            or record.get("photo")
            or record.get("productImageUrl")
            or record.get("product_image_url")
            or product_obj.get("imageUrl")
            or ""
        ).strip()

        raw_price = (
            record.get("price")
            or record.get("sellingPrice")
            or record.get("basePrice")
            or record.get("productPrice")
            or record.get("amount")
            or product_obj.get("price")
            or 0
        )
        price = _parse_decimal(raw_price, fallback=Decimal("0"))

        has_availability = any(
            key in record for key in ("isAvailable", "available", "inStock", "productIsActive")
        ) or ("isActive" in product_obj)
        available = True
        if has_availability:
            raw_available = (
                record.get("isAvailable")
                if record.get("isAvailable") is not None
                else record.get("available")
                if record.get("available") is not None
                else record.get("inStock")
                if record.get("inStock") is not None
                else record.get("productIsActive")
                if record.get("productIsActive") is not None
                else product_obj.get("isActive")
            )
            if isinstance(raw_available, bool):
                available = raw_available
            elif isinstance(raw_available, (int, float)):
                available = raw_available != 0
            elif isinstance(raw_available, str):
                available = raw_available.strip().lower() in {"1", "true", "yes", "y", "on", "available"}

        tags_raw = record.get("tags")
        tags = [str(tag).strip() for tag in tags_raw] if isinstance(tags_raw, list) else []
        return MenuItem(
            item_id=item_id,
            name=name,
            category=category,
            description=description,
            image_url=image_url or None,
            price=price,
            available=available,
            tags=tags,
        )

    def _resolve_product_id(
        self,
        item_id: str,
        menu_item: MenuItem,
        remote_menu_lookup: dict[str, int],
    ) -> int | None:
        direct = self._safe_int(item_id)
        if direct is not None:
            return direct

        for tag in menu_item.tags:
            match = re.search(r"(?:product[_\- ]?id[:=]?)(\d+)", str(tag), flags=re.IGNORECASE)
            if match:
                return int(match.group(1))

        normalized_name = _normalize_name(menu_item.name)
        if normalized_name and normalized_name in remote_menu_lookup:
            return remote_menu_lookup[normalized_name]

        return None

    def _validate_remote_order_payload(self, payload: dict[str, Any]) -> None:
        order_type = str(payload.get("orderType") or "").strip().upper()
        if order_type not in ALLOWED_ORDER_TYPES:
            raise ValueError(
                f"POS orderType khong hop le: {order_type or '(rong)'} (ho tro: {', '.join(sorted(ALLOWED_ORDER_TYPES))})."
            )

        payment_method = str(payload.get("paymentMethod") or "").strip().upper()
        if payment_method not in ALLOWED_PAYMENT_METHODS:
            raise ValueError(
                f"POS paymentMethod khong hop le: {payment_method or '(rong)'} "
                f"(ho tro: {', '.join(sorted(ALLOWED_PAYMENT_METHODS))})."
            )

        tag_number = str(payload.get("tagNumber") or "").strip()
        if not tag_number:
            raise ValueError("POS tagNumber khong duoc de trong.")

        order_details = payload.get("orderDetails")
        if not isinstance(order_details, list) or not order_details:
            raise ValueError("POS orderDetails bat buoc phai co it nhat 1 mon.")
        for index, detail in enumerate(order_details, start=1):
            if not isinstance(detail, dict):
                raise ValueError(f"POS orderDetails[{index}] khong dung schema object.")
            product_id = self._safe_int(detail.get("productId"))
            size_id = self._safe_int(detail.get("sizeId"))
            quantity = self._safe_int(detail.get("quantity"))
            if product_id is None or product_id <= 0:
                raise ValueError(f"POS orderDetails[{index}].productId khong hop le.")
            if size_id is None or size_id <= 0:
                raise ValueError(f"POS orderDetails[{index}].sizeId khong hop le.")
            if quantity is None or quantity <= 0:
                raise ValueError(f"POS orderDetails[{index}].quantity khong hop le.")

    def _validate_remote_customer_order_payload(self, payload: dict[str, Any]) -> None:
        table_id = self._safe_int(payload.get("tableId"))
        if table_id is None or table_id <= 0:
            raise ValueError("POS customer order tableId khong hop le.")

        payment_method = str(payload.get("paymentMethod") or "").strip().upper()
        if payment_method not in ALLOWED_PAYMENT_METHODS:
            raise ValueError(
                f"POS paymentMethod khong hop le: {payment_method or '(rong)'} "
                f"(ho tro: {', '.join(sorted(ALLOWED_PAYMENT_METHODS))})."
            )

        order_details = payload.get("orderDetails")
        if not isinstance(order_details, list) or not order_details:
            raise ValueError("POS orderDetails bat buoc phai co it nhat 1 mon.")
        for index, detail in enumerate(order_details, start=1):
            if not isinstance(detail, dict):
                raise ValueError(f"POS orderDetails[{index}] khong dung schema object.")
            product_id = self._safe_int(detail.get("productId"))
            size_id = self._safe_int(detail.get("sizeId"))
            quantity = self._safe_int(detail.get("quantity"))
            if product_id is None or product_id <= 0:
                raise ValueError(f"POS orderDetails[{index}].productId khong hop le.")
            if size_id is None or size_id <= 0:
                raise ValueError(f"POS orderDetails[{index}].sizeId khong hop le.")
            if quantity is None or quantity <= 0:
                raise ValueError(f"POS orderDetails[{index}].quantity khong hop le.")

    def _ensure_table_matches_store(self, table_id: int, store_id: int) -> None:
        table_ids = self._fetch_customer_store_table_ids(store_id)
        if not table_ids:
            return
        if int(table_id) not in table_ids:
            raise ValueError(
                f"Ban {table_id} khong thuoc cua hang {store_id}. Kiem tra lai URL ?storeid={store_id}&tableid={table_id}."
            )

    def _try_refresh_order_from_public_qr(self, order: OrderRecord, remote_order_id: int) -> str | None:
        try:
            qr_payload: dict[str, Any] = {"orderId": int(remote_order_id)}
            qr_response = self._request_json(
                f"{self.settings.pos_api_base_url}/payments/sepay/qr",
                method="POST",
                body=qr_payload,
                require_auth=False,
            )
            qr_data = qr_response.get("data", {}) if isinstance(qr_response, dict) else {}
            if not isinstance(qr_data, dict):
                return None

            payment_status = self._normalize_remote_status(
                str(
                    qr_data.get("status")
                    or qr_data.get("paymentStatus")
                    or qr_data.get("orderStatus")
                    or order.payment_status
                    or order.status
                    or "CREATED"
                )
            )
            order.payment_status = payment_status
            if payment_status and payment_status != "UNKNOWN":
                order.status = payment_status.lower()
            order.payment_amount = _parse_decimal(
                qr_data.get("amount", qr_data.get("paymentAmount")),
                fallback=order.payment_amount or order.total_amount,
            )
            qr_content = _pick_first_text(
                qr_data,
                ("qrContent", "qrValue", "sepayQr", "bankQr", "paymentQrContent"),
            )
            qr_image_url = _normalize_qr_image_url(
                _pick_first_text(
                    qr_data,
                    ("qrImageUrl", "qrUrl", "qrCodeUrl", "paymentQrImageUrl", "qrImageBase64"),
                )
            )
            if qr_content:
                order.payment_qr_content = qr_content
            if qr_image_url:
                order.payment_qr_image_url = qr_image_url
            expires_at = _pick_first_text(qr_data, ("expiresAt", "expiredAt", "expireAt"))
            if expires_at:
                try:
                    order.payment_expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                except ValueError:
                    order.payment_expires_at = None
            return None
        except Exception as exc:
            return str(exc)

    @staticmethod
    def _normalize_remote_status(status: str) -> str:
        normalized = str(status or "").strip().upper()
        if normalized == "PENDING":
            return "CREATED"
        if normalized in ALLOWED_ORDER_STATUS:
            return normalized
        if normalized:
            return f"UNKNOWN_{normalized}"
        return "UNKNOWN"

    def _fetch_remote_menu_lookup(self, *, store_id: int | None = None) -> dict[str, int]:
        source = self._resolve_menu_source_url(store_id)
        if not source:
            return {}
        payload = self._request_json(source, method="GET", require_auth=False)
        records = self._extract_records(payload)
        lookup: dict[str, int] = {}
        for record in records:
            product_obj = record.get("product", {}) if isinstance(record.get("product"), dict) else {}
            product_id = (
                record.get("productId")
                or record.get("product_id")
                or product_obj.get("productId")
                or product_obj.get("product_id")
                or record.get("id")
            )
            product_name = (
                record.get("productName")
                or record.get("product_name")
                or product_obj.get("productName")
                or product_obj.get("product_name")
                or record.get("name")
            )
            safe_product_id = self._safe_int(product_id)
            normalized_name = _normalize_name(str(product_name or ""))
            if safe_product_id is not None and normalized_name and normalized_name not in lookup:
                lookup[normalized_name] = safe_product_id
        return lookup

    def _resolve_product_id_from_remote_item_id(
        self,
        item_id: str,
        *,
        store_id: int | None = None,
    ) -> int | None:
        source = self._resolve_menu_source_url(store_id)
        if not source:
            return None
        payload = self._request_json(source, method="GET", require_auth=False)
        records = self._extract_records(payload)
        requested_id = str(item_id or "").strip()
        if not requested_id:
            return None

        for record in records:
            product_obj = record.get("product", {}) if isinstance(record.get("product"), dict) else {}
            record_item_id = str(
                record.get("item_id")
                or record.get("itemId")
                or record.get("id")
                or product_obj.get("id")
                or ""
            ).strip()
            if not record_item_id or record_item_id != requested_id:
                continue

            product_id = (
                record.get("productId")
                or record.get("product_id")
                or product_obj.get("productId")
                or product_obj.get("product_id")
                or record.get("id")
                or product_obj.get("id")
            )
            safe_product_id = self._safe_int(product_id)
            if safe_product_id is not None:
                return safe_product_id
        return None

    def _resolve_product_size(
        self,
        product_id: int,
        *,
        preferred_size_name: str | None = None,
        preferred_size_id: int | None = None,
    ) -> dict[str, Any] | None:
        candidates = self._fetch_product_size_candidates(product_id)
        if not candidates:
            return None

        available_candidates = [candidate for candidate in candidates if self._is_size_candidate_available(candidate)]
        if not available_candidates:
            return None

        if preferred_size_id is not None:
            for candidate in candidates:
                if self._safe_int(candidate.get("size_id")) == int(preferred_size_id):
                    if not self._is_size_candidate_available(candidate):
                        raise ValueError(f"Size da chon (sizeId={int(preferred_size_id)}) hien tam het.")
                    return candidate

        if preferred_size_name:
            normalized_preferred = _normalize_name(preferred_size_name)
            if normalized_preferred:
                for candidate in candidates:
                    if _normalize_name(str(candidate.get("size_name") or "")) == normalized_preferred:
                        if not self._is_size_candidate_available(candidate):
                            raise ValueError(
                                f"Size '{str(candidate.get('size_name') or preferred_size_name).strip()}' hien tam het."
                            )
                        return candidate

        preferred_size_name = _normalize_name(self.settings.pos_default_size_name)
        if preferred_size_name:
            for candidate in available_candidates:
                if _normalize_name(candidate["size_name"]) == preferred_size_name:
                    return candidate

        available_candidates.sort(key=lambda item: (int(item["sort_order"]), str(item["size_name"]).lower()))
        return available_candidates[0]

    def _fetch_product_size_candidates(self, product_id: int) -> list[dict[str, Any]]:
        source = self.settings.pos_size_source_url.strip()
        if not source:
            return []
        source_url = self._build_product_query_url(source, product_id)
        payload = self._request_json(source_url, method="GET", require_auth=False)
        records = self._extract_records(payload)
        candidates: list[dict[str, Any]] = []
        invalid_rows = 0
        for record in records:
            size_obj = record.get("size", {}) if isinstance(record.get("size"), dict) else {}
            size_id = (
                record.get("sizeId")
                or record.get("size_id")
                or size_obj.get("sizeId")
                or size_obj.get("size_id")
            )
            safe_size_id = self._safe_int(size_id)
            if safe_size_id is None:
                invalid_rows += 1
                continue
            raw_size_name = (
                record.get("sizeName")
                or record.get("size_name")
                or size_obj.get("sizeName")
                or size_obj.get("size_name")
                or ""
            )
            size_name = str(raw_size_name).strip()
            raw_sort = (
                record.get("sizeSortOrder")
                or record.get("size_sort_order")
                or size_obj.get("sizeSortOrder")
                or size_obj.get("size_sort_order")
                or 9999
            )
            safe_sort = self._safe_int(raw_sort)
            sort_order = safe_sort if safe_sort is not None else 9999
            has_price_field = (
                record.get("priceAfterDiscount") is not None
                or record.get("priceBase") is not None
            )
            if self.remote_menu_strict_enabled and not has_price_field:
                invalid_rows += 1
                continue
            price = _parse_decimal(
                record.get("priceAfterDiscount", record.get("priceBase")),
                fallback=Decimal("0"),
            )
            raw_available = (
                record.get("isAvailable")
                if record.get("isAvailable") is not None
                else record.get("available")
                if record.get("available") is not None
                else record.get("inStock")
                if record.get("inStock") is not None
                else record.get("isActive")
                if record.get("isActive") is not None
                else size_obj.get("isAvailable")
                if size_obj.get("isAvailable") is not None
                else size_obj.get("available")
                if size_obj.get("available") is not None
                else size_obj.get("inStock")
                if size_obj.get("inStock") is not None
                else size_obj.get("isActive")
            )
            candidates.append(
                {
                    "size_id": safe_size_id,
                    "size_name": size_name,
                    "sort_order": sort_order,
                    "price": price,
                    "available": raw_available,
                }
            )
        if self.remote_menu_strict_enabled and invalid_rows > 0:
            raise ValueError(
                f"POS size API schema loi cho productId={product_id}: co {invalid_rows} row thieu sizeId hop le."
            )
        candidates.sort(key=lambda item: (int(item["sort_order"]), str(item["size_name"]).lower()))
        return candidates

    @staticmethod
    def _is_size_candidate_available(candidate: dict[str, Any]) -> bool:
        raw = candidate.get("available")
        if raw is None:
            return True
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return raw != 0
        if isinstance(raw, str):
            return raw.strip().lower() in {"1", "true", "yes", "y", "on", "available"}
        return True

    @staticmethod
    def _build_product_query_url(source: str, product_id: int) -> str:
        template = str(source or "").strip()
        if "{productId}" in template:
            return template.replace("{productId}", str(product_id))
        parsed = urlparse(template)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["productId"] = str(product_id)
        rebuilt_query = urlencode(query, doseq=True)
        return urlunparse(
            (parsed.scheme, parsed.netloc, parsed.path, parsed.params, rebuilt_query, parsed.fragment)
        )

    def _fetch_customer_store_table_ids(self, store_id: int) -> set[int]:
        if not self.settings.pos_api_base_url.strip():
            return set()
        source_url = (
            f"{self.settings.pos_api_base_url}/store-tables/customer/filter"
            f"?storeId={int(store_id)}&page=0&size=250&sort="
        )
        payload = self._request_json(source_url, method="GET", require_auth=False)
        records = self._extract_records(payload)
        table_ids: set[int] = set()
        for record in records:
            table_id = self._safe_int(
                record.get("storeTableId")
                or record.get("tableId")
                or record.get("id")
            )
            if table_id is not None and table_id > 0:
                table_ids.add(table_id)
        return table_ids

    @staticmethod
    def _extract_records(payload: object) -> list[dict[str, Any]]:
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

    def _request_json(
        self,
        url: str,
        *,
        method: str,
        body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
        require_auth: bool = False,
        auth_store_id: int | None = None,
    ) -> dict[str, Any]:
        headers = {
            "Accept": "application/json",
            "User-Agent": "OrderRobot-Core/1.0",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        auth_context: PosAuthContext | None = None
        if require_auth:
            auth_context = self._resolve_auth_context(auth_store_id)
            token = self._resolve_bearer_token(auth_context)
            headers["Authorization"] = f"Bearer {token}"
        if extra_headers:
            headers.update(extra_headers)

        try:
            return self._request_json_once(url, method=method, body=body, headers=headers)
        except PermissionError:
            if not require_auth:
                raise
            if auth_context is None:
                auth_context = self._resolve_auth_context(auth_store_id)
            if auth_context.token.strip():
                raise ValueError(
                    "POS API tu choi token hien tai (401/403). Kiem tra lai POS_API_TOKEN."
                ) from None
            self._refresh_or_login_token(auth_context, force_login=False)
            headers["Authorization"] = f"Bearer {self._resolve_bearer_token(auth_context)}"
            try:
                return self._request_json_once(url, method=method, body=body, headers=headers)
            except PermissionError as exc:
                if auth_context is not None:
                    try:
                        self._ensure_auth_context_matches_store(auth_context, auth_store_id)
                    except ValueError as scope_exc:
                        raise scope_exc from exc
                raise ValueError(
                    "Dang nhap POS API khong hop le hoac khong du quyen goi endpoint."
                ) from exc

    def _request_json_once(
        self,
        url: str,
        *,
        method: str,
        body: dict[str, Any] | None,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        encoded_body = json.dumps(body).encode("utf-8") if body is not None else None
        request = Request(url, data=encoded_body, method=method, headers=headers)
        try:
            with urlopen(request, timeout=15) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code in (401, 403):
                raise PermissionError(f"{method} {url} unauthorized: {detail[:180]}") from exc
            raise ValueError(f"{method} {url} that bai (HTTP {exc.code}): {detail[:240]}") from exc
        except URLError as exc:
            raise ValueError(f"Khong ket noi duoc {url}: {exc.reason}") from exc

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{method} {url} tra ve JSON khong hop le.") from exc

        if not isinstance(payload, dict):
            raise ValueError(f"{method} {url} tra ve payload khong hop le.")
        return payload

    def _resolve_bearer_token(self, context: PosAuthContext) -> str:
        static_token = context.token.strip()
        if static_token:
            return self._normalize_bearer_token(static_token)
        session = self._get_auth_session(context)
        if self._is_access_token_valid(context):
            return session.access_token
        self._refresh_or_login_token(context, force_login=False)
        if session.access_token:
            return session.access_token
        raise ValueError(
            "Chua dang nhap duoc POS API. Can POS_API_USERNAME/POS_API_PASSWORD hoac POS_API_TOKEN."
        )

    def _is_access_token_valid(self, context: PosAuthContext) -> bool:
        session = self._get_auth_session(context)
        if not session.access_token:
            return False
        if session.access_token_expires_at is None:
            return True
        return datetime.now(UTC) + timedelta(seconds=12) < session.access_token_expires_at

    def _refresh_or_login_token(self, context: PosAuthContext, *, force_login: bool) -> None:
        session = self._get_auth_session(context)
        if not force_login and session.refresh_token and context.refresh_url:
            try:
                payload = self._request_json_once(
                    context.refresh_url,
                    method="POST",
                    body={"refreshToken": session.refresh_token},
                    headers={
                        "Accept": "application/json",
                        "User-Agent": "OrderRobot-Core/1.0",
                        "Content-Type": "application/json",
                    },
                )
                self._store_login_payload(context, payload)
                if session.access_token:
                    return
            except Exception:
                pass

        username = context.username.strip()
        password = context.password
        if not username or not password:
            raise ValueError("Thieu POS_API_USERNAME/POS_API_PASSWORD de tu dang nhap POS API.")
        if not context.login_url:
            raise ValueError("Thieu POS_AUTH_LOGIN_URL de tu dang nhap POS API.")

        try:
            payload = self._request_json_once(
                context.login_url,
                method="POST",
                body={"username": username, "password": password},
                headers={
                    "Accept": "application/json",
                    "User-Agent": "OrderRobot-Core/1.0",
                    "Content-Type": "application/json",
                },
            )
        except PermissionError as exc:
            raise ValueError("Sai POS_API_USERNAME/POS_API_PASSWORD hoac tai khoan khong du quyen.") from exc
        self._store_login_payload(context, payload)
        if not session.access_token:
            raise ValueError("Dang nhap POS API thanh cong nhung khong nhan duoc accessToken.")

    def _store_login_payload(self, context: PosAuthContext, payload: dict[str, Any]) -> None:
        session = self._get_auth_session(context)
        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        if not isinstance(data, dict):
            return
        access_token = self._normalize_bearer_token(str(data.get("accessToken") or ""))
        refresh_token = str(data.get("refreshToken") or "").strip()
        access_expires_raw = str(data.get("accessTokenExpiresAt") or "").strip()

        if access_token:
            session.access_token = access_token
        if refresh_token:
            session.refresh_token = refresh_token

        if access_expires_raw:
            try:
                session.access_token_expires_at = datetime.fromisoformat(
                    access_expires_raw.replace("Z", "+00:00")
                )
            except ValueError:
                session.access_token_expires_at = None
        else:
            session.access_token_expires_at = None

    def _fetch_auth_me(self, context: PosAuthContext) -> dict[str, Any]:
        token = self._resolve_bearer_token(context)
        payload = self._request_json_once(
            f"{self.settings.pos_api_base_url}/auth/me",
            method="GET",
            body=None,
            headers={
                "Accept": "application/json",
                "User-Agent": "OrderRobot-Core/1.0",
                "Authorization": f"Bearer {token}",
            },
        )
        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        if not isinstance(data, dict):
            return {}

        session = self._get_auth_session(context)
        store_obj = data.get("store", {}) if isinstance(data.get("store"), dict) else {}
        session.user_store_id = self._safe_int(store_obj.get("storeId"))
        session.user_role = str(data.get("role") or "").strip().upper()
        session.user_email = str(data.get("email") or "").strip()
        return data

    def _ensure_auth_context_matches_store(self, context: PosAuthContext, store_id: int | None) -> None:
        resolved_store_id = self._resolve_store_id(store_id)
        if resolved_store_id is None:
            return

        session = self._get_auth_session(context)
        auth_store_id = session.user_store_id
        if auth_store_id is None:
            try:
                self._fetch_auth_me(context)
                auth_store_id = session.user_store_id
            except Exception:
                auth_store_id = None
        if auth_store_id is None or auth_store_id == resolved_store_id:
            return

        mapped_profile_configured = resolved_store_id in self.settings.pos_store_profiles
        hint = (
            " Hay cau hinh POS_STORE_PROFILE_MAP_JSON cho store nay."
            if not mapped_profile_configured
            else " Kiem tra lai tai khoan POS da map cho store nay."
        )
        raise ValueError(
            "Tai khoan POS hien tai thuoc cua hang "
            f"{auth_store_id}, khong the tao/tra cuu don cho cua hang {resolved_store_id}.{hint}"
        )

    @staticmethod
    def _normalize_bearer_token(value: str) -> str:
        raw = str(value or "").strip()
        if raw.lower().startswith("bearer "):
            raw = raw.split(" ", 1)[1].strip()
        return raw

    @staticmethod
    def _safe_int(value: object) -> int | None:
        try:
            if value is None:
                return None
            return int(str(value).strip())
        except (TypeError, ValueError):
            return None
