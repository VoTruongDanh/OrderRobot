import { useCallback, useEffect, useMemo, useState } from 'react'
import './admin.css'
import { useLiveCaption } from './hooks/useLiveCaption'
import { useSpeech } from './hooks/useSpeech'

type ServiceStatus = {
  name: string
  url: string
  status: 'idle' | 'checking' | 'ok' | 'error'
  latencyMs: number | null
  detail: string
}

type EnvField = {
  key: string
  label: string
  value: string
}

const CORE_API_URL = import.meta.env.VITE_CORE_API_URL ?? 'http://127.0.0.1:8001'
const AI_API_URL = import.meta.env.VITE_AI_API_URL ?? 'http://127.0.0.1:8002'

const ENV_TEMPLATE: EnvField[] = [
  { key: 'AI_BASE_URL', label: 'AI Base URL', value: 'http://127.0.0.1:11434/v1' },
  { key: 'AI_API_KEY', label: 'AI API Key', value: '' },
  { key: 'AI_MODEL', label: 'AI Model', value: 'gpt-4o-mini' },
  { key: 'CORE_BACKEND_URL', label: 'Core Backend URL', value: CORE_API_URL },
  { key: 'VOICE_LANG', label: 'Voice Lang', value: 'vi-VN' },
  { key: 'VOICE_STYLE', label: 'Voice Style', value: 'cute_friendly' },
  { key: 'TTS_VOICE', label: 'TTS Voice', value: 'vi-VN-HoaiMyNeural' },
  { key: 'TTS_RATE', label: 'TTS Rate', value: '165' },
  { key: 'STT_MODEL', label: 'STT Model', value: 'small' },
  { key: 'STT_DEVICE', label: 'STT Device', value: 'cpu' },
  { key: 'STT_COMPUTE_TYPE', label: 'STT Compute Type', value: 'int8' },
  { key: 'STT_BEAM_SIZE', label: 'STT Beam Size', value: '5' },
  { key: 'STT_BEST_OF', label: 'STT Best Of', value: '3' },
  { key: 'STT_PARTIAL_BEAM_SIZE', label: 'STT Partial Beam', value: '2' },
  { key: 'STT_PARTIAL_BEST_OF', label: 'STT Partial Best Of', value: '1' },
  { key: 'STT_VAD_MIN_SILENCE_MS', label: 'STT VAD Min Silence', value: '450' },
  { key: 'STT_PRELOAD', label: 'STT Preload', value: 'true' },
  { key: 'STT_CPU_THREADS', label: 'STT CPU Threads', value: '8' },
  { key: 'STT_NUM_WORKERS', label: 'STT Num Workers', value: '1' },
  { key: 'SESSION_TIMEOUT_MINUTES', label: 'Session Timeout Minutes', value: '15' },
  { key: 'VITE_CORE_API_URL', label: 'VITE Core URL', value: CORE_API_URL },
  { key: 'VITE_AI_API_URL', label: 'VITE AI URL', value: AI_API_URL },
]

function loadSavedEnv(): EnvField[] {
  try {
    const raw = localStorage.getItem('admin.env.fields')
    if (!raw) {
      return ENV_TEMPLATE
    }
    const saved = JSON.parse(raw) as Record<string, string>
    return ENV_TEMPLATE.map((field) => ({
      ...field,
      value: saved[field.key] ?? field.value,
    }))
  } catch {
    return ENV_TEMPLATE
  }
}

export default function AdminPage() {
  const [services, setServices] = useState<ServiceStatus[]>([
    { name: 'Core Backend', url: `${CORE_API_URL}/health`, status: 'idle', latencyMs: null, detail: '' },
    { name: 'AI Backend', url: `${AI_API_URL}/health`, status: 'idle', latencyMs: null, detail: '' },
  ])
  const [micState, setMicState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [micDetail, setMicDetail] = useState('')
  const [sttPartialText, setSttPartialText] = useState('')
  const [sttFinalText, setSttFinalText] = useState('')
  const [envFields, setEnvFields] = useState<EnvField[]>(() => loadSavedEnv())
  const [copied, setCopied] = useState(false)
  const [speechNotices, setSpeechNotices] = useState<Array<{ text: string; level: 'warning' | 'info' }>>([])
  const [ttsVoice, setTtsVoice] = useState('vi-VN-HoaiMyNeural')
  const [ttsRate, setTtsRate] = useState('200')
  const [ttsTestText, setTtsTestText] = useState('Xin chào! Mình là robot đặt món. Bạn muốn gọi gì hôm nay?')
  const [ttsTestStatus, setTtsTestStatus] = useState<'idle' | 'playing' | 'error'>('idle')
  const liveCaption = useLiveCaption({ lang: 'vi-VN' })

  const { listening, interimTranscript, recognitionSupported, startListening, stopListening } = useSpeech({
    lang: 'vi-VN',
    onTranscript: (transcript) => {
      setSttFinalText(transcript)
      setMicState('ok')
      setMicDetail('STT da nhan duoc transcript tu luong kiosk hien tai.')
    },
    onNotice: (message, level = 'warning') => {
      setSpeechNotices((current) => {
        if (current.some((notice) => notice.text === message)) {
          return current
        }
        return [...current, { text: message, level }]
      })
      if (level === 'warning') {
        setMicState('error')
      }
      setMicDetail(message)
    },
  })

  // Update partial transcript from interimTranscript
  useEffect(() => {
    setSttPartialText(interimTranscript)
    if (interimTranscript.trim()) {
      setMicState('ok')
      setMicDetail('Dang nhan partial transcript...')
    }
  }, [interimTranscript])

  const checkService = useCallback(async (service: ServiceStatus) => {
    const startedAt = performance.now()
    try {
      const response = await fetch(service.url, { method: 'GET' })
      const latencyMs = Math.round(performance.now() - startedAt)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return { ...service, status: 'ok' as const, latencyMs, detail: 'OK' }
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt)
      return {
        ...service,
        status: 'error' as const,
        latencyMs,
        detail: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }, [])

  const runHealthChecks = useCallback(async () => {
    setServices((current) =>
      current.map((service) => ({ ...service, status: 'checking', detail: 'Checking...' })),
    )
    const checked = await Promise.all(services.map((service) => checkService(service)))
    setServices(checked)
  }, [checkService, services])

  const runMicCheck = useCallback(async () => {
    setMicState('checking')
    setMicDetail('Requesting microphone permission...')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const tracks = stream.getAudioTracks()
      const trackLabel = tracks[0]?.label || 'Microphone ready'
      tracks.forEach((track) => track.stop())
      setMicState('ok')
      setMicDetail(trackLabel)
    } catch (error) {
      setMicState('error')
      setMicDetail(error instanceof Error ? error.message : 'Microphone not available')
    }
  }, [])

  const startBrowserStt = useCallback(async () => {
    if (!recognitionSupported) {
      setMicState('error')
      setMicDetail('Trinh duyet nay khong ho tro luong thu am/STT cua kiosk.')
      return
    }

    setSpeechNotices([])
    setSttPartialText('')
    setSttFinalText('')
    setMicState('checking')
    setMicDetail('Dang khoi dong luong STT giong trang kiosk...')
    try {
      await startListening()
      setMicState('ok')
      setMicDetail('Dang nghe bang dung luong STT cua kiosk.')
    } catch (error) {
      setMicState('error')
      setMicDetail(error instanceof Error ? error.message : 'Khong the bat STT.')
    }
  }, [recognitionSupported, startListening])

  const stopBrowserStt = useCallback(async () => {
    if (!listening) {
      return
    }
    stopListening()
    setMicState('ok')
    setMicDetail('Da dung thu am, dang cho transcript cuoi neu co.')
  }, [listening, stopListening])

  const envText = useMemo(
    () => envFields.map((field) => `${field.key}=${field.value}`).join('\n'),
    [envFields],
  )

  const saveEnvDraft = useCallback(() => {
    const payload = Object.fromEntries(envFields.map((field) => [field.key, field.value]))
    localStorage.setItem('admin.env.fields', JSON.stringify(payload))
  }, [envFields])

  const copyEnv = useCallback(async () => {
    await navigator.clipboard.writeText(envText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [envText])

  const testTtsVoice = useCallback(async () => {
    setTtsTestStatus('playing')
    try {
      const response = await fetch(`${AI_API_URL}/speech/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ttsTestText,
          voice: ttsVoice,
          rate: parseInt(ttsRate, 10),
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const audioBlob = await response.blob()
      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl)
          resolve()
        }
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl)
          reject(new Error('Audio playback failed'))
        }
        audio.play().catch(reject)
      })

      setTtsTestStatus('idle')
    } catch (error) {
      setTtsTestStatus('error')
      console.error('TTS test failed:', error)
      setTimeout(() => setTtsTestStatus('idle'), 2000)
    }
  }, [ttsTestText, ttsVoice, ttsRate])

  const applyTtsConfig = useCallback(async () => {
    try {
      // Update backend runtime config
      const response = await fetch(`${AI_API_URL}/config/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: ttsVoice,
          rate: parseInt(ttsRate, 10),
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      // Also update env fields for .env export
      setEnvFields((current) =>
        current.map((item) => {
          if (item.key === 'TTS_VOICE') return { ...item, value: ttsVoice }
          if (item.key === 'TTS_RATE') return { ...item, value: ttsRate }
          return item
        }),
      )

      alert('✅ Đã apply TTS config vào backend! Trang chính sẽ dùng giọng mới ngay.')
    } catch (error) {
      alert('❌ Không thể apply config: ' + (error instanceof Error ? error.message : 'Unknown error'))
    }
  }, [ttsVoice, ttsRate])

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">Order Robot Admin</p>
          <h1>Health, Microphone, and .env Config</h1>
          <p>Use this page to validate runtime connections and prepare a full `.env` quickly.</p>
        </div>
        <a className="admin-back" href="/">
          Back to Kiosk
        </a>
      </header>

      <section className="admin-card">
        <div className="admin-card__head">
          <div>
            <h2>Alternative Live Caption</h2>
            <p className="admin-hint">
              Uu tien backend streaming STT de test caption on dinh truoc. Neu backend audio capture
              khong kha dung thi moi thu native SpeechRecognition cua browser.
            </p>
          </div>
          <div className="admin-actions">
            <button className="admin-btn admin-btn--ghost" type="button" onClick={liveCaption.clear}>
              Clear
            </button>
            {liveCaption.isListening ? (
              <button className="admin-btn" type="button" onClick={liveCaption.stop}>
                Stop Caption
              </button>
            ) : (
              <button className="admin-btn" type="button" onClick={() => void liveCaption.start()}>
                Start Caption
              </button>
            )}
          </div>
        </div>
        <p
          className={`admin-badge admin-badge--${
            liveCaption.status === 'error' || liveCaption.status === 'unsupported' ? 'error' : 'ok'
          }`}
        >
          {liveCaption.status}
        </p>
        <p>
          Support native SpeechRecognition: <strong>{liveCaption.supported ? 'yes' : 'no'}</strong>
        </p>
        <p>
          Active engine: <strong>{liveCaption.engine ?? 'none'}</strong> | Backend live caption:{' '}
          <strong>{liveCaption.backendSupported ? 'yes' : 'no'}</strong>
        </p>
        <p>
          Native SpeechRecognition available: <strong>{liveCaption.supported ? 'yes' : 'no'}</strong>
        </p>
        <div className="admin-stt">
          <label>
            <span>Final caption stream</span>
            <textarea
              value={liveCaption.finalTranscript}
              readOnly
              placeholder="Caption final se tich luy lien tuc o day..."
            />
          </label>
          <label>
            <span>Interim caption</span>
            <textarea
              value={liveCaption.interimTranscript}
              readOnly
              placeholder="Caption tam thoi se cap nhat lien tuc o day..."
            />
          </label>
        </div>
        {liveCaption.error ? (
          <p className="admin-badge admin-badge--error">{liveCaption.error}</p>
        ) : (
          <p className="admin-badge admin-badge--ok">
            Live caption mode uu tien toc do va tinh lien tuc, giong caption hon la voice-turn.
          </p>
        )}
      </section>

      <section className="admin-card">
        <div className="admin-card__head">
          <h2>Service Health Check</h2>
          <button className="admin-btn" type="button" onClick={() => void runHealthChecks()}>
            Check Now
          </button>
        </div>
        <div className="admin-grid">
          {services.map((service) => (
            <article key={service.name} className="admin-service">
              <h3>{service.name}</h3>
              <p className="admin-url">{service.url}</p>
              <p className={`admin-badge admin-badge--${service.status}`}>{service.status}</p>
              <p>{service.detail || 'Not checked yet'}</p>
              <p>{service.latencyMs !== null ? `${service.latencyMs} ms` : '-'}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-card">
        <div className="admin-card__head">
          <h2>Microphone + Kiosk STT Flow</h2>
          <p className="admin-hint">
            Day la flow goi mon hien tai cua kiosk. Nhanh hon truoc nhung van la speech-turn, khong
            phai live caption thuần.
          </p>
          <div className="admin-actions">
            <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void runMicCheck()}>
              Check Mic
            </button>
            {listening ? (
              <button className="admin-btn" type="button" onClick={() => void stopBrowserStt()}>
                Stop STT
              </button>
            ) : (
              <button className="admin-btn" type="button" onClick={() => void startBrowserStt()}>
                Start STT
              </button>
            )}
          </div>
        </div>
        <p className={`admin-badge admin-badge--${micState}`}>{micState}</p>
        <p>{micDetail || 'Not checked yet'}</p>
        <p>
          Listening: <strong>{listening ? 'yes' : 'no'}</strong> | Recognition supported:{' '}
          <strong>{recognitionSupported ? 'yes' : 'no'}</strong>
        </p>
        <div className="admin-stt">
          <label>
            <span>Live transcript</span>
            <textarea value={sttPartialText} readOnly placeholder="Realtime text tu kiosk STT..." />
          </label>
          <label>
            <span>Final transcript</span>
            <textarea value={sttFinalText} readOnly placeholder="Final text after stop..." />
          </label>
        </div>
        {speechNotices.length > 0 ? (
          <div className="admin-fields">
            {speechNotices.map((notice) => (
              <p key={`${notice.level}-${notice.text}`} className={`admin-badge admin-badge--${notice.level === 'warning' ? 'error' : 'ok'}`}>
                {notice.text}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="admin-card">
        <div className="admin-card__head">
          <h2>TTS Voice Testing</h2>
          <p className="admin-hint">
            Test các giọng TTS khác nhau với tốc độ khác nhau. Chọn giọng và rate rồi bấm "Đọc thử" để nghe.
          </p>
        </div>

        <div className="admin-fields">
          <label className="admin-field">
            <span>TTS Voice</span>
            <select value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
              <option value="vi-VN-HoaiMyNeural">vi-VN-HoaiMyNeural (Nữ, Neural)</option>
              <option value="vi-VN-NamMinhNeural">vi-VN-NamMinhNeural (Nam, Neural)</option>
              <option value="vi-VN-An">vi-VN-An (Nam, Standard)</option>
              <option value="vi-VN-HoaiMy">vi-VN-HoaiMy (Nữ, Standard)</option>
            </select>
          </label>

          <label className="admin-field">
            <span>TTS Rate (tốc độ: 100-300, mặc định 165)</span>
            <input
              type="number"
              min="100"
              max="300"
              step="5"
              value={ttsRate}
              onChange={(e) => setTtsRate(e.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Text để test</span>
            <textarea
              value={ttsTestText}
              onChange={(e) => setTtsTestText(e.target.value)}
              placeholder="Nhập text để test giọng đọc..."
              rows={3}
            />
          </label>
        </div>

        <div className="admin-actions">
          <button
            className="admin-btn"
            type="button"
            onClick={() => void testTtsVoice()}
            disabled={ttsTestStatus === 'playing'}
          >
            {ttsTestStatus === 'playing' ? 'Đang đọc...' : ttsTestStatus === 'error' ? 'Lỗi!' : 'Đọc thử'}
          </button>
          <button
            className="admin-btn admin-btn--ghost"
            type="button"
            onClick={() => void applyTtsConfig()}
          >
            Apply ngay
          </button>
        </div>

        <p className="admin-hint">
          Sau khi test xong, bấm "Apply ngay" để backend dùng giọng mới. Trang chính sẽ thấy thay đổi ngay lập tức.
        </p>
      </section>

      <section className="admin-card">
        <div className="admin-card__head">
          <h2>.env Builder</h2>
          <div className="admin-actions">
            <button className="admin-btn admin-btn--ghost" type="button" onClick={saveEnvDraft}>
              Save Draft
            </button>
            <button className="admin-btn" type="button" onClick={() => void copyEnv()}>
              {copied ? 'Copied' : 'Copy .env'}
            </button>
          </div>
        </div>

        <div className="admin-fields">
          {envFields.map((field) => (
            <label key={field.key} className="admin-field">
              <span>{field.label}</span>
              <input
                value={field.value}
                onChange={(event) => {
                  const next = event.target.value
                  setEnvFields((current) =>
                    current.map((item) => (item.key === field.key ? { ...item, value: next } : item)),
                  )
                }}
              />
            </label>
          ))}
        </div>

        <textarea className="admin-preview" value={envText} readOnly />
      </section>
    </main>
  )
}
