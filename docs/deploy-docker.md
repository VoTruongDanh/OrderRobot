# Docker Deploy (UI + Core + AI)

## 1) Prepare environment

1. Copy `.env.docker.example` to `.env.docker`.
2. Fill POS/API values as needed.

```powershell
Copy-Item .env.docker.example .env.docker
```

## 2) Start all services

```bash
docker compose up --build
```

Services:
- UI: `http://localhost:8080`
- Core health: `http://localhost:8080/api/core/health`
- AI health: `http://localhost:8080/api/ai/health`

## 3) Stop

```bash
docker compose down
```

## Notes

- Persistent data is mounted at `./data` (menu/orders CSV).
- AI image excludes `pywin32` because it is Windows-only.
- UI is served by Nginx and proxies API to internal Docker services.
