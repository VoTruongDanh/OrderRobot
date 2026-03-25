import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

import type { InvoiceSnapshot } from '../types'

type OrderSuccessModalProps = {
  invoice: InvoiceSnapshot
  countdown: number
  onClose: () => void
  onFeedbackSubmit?: (rating: number, comment: string) => void
}

const currency = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
})

export function OrderSuccessModal({ invoice, countdown, onClose, onFeedbackSubmit }: OrderSuccessModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [rating, setRating] = useState(0)
  const showThankYou = countdown === 0

  useEffect(() => {
    let cancelled = false

    async function renderQr() {
      try {
        const dataUrl = await QRCode.toDataURL(invoice.qrValue, {
          width: 220,
          margin: 1,
          color: {
            dark: '#2f231f',
            light: '#fffdf9',
          },
        })
        if (!cancelled) {
          setQrDataUrl(dataUrl)
        }
      } catch {
        if (!cancelled) {
          setQrDataUrl('')
        }
      }
    }

    void renderQr()
    return () => {
      cancelled = true
    }
  }, [invoice.qrValue])

  if (showThankYou) {
    return (
      <div className="order-success-modal" role="dialog" aria-modal="true" aria-labelledby="thank-you-title">
        <div className="order-success-modal__backdrop" />
        <section className="order-success-card order-success-card--thanking">
          <div className="thank-you-content">
            <div className="checkmark-animation">
              <svg viewBox="0 0 52 52" className="checkmark-svg">
                <circle className="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
                <path className="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
              </svg>
            </div>
            <h2 id="thank-you-title">Cảm ơn quý khách!</h2>
            <p>Đơn hàng đã được xác nhận thành công</p>
            <p className="thank-you-order-id">Mã đơn: {invoice.orderId}</p>
            
            <div className="feedback-section" style={{ marginTop: '2rem', textAlign: 'center' }}>
              <p style={{ marginBottom: '1rem', fontWeight: 500 }}>Vui lòng đánh giá trải nghiệm với Robot nha:</p>
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => {
                      setRating(star)
                      if (onFeedbackSubmit) {
                        onFeedbackSubmit(star, '')
                      } else {
                        onClose()
                      }
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      fontSize: '3rem',
                      cursor: 'pointer',
                      filter: star <= rating ? 'none' : 'grayscale(100%) opacity(0.3)',
                      transition: 'filter 0.2s ease',
                    }}
                  >
                    ⭐
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="order-success-modal" role="dialog" aria-modal="true" aria-labelledby="order-success-title">
      <div className="order-success-modal__backdrop" />
      <section className="order-success-card">
        <div className="order-success-card__hero">
          <div>
            <p className="eyebrow">Đặt hàng thành công</p>
            <h2 id="order-success-title">Cảm ơn quý khách, đơn đã được xác nhận</h2>
            <p className="order-success-card__lead">
              Vui lòng đưa mã QR này cho quầy hoặc lưu lại mã đơn để đối chiếu khi cần.
            </p>
          </div>
          <div className="order-success-card__meta">
            <span className="badge badge--accent">Mã đơn {invoice.orderId}</span>
            <span className="badge badge--soft">{invoice.createdAt}</span>
          </div>
        </div>

        <div className="order-success-card__body">
          <div className="order-success-card__receipt">
            <div className="order-success-card__section-title">
              <span>Chi tiết đơn hàng</span>
              <strong>{invoice.items.length} món</strong>
            </div>
            <ul className="order-success-list">
              {invoice.items.map((item) => (
                <li key={`${invoice.orderId}-${item.item_id}`}>
                  <div>
                    <strong>
                      {item.quantity} x {item.name}
                    </strong>
                    <span>Đơn giá {currency.format(Number(item.unit_price))}</span>
                  </div>
                  <strong>{currency.format(Number(item.line_total))}</strong>
                </li>
              ))}
            </ul>
            <div className="order-success-card__total">
              <span>Tổng cộng</span>
              <strong>{currency.format(invoice.totalAmount)}</strong>
            </div>
          </div>

          <div className="order-success-card__qr">
            <div className="order-success-card__qr-frame">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt={`Mã QR đơn hàng ${invoice.orderId}`} />
              ) : (
                <div className="order-success-card__qr-fallback">
                  <strong>{invoice.orderId}</strong>
                  <span>Đang tạo QR...</span>
                </div>
              )}
            </div>
            <p className="order-success-card__qr-copy">
              QR chứa mã đơn, thời gian tạo và chi tiết món để quầy xác nhận nhanh hơn.
            </p>
          </div>
        </div>

        <div className="order-success-card__footer">
          <div className="order-success-card__countdown">
            <span>Tự đóng sau {countdown}s</span>
            <div aria-hidden="true" className="order-success-card__countdown-bar">
              <div
                className="order-success-card__countdown-fill"
                style={{ 
                  width: `${(countdown / 6) * 100}%`,
                  transition: 'width 1s linear'
                }}
              />
            </div>
          </div>
          <button className="action-button" onClick={onClose} type="button">
            Xong, quay về màn hình chờ
          </button>
        </div>
      </section>
    </div>
  )
}
