import type { ConversationResponse, MenuItem, OrderRecord } from './types'

const CORE_API_URL = import.meta.env.VITE_CORE_API_URL ?? 'http://127.0.0.1:8001'
const AI_API_URL = import.meta.env.VITE_AI_API_URL ?? 'http://127.0.0.1:8002'

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
  const response = await fetch(`${CORE_API_URL}/menu`)
  return readJson<MenuItem[]>(response)
}

export async function fetchOrder(orderId: string): Promise<OrderRecord> {
  const response = await fetch(`${CORE_API_URL}/orders/${orderId}`)
  return readJson<OrderRecord>(response)
}

export async function startSession(source: 'camera' | 'manual'): Promise<ConversationResponse> {
  const response = await fetch(`${AI_API_URL}/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
  return readJson<ConversationResponse>(response)
}

export async function sendTurn(
  sessionId: string,
  transcript: string,
): Promise<ConversationResponse> {
  const response = await fetch(`${AI_API_URL}/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
  })
  return readJson<ConversationResponse>(response)
}

export async function resetSession(sessionId: string): Promise<ConversationResponse> {
  const response = await fetch(`${AI_API_URL}/sessions/${sessionId}/reset`, {
    method: 'POST',
  })
  return readJson<ConversationResponse>(response)
}

export async function synthesizeSpeech(text: string): Promise<Blob> {
  const response = await fetch(`${AI_API_URL}/speech/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  return response.blob()
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

  start(filename = 'speech.webm') {
    if (!this.isOpen) {
      return
    }
    this.socket.send(`start:${filename}`)
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

  const response = await fetch(`${AI_API_URL}/speech/transcribe`, {
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
  const httpUrl = new URL(AI_API_URL)
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  httpUrl.pathname = '/speech/transcribe/ws'
  httpUrl.search = ''
  httpUrl.hash = ''
  return httpUrl.toString()
}
