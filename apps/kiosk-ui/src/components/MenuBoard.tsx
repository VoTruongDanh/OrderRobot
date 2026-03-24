import { getMenuImage } from '../menuImages'
import type { CartItem, MenuItem } from '../types'

type MenuBoardProps = {
  items: MenuItem[]
  cart: CartItem[]
  recommendedItemIds: string[]
  onAddItem: (item: MenuItem) => void
  onAskItem: (item: MenuItem) => void
}

const currency = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
})

export function MenuBoard({
  items,
  cart,
  recommendedItemIds,
  onAddItem,
  onAskItem,
}: MenuBoardProps) {
  const cartLookup = new Map(cart.map((item) => [item.item_id, item.quantity]))

  return (
    <section className="menu-panel">
      <div className="panel-heading panel-heading--tight menu-panel__heading">
        <div>
          <p className="eyebrow">Menu từ CSV</p>
          <h2>Chọn món bằng giọng nói hoặc chạm để thêm nhanh</h2>
        </div>
        <p className="support-copy">
          Menu cuộn ngang để khách quét nhanh, thêm món bằng click hoặc hỏi robot tư vấn rồi chốt
          đơn.
        </p>
      </div>

      <div className="menu-grid" role="list" aria-label="Menu demo">
        {items.map((item) => {
          const quantity = cartLookup.get(item.item_id)
          const recommended = recommendedItemIds.includes(item.item_id)

          return (
            <article
              className={`menu-card ${recommended ? 'menu-card--recommended' : ''}`}
              key={item.item_id}
              role="listitem"
            >
              <div className="menu-card__image-frame">
                <img
                  className="menu-card__image"
                  src={getMenuImage(item.item_id)}
                  alt={item.name}
                  loading="lazy"
                />
              </div>

              <div className="menu-card__topline">
                <span className={`badge ${item.available ? 'badge--soft' : 'badge--muted'}`}>
                  {item.available ? 'Đang phục vụ' : 'Tạm hết'}
                </span>
                {recommended ? <span className="badge badge--accent">Robot gợi ý</span> : null}
              </div>

              <div className="menu-card__body">
                <h3>{item.name}</h3>
                <p className="menu-description menu-description--clamped">{item.description}</p>
              </div>

              <div className="menu-card__meta">
                <span className="badge badge--muted">{item.category}</span>
                {quantity ? <span className="cart-pill">Trong giỏ: {quantity}</span> : null}
              </div>

              <div className="menu-card__footer">
                <strong>{currency.format(Number(item.price))}</strong>
              </div>

              <div className="menu-card__actions">
                <button
                  className="action-button action-button--ghost action-button--small"
                  onClick={() => onAskItem(item)}
                  type="button"
                >
                  Hỏi robot
                </button>
                <button
                  className="action-button action-button--small"
                  disabled={!item.available}
                  onClick={() => onAddItem(item)}
                  type="button"
                >
                  {item.available ? 'Thêm món' : 'Tạm hết'}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
