import type { AppNotice, CartItem, InvoiceSnapshot, TranscriptEntry } from '../types'

type TranscriptPanelProps = {
  entries: TranscriptEntry[]
  cart: CartItem[]
  invoice: InvoiceSnapshot | null
  liveTranscript: string
  sessionActive: boolean
  listening: boolean
  canListen: boolean
  canSpeak: boolean
  cameraReady: boolean
  detectorSupported: boolean
  awaitingConfirmation: boolean
  notices: AppNotice[]
  onManualStart: () => void
  onManualListen: () => void
  onStopListening: () => void
  onReset: () => void
  onConfirmOrder: () => void
}

const currency = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
})

export function TranscriptPanel({
  entries,
  cart,
  invoice,
  liveTranscript,
  sessionActive,
  listening,
  canListen,
  canSpeak,
  cameraReady,
  detectorSupported,
  awaitingConfirmation,
  notices,
  onManualStart,
  onManualListen,
  onStopListening,
  onReset,
  onConfirmOrder,
}: TranscriptPanelProps) {
  const primaryNotice =
    notices.find((notice) => notice.level === 'warning') ?? notices[notices.length - 1] ?? null

  return (
    <section className="side-panel">
      <div className="panel-heading panel-heading--tight">
        <div>
          <p className="eyebrow">Hội thoại trực tiếp</p>
          <h2>Robot đang lắng nghe và phản hồi</h2>
        </div>
        <div className="quick-actions">
          <button className="action-button action-button--ghost" onClick={onReset} type="button">
            Làm mới
          </button>
          <button className="action-button" onClick={onManualStart} type="button">
            {sessionActive ? 'Chào lại' : 'Bắt đầu'}
          </button>
        </div>
      </div>

      <div className="status-strip" aria-label="Trạng thái kiosk">
        <span className={`status-pill ${cameraReady ? 'status-pill--ok' : 'status-pill--warn'}`}>
          {cameraReady ? 'Camera sẵn sàng' : 'Camera đang chờ'}
        </span>
        {detectorSupported ? (
          <span className="status-pill status-pill--ok">Tự nhận diện khách</span>
        ) : (
          <span className="status-pill status-pill--warn">Bắt đầu thủ công</span>
        )}
        <span className={`status-pill ${listening ? 'status-pill--active' : 'status-pill--muted'}`}>
          {listening ? '🎤 Đang nghe...' : 'Chờ lệnh'}
        </span>
      </div>

      <div className="side-panel__cta">
        <button
          className={`action-button ${listening ? 'action-button--listening' : 'action-button--secondary'}`}
          onClick={() => {
            if (listening) {
              onStopListening()
            } else {
              onManualListen()
            }
          }}
          type="button"
          disabled={!canListen}
        >
          {listening ? '⏹️ Dừng nghe' : '🎤 Nói với robot'}
        </button>
        <p className="side-panel__hint">
          {listening 
            ? 'Robot đang lắng nghe. Hãy nói rõ tên món bạn muốn đặt.'
            : canSpeak
              ? 'Robot trả lời bằng giọng và tự đọc lại đơn trước khi chốt.'
              : 'Robot đang phản hồi bằng chữ vì máy chưa phát được audio.'}
        </p>
      </div>

      {primaryNotice ? (
        <div className="notice-list" role="status" aria-live="polite">
          <article className={`notice-card notice-card--${primaryNotice.level} notice-card--compact`}>
            <strong>{primaryNotice.level === 'warning' ? 'Lưu ý' : 'Thông tin'}</strong>
            <p>{primaryNotice.text}</p>
          </article>
        </div>
      ) : null}

      <div className="transcript-list" aria-live="polite">
        {entries.length === 0 && !liveTranscript ? (
          <div className="empty-state empty-state--transcript">
            Lời chào và các lượt nói sẽ hiện ở đây ngay khi robot bắt đầu phiên mới.
          </div>
        ) : (
          <>
            {entries.map((entry) => (
              <article className={`bubble bubble--${entry.speaker}`} key={entry.id}>
                <header>
                  <strong>
                    {entry.speaker === 'assistant'
                      ? 'Robot'
                      : entry.speaker === 'user'
                        ? 'Khách'
                        : 'Hệ thống'}
                  </strong>
                  <span>{entry.timestamp}</span>
                </header>
                <p>{entry.text}</p>
              </article>
            ))}
            {liveTranscript ? (
              <article className="bubble bubble--user bubble--draft">
                <header>
                  <strong>Khách</strong>
                  <span>Đang nghe...</span>
                </header>
                <p>{liveTranscript}</p>
              </article>
            ) : null}
          </>
        )}
      </div>

      <div className="cart-summary">
        <div className="panel-heading panel-heading--tight">
          <div>
            <p className="eyebrow">Giỏ tạm</p>
            <h3>{awaitingConfirmation ? 'Chờ xác nhận đơn' : 'Món đang chọn'}</h3>
          </div>
          {cart.length > 0 ? (
            <button className="action-button action-button--small" onClick={onConfirmOrder} type="button">
              {awaitingConfirmation ? 'Chốt đơn' : 'Đọc lại và xác nhận'}
            </button>
          ) : null}
        </div>

        {cart.length === 0 ? (
          <div className="empty-state">Chưa có món nào trong giỏ.</div>
        ) : (
          <ul className="cart-list">
            {cart.map((item) => (
              <li key={item.item_id}>
                <span>
                  {item.quantity} x {item.name}
                </span>
                <strong>{currency.format(Number(item.line_total))}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>

      {invoice ? (
        <div className="invoice-card">
          <div className="panel-heading panel-heading--tight">
            <div>
              <p className="eyebrow">Hóa đơn</p>
              <h3>Mã đơn {invoice.orderId}</h3>
            </div>
            <span className="badge badge--soft">{invoice.createdAt}</span>
          </div>

          <ul className="cart-list">
            {invoice.items.map((item) => (
              <li key={`${invoice.orderId}-${item.item_id}`}>
                <span>
                  {item.quantity} x {item.name}
                </span>
                <strong>{currency.format(Number(item.line_total))}</strong>
              </li>
            ))}
          </ul>

          <div className="invoice-total">
            <span>Tổng cộng</span>
            <strong>{currency.format(invoice.totalAmount)}</strong>
          </div>
        </div>
      ) : null}
    </section>
  )
}
