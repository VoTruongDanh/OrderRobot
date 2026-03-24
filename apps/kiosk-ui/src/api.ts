import type { ConversationResponse, MenuItem, OrderRecord } from './types'

const CORE_API_URL = import.meta.env.VITE_CORE_API_URL ?? 'http://127.0.0.1:8001'
const AI_API_URL = import.meta.env.VITE_AI_API_URL ?? 'http://127.0.0.1:8002'

async function readJson<T>(response: Response): Promise<T> {
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

export type StreamingSpeechEvent =
  | { type: 'partial'; transcript: string }
  | { type: 'final'; transcript: string; status?: 'ok' | 'retry' | 'error'; message?: string | null }

export class StreamingSpeechClient {
  private socket: WebSocket

  constructor(onEvent: (event: StreamingSpeechEvent) => void) {
    const wsUrl = buildSpeechWebSocketUrl()
    this.socket = new WebSocket(wsUrl)
    this.socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data)) as StreamingSpeechEvent
      onEvent(payload)
    }
  }

  async waitUntilOpen() {
    if (this.socket.readyState === WebSocket.OPEN) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup()
        resolve()
      }
      const handleError = () => {
        cleanup()
        reject(new Error('Không thể mở kết nối streaming STT.'))
      }
      const cleanup = () => {
        this.socket.removeEventListener('open', handleOpen)
        this.socket.removeEventListener('error', handleError)
      }

      this.socket.addEventListener('open', handleOpen)
      this.socket.addEventListener('error', handleError)
    })
  }

  start(filename = 'speech.webm') {
    this.socket.send(`start:${filename}`)
  }

  sendChunk(chunk: Blob) {
    this.socket.send(chunk)
  }

  flush() {
    this.socket.send('flush')
  }

  finalize() {
    this.socket.send('finalize')
  }

  close() {
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
  let detail = 'Không thể kết nối dịch vụ.'
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
