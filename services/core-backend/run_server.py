from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn


SERVICE_DIR = Path(__file__).resolve().parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))


def main() -> None:
    host = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("PORT", "8011"))
    log_level = os.getenv("LOG_LEVEL", "info").strip() or "info"
    uvicorn.run("app.main:app", host=host, port=port, log_level=log_level, reload=False)


if __name__ == "__main__":
    main()
