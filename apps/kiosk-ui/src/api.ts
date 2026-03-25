import { getAiApiUrl, getMenuApiUrl, getOrdersApiUrl } from './config'
import type { BridgeDebugChatResult, ConversationResponse, MenuItem, OrderRecord } from './types'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = 'Khong the ket noi dich vu.'
    try {
      const payload = await response.json()
      detail = payload.detail ?? detail
    } catch {
      detail = response.statusText || detail
    }
    throw new Error(detail)
  }

  return response.json() as Promise<T>
}

export async function fetchMenu(): Promise<MenuItem[]> {
  const response = await fetch(getMenuApiUrl())
  return readJson<MenuItem[]>(response)
}

export async function fetchOrder(orderId: string): Promise<OrderRecord> {
  const response = await fetch(`${getOrdersApiUrl()}/${orderId}`)
  return readJson<OrderRecord>(response)
}

export async function startSession(source: 'camera' | 'manual'): Promise<ConversationResponse> {
  const response = await fetch(`${getAiApiUrl()}/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
  return readJson<ConversationResponse>(response)
}

export async function debugBridgeChat(text: string, rule: string): Promise<BridgeDebugChatResult> {
  const response = await fetch(`${getAiApiUrl()}/debug/bridge-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, rule }),
  })
  return readJson<BridgeDebugChatResult>(response)
}

export async function sendTurn(
  sessionId: string,
  transcript: string,
): Promise<ConversationResponse> {
  const response = await fetch(`${getAiApiUrl()}/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
  })
  return readJson<ConversationResponse>(response)
}

export type StreamChunk =
  | { type: 'text'; content: string; cart?: Array<{ item_id: string; name: string; quantity: number; unit_price: string; line_total: string }> }
  | { type: 'audio'; content: string }

export async function* sendTurnStream(
  sessionId: string,
  transcript: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const response = await fetch(`${getAiApiUrl()}/sessions/${sessionId}/turn/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
    signal,
  })

  if (!response.ok) {
    let detail = 'Không thể kết nối dịch vụ.'
    try {
      const payload = await response.json()
      detail = payload.detail ?? detail
    } catch {
      detail = response.statusText || detail
    }
    throw new Error(detail)
  }

  if (!response.body) {
    throw new Error('Response body is null')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const chunk = JSON.parse(trimmed) as StreamChunk
        yield chunk
      } catch {
        console.warn('Failed to parse streaming chunk:', trimmed)
      }
    }
  }
}

export async function saveFeedback(
  sessionId: string,
  rating: number,
  comment: string,
  transcriptHistory: string[],
): Promise<void> {
  const response = await fetch(`${getAiApiUrl()}/sessions/${sessionId}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, comment, transcript_history: transcriptHistory }),
  })
  if (!response.ok) {
    throw new Error(await readError(response))
  }
}

export async function resetSession(sessionId: string): Promise<ConversationResponse> {
  const response = await fetch(`${getAiApiUrl()}/sessions/${sessionId}/reset`, {
    method: 'POST',
  })
  return readJson<ConversationResponse>(response)
}

export async function synthesizeSpeech(text: string): Promise<Blob> {
  const response = await fetch(`${getAiApiUrl()}/speech/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  return response.blob()
}

export async function synthesizeSpeechStream(text: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${getAiApiUrl()}/speech/synthesize/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  if (!response.body) {
    throw new Error('Response body is null')
  }

  return response.body
}

export type SpeechTranscriptionResult = {
  transcript: string
  status?: 'ok' | 'retry'
  message?: string | null
}

export type StreamingSpeechPartialEvent = { type: 'partial'; transcript: string }
export type StreamingSpeechFinalEvent = {
  type: 'final'
  transcript: string
  status?: 'ok' | 'retry' | 'error'
  message?: string | null
}
export type StreamingSpeechEvent = StreamingSpeechPartialEvent | StreamingSpeechFinalEvent
export type StreamingSpeechMode = 'order' | 'caption'

export class StreamingSpeechClient {
  private socket: WebSocket
  private onError?: (error: Error) => void

  constructor(onEvent: (event: StreamingSpeechEvent) => void, onError?: (error: Error) => void) {
    const wsUrl = buildSpeechWebSocketUrl()
    this.onError = onError
    this.socket = new WebSocket(wsUrl)

    this.socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as StreamingSpeechEvent
        onEvent(payload)
      } catch {
        this.onError?.(new Error('Du lieu streaming STT khong hop le.'))
      }
    }

    this.socket.onerror = () => {
      this.onError?.(new Error('Ket noi streaming STT gap loi.'))
    }
  }

  get isOpen() {
    return this.socket.readyState === WebSocket.OPEN
  }

  async waitUntilOpen(timeoutMs = 3000) {
    if (this.isOpen) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup()
        reject(new Error('Mo ket noi streaming STT bi timeout.'))
      }, timeoutMs)

      const handleOpen = () => {
        cleanup()
        resolve()
      }
      const handleError = () => {
        cleanup()
        reject(new Error('Khong the mo ket noi streaming STT.'))
      }
      const cleanup = () => {
        window.clearTimeout(timeoutId)
        this.socket.removeEventListener('open', handleOpen)
        this.socket.removeEventListener('error', handleError)
      }

      this.socket.addEventListener('open', handleOpen)
      this.socket.addEventListener('error', handleError)
    })
  }

  start(filename = 'speech.webm', mode: StreamingSpeechMode = 'order') {
    if (!this.isOpen) {
      return
    }
    this.socket.send(`start:${mode}:${filename}`)
  }

  sendChunk(chunk: Blob) {
    if (!this.isOpen) {
      return
    }
    this.socket.send(chunk)
  }

  flush() {
    if (!this.isOpen) {
      return
    }
    this.socket.send('flush')
  }

  finalize() {
    if (!this.isOpen) {
      return
    }
    this.socket.send('finalize')
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return
    }
    this.socket.close()
  }
}

export async function transcribeSpeech(audio: Blob): Promise<SpeechTranscriptionResult> {
  const formData = new FormData()
  formData.append('file', audio, 'speech.webm')

  const response = await fetch(`${getAiApiUrl()}/speech/transcribe`, {
    method: 'POST',
    body: formData,
  })

  return readJson<SpeechTranscriptionResult>(response)
}

async function readError(response: Response): Promise<string> {
  let detail = 'Khong the ket noi dich vu.'
  try {
    const payload = await response.json()
    detail = payload.detail ?? detail
  } catch {
    detail = response.statusText || detail
  }
  return detail
}

function buildSpeechWebSocketUrl() {
  const httpUrl = new URL(getAiApiUrl())
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  httpUrl.pathname = '/speech/transcribe/ws'
  httpUrl.search = ''
  httpUrl.hash = ''
  return httpUrl.toString()
}
