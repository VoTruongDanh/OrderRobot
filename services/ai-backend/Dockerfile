FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/ai-backend/requirements.txt /tmp/requirements.txt
RUN python - <<'PY'
from pathlib import Path
source = Path("/tmp/requirements.txt")
lines = source.read_text(encoding="utf-8").splitlines()
filtered = []
for line in lines:
    item = line.strip()
    if item.startswith("pywin32=="):
        continue
    if item.startswith("vieneu=="):
        continue
    filtered.append(line)
Path("/tmp/requirements.docker.txt").write_text("\n".join(filtered) + "\n", encoding="utf-8")
PY
RUN pip install --no-cache-dir -r /tmp/requirements.docker.txt
RUN pip install --no-cache-dir --no-deps vieneu==1.3.0

COPY services/ai-backend /app/services/ai-backend

WORKDIR /app/services/ai-backend

EXPOSE 8012

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8012"]
