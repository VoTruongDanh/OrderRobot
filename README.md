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
npm run build:desktop
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

## Desktop Installer Windows

Repo nay da co bo khung dong goi desktop de xuat ra mot file cai dat Windows, ben trong tu bat:

- kiosk UI
- `core-backend`
- `ai-backend`
- bridge browser an de gui tin nhan

Ung dung desktop se:

- seed `.env` va `data/` vao thu muc writable trong `AppData`
- giu bridge browser profile o runtime local thay vi ghi vao thu muc cai dat
- mo kiosk trong Electron, khong can chay tay tung service
- bat buoc login POS hop le truoc khi mo kiosk
- khoa DevTools, reload shortcut, context menu va navigation la trong ban packaged

Lenh build installer:

```bash
npm install
npm run build:desktop
```

Ky code signing Windows:

- build local khong ky van chay duoc, nhung co the bi `Smart App Control` hoac Windows reputation canh bao
- neu muon hien publisher va giam bi chan, can certificate code signing (`.pfx`)
- build script da ho tro tu dong:
  - neu KHONG set `WIN_CSC_LINK` thi build khong ky
  - neu CO set `WIN_CSC_LINK` thi build tu dong bat signing

PowerShell vi du:

```powershell
$env:WIN_CSC_LINK="C:\certs\OrderRobot-CodeSign.pfx"
$env:WIN_CSC_KEY_PASSWORD="mat_khau_cert"
$env:WIN_PUBLISHER_NAME="CNX"
npm run build:desktop
```

Neu ban dung EV/USB token thi phai cau hinh theo cert that tren may build, con repo nay hien dang san san cho flow `.pfx` thong dung.

De do phai nho bien moi lan, co san file mau:

- `scripts/set-desktop-signing.example.ps1`

Copy thanh file rieng cua ban, sua lai duong dan `.pfx`, mat khau va publisher roi chay:

```powershell
. .\scripts\set-desktop-signing.example.ps1
npm run build:desktop
```

Y nghia cac bien:

- `WIN_CSC_LINK`: duong dan toi file certificate code signing `.pfx`
- `WIN_CSC_KEY_PASSWORD`: mat khau cua `.pfx`
- `WIN_PUBLISHER_NAME`: ten publisher muon ghi vao metadata build; nen giong voi ten tren certificate

Neu van bi Windows Smart App Control chan sau khi da ky, kiem tra lai:

- certificate co dung loai code-signing khong
- `WIN_PUBLISHER_NAME` co khop chu the tren cert khong
- ban build co thanh cong voi dong `Windows code signing: enabled` khong

Icon desktop/installer:

- `desktop/assets/orderrobot.ico`

Noi build ra:

- installer cuoi: `dist/desktop/installer/OrderRobot-Setup-<version>.exe`
- app da unpack de test nhanh: `dist/desktop/installer/win-unpacked/`
- backend da dong goi: `dist/desktop/backends/`

Neu app da cai ma mo len chi thay loading hoac khong hien cua so:

- xem log runtime tai `%APPDATA%\\OrderRobot\\logs\\desktop-runtime.log`
- runtime writable cua app nam trong `%APPDATA%\\OrderRobot\\runtime`
- neu can build lai sach workspace, chay `npm run clean:desktop`

Neu build loi co de lai rac khong?

- Co, nhung chu yeu trong workspace:
  - `dist/desktop/.pyinstaller/`
  - `dist/desktop/backends/`
  - `dist/desktop/installer/`
- Dung nhanh lenh nay de don workspace build artifacts:

```bash
npm run clean:desktop
```

- Ngoai workspace, `electron-builder` con co cache o `%LOCALAPPDATA%\\electron-builder\\Cache`. Day la cache dung lai cho lan build sau, khong bat buoc xoa sau moi lan.

Pipeline build:

1. build UI production (`apps/kiosk-ui/dist`)
2. dong goi `services/core-backend` thanh `OrderRobotCoreBackend.exe`
3. dong goi `services/ai-backend` thanh `OrderRobotAiBackend.exe`
4. dung `electron-builder` tao file `OrderRobot-Setup-<version>.exe`

Lenh phu:

```bash
npm run build:desktop:core
npm run build:desktop:ai
npm run desktop:start
```

Ghi chu:

- Bien moi `ORDERROBOT_ROOT_DIR` duoc dung de backend doc/ghi `.env`, `menu.csv`, `orders.csv` tu runtime writable.
- `BRIDGE_PROFILE_DIR` duoc dung de bridge browser luu profile dang nhap o runtime writable.
- Neu AI backend build bi qua nang, uu tien don dep dung luong o dia truoc khi chay `build:desktop`.
