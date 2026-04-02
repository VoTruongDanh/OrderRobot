from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[3]
load_dotenv(ROOT_DIR / ".env")


@dataclass(slots=True)
class Settings:
    menu_csv_path: Path
    orders_csv_path: Path
    pos_api_base_url: str
    pos_api_token: str
    pos_api_username: str
    pos_api_password: str
    pos_auth_login_url: str
    pos_auth_refresh_url: str
    pos_store_id: int | None
    pos_order_type: str
    pos_payment_method: str
    pos_tag_number: str
    pos_menu_source_mode: str
    pos_menu_source_url: str
    pos_size_source_url: str
    pos_default_size_name: str


def get_settings() -> Settings:
    menu_csv = Path(os.getenv("MENU_CSV_PATH", "data/menu.csv"))
    orders_csv = Path(os.getenv("ORDERS_CSV_PATH", "data/orders.csv"))

    if not menu_csv.is_absolute():
        menu_csv = ROOT_DIR / menu_csv
    if not orders_csv.is_absolute():
        orders_csv = ROOT_DIR / orders_csv

    raw_store_id = str(os.getenv("POS_STORE_ID", "")).strip()
    try:
        pos_store_id = int(raw_store_id) if raw_store_id else None
    except ValueError:
        pos_store_id = None

    raw_tag_number = str(os.getenv("POS_TAG_NUMBER", "1")).strip()
    pos_tag_number = raw_tag_number or "1"

    pos_api_base_url = str(os.getenv("POS_API_BASE_URL", "")).strip().rstrip("/")
    pos_auth_login_url = str(os.getenv("POS_AUTH_LOGIN_URL", "")).strip()
    if not pos_auth_login_url and pos_api_base_url:
        pos_auth_login_url = f"{pos_api_base_url}/auth/login"
    pos_auth_refresh_url = str(os.getenv("POS_AUTH_REFRESH_URL", "")).strip()
    if not pos_auth_refresh_url and pos_api_base_url:
        pos_auth_refresh_url = f"{pos_api_base_url}/auth/refresh"

    pos_menu_source_url = str(os.getenv("POS_MENU_SOURCE_URL", "")).strip()
    raw_menu_source_mode = str(os.getenv("POS_MENU_SOURCE_MODE", "")).strip().lower()
    if raw_menu_source_mode in {"local", "remote_strict"}:
        pos_menu_source_mode = raw_menu_source_mode
    else:
        pos_menu_source_mode = "remote_strict" if pos_menu_source_url else "local"

    return Settings(
        menu_csv_path=menu_csv,
        orders_csv_path=orders_csv,
        pos_api_base_url=pos_api_base_url,
        pos_api_token=str(os.getenv("POS_API_TOKEN", "")).strip(),
        pos_api_username=str(os.getenv("POS_API_USERNAME", "")).strip(),
        pos_api_password=str(os.getenv("POS_API_PASSWORD", "")).strip(),
        pos_auth_login_url=pos_auth_login_url,
        pos_auth_refresh_url=pos_auth_refresh_url,
        pos_store_id=pos_store_id,
        pos_order_type=str(os.getenv("POS_ORDER_TYPE", "POS")).strip().upper() or "POS",
        pos_payment_method=str(os.getenv("POS_PAYMENT_METHOD", "ONLINE_PAYMENT")).strip().upper() or "ONLINE_PAYMENT",
        pos_tag_number=pos_tag_number,
        pos_menu_source_url=pos_menu_source_url,
        pos_menu_source_mode=pos_menu_source_mode,
        pos_size_source_url=str(os.getenv("POS_SIZE_SOURCE_URL", "")).strip(),
        pos_default_size_name=str(os.getenv("POS_DEFAULT_SIZE_NAME", "")).strip(),
    )
