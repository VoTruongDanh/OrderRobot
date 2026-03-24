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


def get_settings() -> Settings:
    menu_csv = Path(os.getenv("MENU_CSV_PATH", "data/menu.csv"))
    orders_csv = Path(os.getenv("ORDERS_CSV_PATH", "data/orders.csv"))

    if not menu_csv.is_absolute():
        menu_csv = ROOT_DIR / menu_csv
    if not orders_csv.is_absolute():
        orders_csv = ROOT_DIR / orders_csv

    return Settings(
        menu_csv_path=menu_csv,
        orders_csv_path=orders_csv,
    )

