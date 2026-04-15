# Order Robot

Hệ thống kiosk gọi món bằng giọng nói tiếng Việt với AI tích hợp, gồm:

- `apps/kiosk-ui`: UI kiosk với robot 3D (GLB), camera, mic, giỏ hàng, admin panel.
- `services/core-backend`: quản lý menu, đơn hàng, tích hợp POS, không chứa AI.
- `services/ai-backend`: xử lý hội thoại, STT/TTS, tư vấn món, chốt đơn qua bridge.
- `desktop/`: Electron app đóng gói toàn bộ hệ thống thành installer Windows.

## Yêu cầu

- Node.js `24+`
- Python `3.14+`
- Chrome hoặc Edge để dùng camera
- Windows 10/11 (cho desktop packaging)

## Cài đặt nhanh

```bash
npm install
npm run install:all
```

## Cấu hình `.env`

Tạo file `.env` từ `.env.example`:

```env
# Bridge LLM
LLM_MODE=bridge_only
BRIDGE_BASE_URL=http://127.0.0.1:1122
BRIDGE_TIMEOUT_SECONDS=25.0
BRIDGE_STREAM_TIMEOUT_SECONDS=120.0

# Backend URLs
CORE_BACKEND_URL=http://127.0.0.1:8011
AI_BACKEND_URL=http://127.0.0.1:8012

# Data paths
MENU_CSV_PATH=data/menu.csv
ORDERS_CSV_PATH=data/orders.csv

# Voice settings
VOICE_LANG=vi-VN
TTS_ENGINE=vieneu
TTS_STREAM_PLAYBACK_RATE=1.15
VOICE_LISTEN_MODE=always
VOICE_ALWAYS_LISTEN=true

# Session
SESSION_TIMEOUT_MINUTES=15
CHAT_CLEAR_ON_ORDER_COMPLETE=false

# Tax
DEFAULT_TAX_RATE=10

# Frontend
VITE_CORE_API_URL=http://127.0.0.1:8011
VITE_AI_API_URL=http://127.0.0.1:8012

# Desktop packaging (optional)
ORDERROBOT_ROOT_DIR=
BRIDGE_PROFILE_DIR=
POS_AUTH_LOGIN_URL=
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

### Verification Commands
```bash
# Frontend
npm --prefix apps/kiosk-ui run build

# AI backend syntax check
python -m compileall services/ai-backend/app

# Desktop packaging checks
node --check desktop/main.mjs
powershell -File scripts/build-core-backend.ps1
powershell -File scripts/build-ai-backend.ps1
powershell -File scripts/build-desktop.ps1
```

### Manual Smoke Tests
- Thêm cùng món size S và L → phải hiện 2 dòng cart riêng
- Voice confirm với cart có sẵn → mở review popup
- Confirm lần 2 → tạo order / QR flow
- Out-of-stock size → disabled trong picker

### Build Commands
```bash
npm run test:python
npm run build:ui
npm run build:desktop
npm run build:desktop:core
npm run build:desktop:ai
```



Schema:

- `menu.csv`: `item_id,name,category,description,price,available,tags`
- `orders.csv`: `order_id,session_id,created_at,customer_text,items_json,total_amount,status`

## Luồng hoạt động

1. Camera phát hiện người trước màn hình.
2. Robot chào khách bằng TTS tiếng Việt (VieNeu engine).
3. Khách nói tiếng Việt, browser thu âm và gửi về `ai-backend`.
4. `ai-backend` dùng STT local chuyển audio thành text, sau đó xử lý hội thoại qua bridge.
5. Hệ thống tư vấn món theo menu thật trong CSV, hỗ trợ chọn size (S/M/L).
6. Giỏ hàng hiển thị từng dòng riêng cho mỗi size của cùng món.
7. Khách xác nhận lần 1 → mở popup review đơn hàng.
8. Khách xác nhận lần 2 → tạo đơn và hiển thị QR thanh toán.
9. Core backend ghi đơn vào `orders.csv` hoặc MySQL (nếu đã cấu hình).

## Tính năng chính

### Kiosk UI
- Robot 3D (GLB model) với animation
- Voice-first UX: luôn lắng nghe và phản hồi bằng giọng nói
- Giỏ hàng thông minh: phân biệt size, merge đúng logic
- Size picker modal: chọn size bằng tap, hiển thị trạng thái hết hàng
- Mini chat panel: hiển thị lịch sử hội thoại (mặc định 3 tin nhắn gần nhất)
- Order review popup: xem lại đơn trước khi thanh toán
- QR payment flow: hiển thị mã QR và tự động đóng sau 3 phút
- Portrait-friendly layout

### Admin Panel
- Quản lý menu: thêm/sửa/xóa món, cập nhật giá và trạng thái
- Cấu hình thuế: điều chỉnh % thuế áp dụng
- Voice settings: bật/tắt chế độ lắng nghe liên tục (instant apply)
- UI hoàn toàn tiếng Anh

### AI Backend
- STT: Faster Whisper local
- TTS: VieNeu engine với streaming playback
- Conversation engine: xử lý ngữ cảnh tiếng Việt, tránh fallback không cần thiết
- Size clarification: tự động hỏi size nếu món có nhiều size
- Cart sync: đồng bộ giỏ hàng với frontend, hỗ trợ optimistic updates
- Stream safety: xử lý Unicode surrogate data an toàn

### Core Backend
- Repository abstraction: dễ dàng chuyển từ CSV sang MySQL
- Menu management API
- Order management API
- POS integration ready

### Desktop Packaging
- Electron app đóng gói toàn bộ hệ thống
- POS login gate: bắt buộc đăng nhập trước khi dùng kiosk
- Runtime writable: `.env`, `menu.csv`, `orders.csv` lưu trong `AppData`
- Bridge profile: lưu trạng thái browser ẩn trong runtime local
- Auto-spawn: tự động khởi động core, ai, bridge khi mở app
- Security: khóa DevTools, reload shortcuts, context menu, navigation
- Code signing support: hỗ trợ ký Windows certificate (.pfx)

## Ghi chú kỹ thuật

### Architecture
- `core-backend` có repository abstraction để dễ dàng chuyển từ CSV sang MySQL.
- `ai-backend` chỉ giao tiếp với `core-backend` qua HTTP để giữ ranh giới rõ ràng.
- Speech xử lý backend-first: browser chỉ thu mic và phát audio blob.

### Frontend Rules
- File chính: `apps/kiosk-ui/public/stitch_robot_3d_control_center.html`
- Cart merging phải size-aware: dùng `item_key = item_id + size`, không merge theo `item_id` đơn thuần
- Không tin tưởng backend cart sync mù quáng:
  - Empty payload không được xóa optimistic cart hợp lệ
  - Backend cart chỉ có item_id có thể gộp nhầm các size khác nhau
- Exception: manual size selection từ voice `clarify_size` modal phải cho phép backend sync
- Voice checkout: confirm lần 1 mở popup review, confirm lần 2 submit thật
- Khi backend hỏi `clarify_size`, kiosk mở size picker để user có thể tap thay vì chỉ dùng STT
- Review popup và mini cart đều portrait-friendly
- Size picker dùng modal in-app, không dùng `window.prompt`
- Out-of-stock sizes phải disabled và có label rõ ràng
- Chat mini panel giữ full history nhưng chỉ hiển thị ~3 tin nhắn gần nhất

### Backend Rules
- File chính: `services/ai-backend/app/services/conversation_engine.py`
- Conversation ưu tiên kiosk ordering UX hơn generic fallback:
  - Câu trả lời ngắn như `khong` sau add/size flow nên tiếp tục order flow, không rơi vào fallback
  - STT mishearing aliases cho `size` vẫn phải resolve đúng
- Local review popup không tự động nghĩa là backend đang chờ confirmation:
  - Checkout lần 2 từ kiosk phải gửi signal `quick_checkout` rõ ràng
- Vietnamese text bị lỗi spacing/no-tone phải được sửa trước khi hiển thị frontend
- Single clear item match với ordering intent có thể auto-add ngay cả khi confidence không cao
- Stream responses phải an toàn với invalid Unicode surrogate data

### TTS/STT
- TTS engine: VieNeu
- Compatibility: old VieNeu runtime + Turbo model gây slow/noisy → có safe fallback
- Frontend WS playback phải respect backend `sample_rate`, không assume fixed 24k
- STT: Faster Whisper local

### Desktop Packaging
- `ORDERROBOT_ROOT_DIR`: backend đọc/ghi `.env`, CSV từ runtime writable
- `BRIDGE_PROFILE_DIR`: bridge browser lưu profile ở runtime writable
- POS login gate: bắt buộc login hợp lệ trước khi boot app
- Writable runtime: `%APPDATA%\\OrderRobot\\runtime`
- Logs: `%APPDATA%\\OrderRobot\\logs\\desktop-runtime.log`

### Regressions To Avoid
- Cùng món khác size bị gộp thành 1 dòng cart
- Voice confirm không mở review popup
- Empty backend cart xóa local mini cart sau manual add
- English item names bị degraded bởi Vietnamese alias replacement
- Vietnamese text garbled không dấu
- Turbo VieNeu config gây slow/noisy speech trên old runtime

## Skill gợi ý

Nếu làm việc với AI agent trong repo này, có thể dùng nhanh:

- `create`: thêm tính năng mới
- `debug`: sửa lỗi
- `enhance`: tối ưu UI/backend
- `test`: viết hoặc chạy test
- `status`: xem nhanh tiến độ repo
- `explain`: giải thích code
- `plan`: lập kế hoạch phát triển
- `deploy`: hướng dẫn triển khai

## Desktop Installer Windows

Hệ thống đã có bộ khung đóng gói desktop để xuất ra file cài đặt Windows, tự động khởi động:

- Kiosk UI
- `core-backend`
- `ai-backend`
- Bridge browser ẩn

### Tính năng Desktop App
- Seed `.env` và `data/` vào thư mục writable trong `AppData`
- Lưu bridge browser profile ở runtime local thay vì thư mục cài đặt
- Mở kiosk trong Electron, không cần chạy tay từng service
- Bắt buộc login POS hợp lệ trước khi mở kiosk
- Khóa DevTools, reload shortcut, context menu và navigation trong bản packaged

### Build Installer

```bash
npm install
npm run build:desktop
npm run clean:desktop
```


Ban desktop dang uu tien installer offline on dinh, nen da tat `NSIS differentialPackage`.
Viẹc nay giup bo qua buoc tao `blockmap`, giam kha nang fail o `app-builder.exe` khi goi installer lon.

### Code Signing Windows

Build local không ký vẫn chạy được, nhưng có thể bị `Smart App Control` hoặc Windows reputation cảnh báo.

Để hiển thị publisher và giảm bị chặn, cần certificate code signing (`.pfx`):

```powershell
$env:WIN_CSC_LINK="C:\certs\OrderRobot-CodeSign.pfx"
$env:WIN_CSC_KEY_PASSWORD="mat_khau_cert"
$env:WIN_PUBLISHER_NAME="CNX"
npm run build:desktop
```

Hoặc dùng file mẫu:

```powershell
# Copy và sửa file mẫu
copy scripts\set-desktop-signing.example.ps1 scripts\set-desktop-signing.ps1
# Sửa đường dẫn .pfx, mật khẩu và publisher
. .\scripts\set-desktop-signing.ps1
npm run build:desktop
```

### Ý nghĩa các biến

- `WIN_CSC_LINK`: đường dẫn tới file certificate code signing `.pfx`
- `WIN_CSC_KEY_PASSWORD`: mật khẩu của `.pfx`
- `WIN_PUBLISHER_NAME`: tên publisher ghi vào metadata build (nên giống tên trên certificate)

### Troubleshooting

Nếu vẫn bị Windows Smart App Control chặn sau khi đã ký:

- Certificate có đúng loại code-signing không?
- `WIN_PUBLISHER_NAME` có khớp chủ thể trên cert không?
- Build có thành công với dòng `Windows code signing: enabled` không?

Nếu app đã cài mà mở lên chỉ thấy loading hoặc không hiện cửa sổ:

- Xem log runtime tại `%APPDATA%\\OrderRobot\\logs\\desktop-runtime.log`
- Runtime writable của app nằm trong `%APPDATA%\\OrderRobot\\runtime`
- Nếu cần build lại sạch workspace, chạy `npm run clean:desktop`

### Output Locations

- Installer cuối: `dist/desktop/installer/OrderRobot-Setup-<version>.exe`
- App đã unpack để test nhanh: `dist/desktop/installer/win-unpacked/`
- Backend đã đóng gói: `dist/desktop/backends/`
- Icon: `desktop/assets/orderrobot.ico`

### Build Pipeline

1. Build UI production (`apps/kiosk-ui/dist`)
2. Đóng gói `services/core-backend` thành `OrderRobotCoreBackend.exe`
3. Đóng gói `services/ai-backend` thành `OrderRobotAiBackend.exe`
4. Dùng `electron-builder` tạo file `OrderRobot-Setup-<version>.exe`


Dọn dẹp:
- `dist/desktop/.pyinstaller/`
- `dist/desktop/backends/`
- `dist/desktop/installer/`

Cache `electron-builder` ở `%LOCALAPPDATA%\\electron-builder\\Cache` không bắt buộc xóa.

### Ghi chú

- `ORDERROBOT_ROOT_DIR`: backend đọc/ghi `.env`, `menu.csv`, `orders.csv` từ runtime writable
- `BRIDGE_PROFILE_DIR`: bridge browser lưu profile đăng nhập ở runtime writable
- Nếu AI backend build bị quá nặng, ưu tiên dọn dẹp dung lượng ổ đĩa trước khi chạy `build:desktop`
- Core backend đã build thành công thành `.exe`
- AI backend đã đến bước PyInstaller EXE cuối nhưng fail do hết dung lượng đĩa (không phải lỗi code)
