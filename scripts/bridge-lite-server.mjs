import http from 'node:http'
import { URL } from 'node:url'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || process.env.BRIDGE_GATEWAY_PORT || 1122)

const sessions = new Map()

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(body)
}

function extractUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
  const raw = String(lastUser?.content || '').trim()
  if (!raw) return ''

  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.customer_text === 'string' && parsed.customer_text.trim()) {
      return parsed.customer_text.trim()
    }
    if (typeof parsed?.user_text === 'string' && parsed.user_text.trim()) {
      return parsed.user_text.trim()
    }
    if (typeof parsed?.text === 'string' && parsed.text.trim()) {
      return parsed.text.trim()
    }
  } catch {
    // Keep raw text when not JSON.
  }

  return raw
}

function buildLiteReply(userText) {
  const text = userText.toLowerCase()
  if (!userText) {
    return 'Mình đang sẵn sàng nè. Bạn gọi món mình hỗ trợ ngay.'
  }
  if (text.includes('menu') || text.includes('thực đơn') || text.includes('thuc don')) {
    return 'Mình đã mở menu. Bạn chọn món rồi nói tên món giúp mình nhé.'
  }
  if (text.includes('xác nhận') || text.includes('xac nhan') || text.includes('chốt đơn') || text.includes('chot don')) {
    return 'Mình đã ghi nhận xác nhận đơn. Bạn kiểm tra lại giỏ trước khi chốt nhé.'
  }
  if (text.includes('xin chào') || text.includes('xin chao') || text.includes('hello') || text.includes('hi')) {
    return 'Chào bạn, mình là ORDER ROBOT. Bạn muốn gọi món gì hôm nay?'
  }
  return `Mình đã nhận: "${userText}". Bạn muốn thêm món nào nữa không?`
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      status: 'ok',
      mode: 'bridge-lite',
      port: PORT,
      sessions: sessions.size,
      timestamp: new Date().toISOString(),
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/internal/bridge/reset-temp-chat') {
    try {
      const body = await readJsonBody(req)
      const sessionId = String(body?.session_id || '').trim()
      if (sessionId) {
        sessions.delete(sessionId)
      }
      json(res, 200, { ok: true, source: 'bridge-lite' })
    } catch (error) {
      json(res, 400, { ok: false, detail: String(error?.message || error) })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/internal/bridge/chat') {
    try {
      const body = await readJsonBody(req)
      const sessionId = String(body?.session_id || '').trim() || 'default'
      const userText = extractUserText(body)
      const replyText = buildLiteReply(userText)
      sessions.set(sessionId, {
        updatedAt: Date.now(),
        lastUserText: userText,
        lastReplyText: replyText,
      })
      json(res, 200, { reply_text: replyText, source: 'bridge-lite' })
    } catch (error) {
      json(res, 400, { error: 'invalid_request', detail: String(error?.message || error) })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/internal/bridge/chat/stream') {
    try {
      const body = await readJsonBody(req)
      const userText = extractUserText(body)
      const replyText = buildLiteReply(userText)
      const chunks = splitSentences(replyText)

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      for (const chunk of chunks) {
        res.write(`${JSON.stringify({ content: chunk })}\n`)
      }
      res.end()
    } catch (error) {
      json(res, 400, { error: 'invalid_request', detail: String(error?.message || error) })
    }
    return
  }

  json(res, 404, { error: 'not_found', path: url.pathname })
})

server.listen(PORT, HOST, () => {
  console.log(`[bridge-lite] listening at http://${HOST}:${PORT}`)
  console.log('[bridge-lite] endpoints: GET /health, POST /internal/bridge/chat, POST /internal/bridge/chat/stream, POST /internal/bridge/reset-temp-chat')
})

