export type MenuItem = {
  item_id: string
  name: string
  category: string
  description: string
  price: string
  available: boolean
  tags: string[]
}

export type CartItem = {
  item_id: string
  name: string
  quantity: number
  unit_price: string
  line_total: string
}

export type ConversationResponse = {
  session_id: string
  reply_text: string
  cart: CartItem[]
  recommended_item_ids: string[]
  needs_confirmation: boolean
  order_created: boolean
  order_id: string | null
  voice_style: string
}

export type BridgeDebugChatResult = {
  reply_text: string
  source: 'bridge' | 'fallback'
  bridge_enabled: boolean
  latency_ms: number
  detail: string | null
}

export type TranscriptEntry = {
  id: string
  speaker: 'assistant' | 'user' | 'system'
  text: string
  timestamp: string
}

export type AppNotice = {
  id: string
  level: 'info' | 'warning'
  text: string
}

export type InvoiceSnapshot = {
  orderId: string
  createdAt: string
  items: CartItem[]
  totalAmount: number
  qrValue: string
}

export type OrderRecord = {
  order_id: string
  session_id: string
  created_at: string
  customer_text: string
  items: CartItem[]
  total_amount: string
  status: 'confirmed'
}

export type RobotMode =
  | 'idle'
  | 'detecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
