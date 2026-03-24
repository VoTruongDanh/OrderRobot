import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

import type { InvoiceSnapshot } from '../types'

type OrderSuccessModalProps = {
  invoice: InvoiceSnapshot
  countdown: number
  onClose: () => void
}

const currency = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
})

export function OrderSuccessModal({ invoice, countdown, onClose }: OrderSuccessModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState('')

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
                style={{ width: `${(countdown / 6) * 100}%` }}
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
