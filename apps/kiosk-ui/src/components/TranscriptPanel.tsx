import { useEffect, useRef } from 'react'
import type { AppNotice, CartItem, InvoiceSnapshot, TranscriptEntry } from '../types'

type TranscriptPanelProps = {
  entries: TranscriptEntry[]
  cart: CartItem[]
  invoice: InvoiceSnapshot | null
  liveTranscript: string
  speechPhase: 'idle' | 'listening'
  sessionActive: boolean
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
  maxVisibleEntries?: number
  showHeaderActions?: boolean
  compact?: boolean
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
  speechPhase,
  sessionActive,
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
  maxVisibleEntries,
  showHeaderActions = true,
  compact = false,
}: TranscriptPanelProps) {
  const primaryNotice =
    notices.find((notice) => notice.level === 'warning') ?? notices[notices.length - 1] ?? null
  const transcriptListRef = useRef<HTMLDivElement | null>(null)
  const visibleEntries = typeof maxVisibleEntries === 'number' ? entries.slice(-maxVisibleEntries) : entries
  const showListeningDraft = speechPhase === 'listening'
  const showEmptyTranscript = visibleEntries.length === 0 && !liveTranscript && !showListeningDraft

  useEffect(() => {
    const panel = transcriptListRef.current
    if (!panel) {
      return
    }
    panel.scrollTop = panel.scrollHeight
  }, [entries, liveTranscript, speechPhase])

  return (
    <section className={`side-panel ${compact ? 'side-panel--compact' : ''}`}>
      <div className="panel-heading panel-heading--tight">
        <div>
          <p className="eyebrow">Hoi thoai truc tiep</p>
          <h2>Robot dang lang nghe va phan hoi</h2>
        </div>
        {showHeaderActions ? (
          <div className="quick-actions">
            <button className="action-button action-button--ghost" onClick={onReset} type="button">
              Lam moi
            </button>
            <button className="action-button" onClick={onManualStart} type="button">
              {sessionActive ? 'Chao lai' : 'Bat dau'}
            </button>
          </div>
        ) : null}
      </div>

      {!compact ? (
        <>
          <div className="status-strip" aria-label="Trang thai kiosk">
            <span className={`status-pill ${cameraReady ? 'status-pill--ok' : 'status-pill--warn'}`}>
              {cameraReady ? 'Camera san sang' : 'Camera dang cho'}
            </span>
            {detectorSupported ? (
              <span className="status-pill status-pill--ok">Tu nhan dien khach</span>
            ) : (
              <span className="status-pill status-pill--warn">Bat dau thu cong</span>
            )}
            <span className={`status-pill ${speechPhase === 'listening' ? 'status-pill--ok' : 'status-pill--muted'}`}>
              {speechPhase === 'listening' ? 'Dang nghe' : 'Dang cho'}
            </span>
          </div>

          <div className="side-panel__cta">
            <button
              className="action-button action-button--secondary"
              onClick={speechPhase === 'listening' ? onStopListening : onManualListen}
              type="button"
              disabled={!canListen}
            >
              {speechPhase === 'listening' ? 'Dang nghe...' : 'Noi voi robot'}
            </button>
            <p className="side-panel__hint">
              {canSpeak
                ? 'Robot tra loi bang giong va tu doc lai don truoc khi chot.'
                : 'Robot dang phan hoi bang chu vi may chua phat duoc audio.'}
            </p>
          </div>

          {primaryNotice ? (
            <div className="notice-list" role="status" aria-live="polite">
              <article className={`notice-card notice-card--${primaryNotice.level} notice-card--compact`}>
                <strong>{primaryNotice.level === 'warning' ? 'Luu y' : 'Thong tin'}</strong>
                <p>{primaryNotice.text}</p>
              </article>
            </div>
          ) : null}
        </>
      ) : (
        <div className="status-strip" aria-label="Trang thai kiosk compact">
          <span className={`status-pill ${cameraReady ? 'status-pill--ok' : 'status-pill--warn'}`}>
            {cameraReady ? 'Camera ok' : 'Camera cho'}
          </span>
          <span className={`status-pill ${speechPhase === 'listening' ? 'status-pill--ok' : 'status-pill--muted'}`}>
            {speechPhase === 'listening' ? 'Dang nghe' : 'Dang cho'}
          </span>
          {cart.length > 0 ? <span className="status-pill status-pill--working">Gio: {cart.length}</span> : null}
        </div>
      )}

      <div className="transcript-list" aria-live="polite" ref={transcriptListRef}>
        {showEmptyTranscript ? (
          <div className="empty-state empty-state--transcript">
            Loi chao va cac luot noi se hien o day khi robot bat dau phien moi.
          </div>
        ) : (
          <>
            {visibleEntries.map((entry) => (
              <article className={`bubble bubble--${entry.speaker}`} key={entry.id}>
                <header>
                  <strong>
                    {entry.speaker === 'assistant' ? 'Robot' : entry.speaker === 'user' ? 'Khach' : 'He thong'}
                  </strong>
                  <span>{entry.timestamp}</span>
                </header>
                <p>{entry.text}</p>
              </article>
            ))}
            {showListeningDraft ? (
              <article className="bubble bubble--user bubble--draft bubble--draft-live">
                <header>
                  <strong>Khach</strong>
                  <span>Dang nghe...</span>
                </header>
                <p>{liveTranscript || 'Moi ban noi mon muon goi...'}</p>
              </article>
            ) : null}
          </>
        )}
      </div>

      {compact ? (
        <div className="side-panel__cta side-panel__cta--compact">
          <button
            className="action-button action-button--secondary action-button--small"
            onClick={speechPhase === 'listening' ? onStopListening : onManualListen}
            type="button"
            disabled={!canListen}
          >
            {speechPhase === 'listening' ? 'Dang nghe...' : 'Noi'}
          </button>
          <button
            className="action-button action-button--ghost action-button--small"
            onClick={() => {
              if (cart.length > 0) {
                onConfirmOrder()
              } else {
                onManualStart()
              }
            }}
            type="button"
          >
            {cart.length > 0 ? 'Chot don' : sessionActive ? 'Chao lai' : 'Bat dau'}
          </button>
        </div>
      ) : (
        <>
          <div className="cart-summary">
            <div className="panel-heading panel-heading--tight">
              <div>
                <p className="eyebrow">Gio tam</p>
                <h3>{awaitingConfirmation ? 'Cho xac nhan don' : 'Mon dang chon'}</h3>
              </div>
              {cart.length > 0 ? (
                <button className="action-button action-button--small" onClick={onConfirmOrder} type="button">
                  {awaitingConfirmation ? 'Chot don' : 'Doc lai va xac nhan'}
                </button>
              ) : null}
            </div>

            {cart.length === 0 ? (
              <div className="empty-state">Chua co mon nao trong gio.</div>
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
                  <p className="eyebrow">Hoa don</p>
                  <h3>Ma don {invoice.orderId}</h3>
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
                <span>Tong cong</span>
                <strong>{currency.format(invoice.totalAmount)}</strong>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
