# Order Robot Demo

Demo kiosk gọi món bằng giọng nói với bridge hidden ChatGPT, gồm:

- `apps/kiosk-ui`: UI robot 2D, camera, mic, transcript, menu.
- `services/core-backend`: đọc `menu.csv`, ghi `orders.csv`, không chứa AI.
- `services/ai-backend`: quản lý hội thoại, tư vấn món, chốt đơn, sinh câu trả lời qua bridge.
- `mau/Ay-bi-ai`: gateway bridge runtime (DPG) dùng cho hidden browser + extension flow.

## Yêu cầu

- Node.js `24+`
- Python `3.14+`
- Chrome hoặc Edge để dùng camera + speech API

## Cài đặt nhanh

```bash
npm install
npm run install:all
```

## Cấu hình `.env`

Tạo file `.env` từ `.env.example`:

```env
LLM_MODE=bridge_only
BRIDGE_BASE_URL=http://127.0.0.1:1122
BRIDGE_TIMEOUT_SECONDS=25.0
BRIDGE_STREAM_TIMEOUT_SECONDS=120.0

# Legacy vars (không dùng cho bridge-only)
AI_BASE_URL=http://localhost:1234/v1
AI_API_KEY=
AI_MODEL=gpt-4o-mini
CORE_BACKEND_URL=http://127.0.0.1:8011
MENU_CSV_PATH=data/menu.csv
ORDERS_CSV_PATH=data/orders.csv
VOICE_LANG=vi-VN
VOICE_STYLE=cute_friendly
TTS_VOICE=vietnam
TTS_RATE=165
STT_MODEL=small
STT_DEVICE=cpu
STT_COMPUTE_TYPE=int8
SESSION_TIMEOUT_MINUTES=15
VITE_CORE_API_URL=http://127.0.0.1:8011
VITE_AI_API_URL=http://127.0.0.1:8012
```

Bridge runtime mặc định chạy ở `127.0.0.1:1122` qua script `dev:bridge`.

## Chạy demo

```bash
npm run dev
```

Cổng mặc định:

- UI: `http://127.0.0.1:5173`
- Core backend: `http://127.0.0.1:8011`
- AI backend: `http://127.0.0.1:8012`
- Bridge gateway: `http://127.0.0.1:1122`

## Test và build

```bash
npm run test:python
npm run build:ui
```

## Dữ liệu demo

- Menu: `data/menu.csv`
- Đơn hàng: `data/orders.csv`

Schema:

- `menu.csv`: `item_id,name,category,description,price,available,tags`
- `orders.csv`: `order_id,session_id,created_at,customer_text,items_json,total_amount,status`

## Luồng demo

1. Camera phát hiện người trước màn hình.
2. Robot chào khách bằng audio local do `ai-backend` tạo.
3. Khách nói tiếng Việt, trình duyệt chỉ thu âm và gửi file audio về `ai-backend`.
4. `ai-backend` dùng model STT local để đổi audio thành text rồi tư vấn theo menu thật trong CSV.
5. Robot đọc lại giỏ để xác nhận.
6. Core backend ghi đơn vào `orders.csv`.

## Ghi chú kỹ thuật

- `core-backend` đã có repository abstraction để đổi `CSV -> MySQL` sau này.
- `ai-backend` chỉ giao tiếp với `core-backend` qua HTTP để giữ ranh giới rõ.
- Speech hiện đi theo hướng `backend-first`: browser chỉ thu mic và phát audio blob.
- `AI_API_KEY` chỉ dùng cho phần chat và quyết định hội thoại.
- `ai-backend` có endpoint `/speech/synthesize` dùng local TTS trên máy chạy backend.
- `ai-backend` có endpoint `/speech/transcribe` dùng local STT bằng `faster-whisper`.
- Session AI cũ sẽ tự dọn sau `SESSION_TIMEOUT_MINUTES`.

## Skill gợi ý

Nếu làm việc với Codex/agent trong repo này, có thể dùng nhanh:

- `$create`: thêm tính năng mới
- `$debug`: sửa lỗi
- `$enhance`: tối ưu UI/backend
- `$test`: viết hoặc chạy test
- `$status`: xem nhanh tiến độ repo
