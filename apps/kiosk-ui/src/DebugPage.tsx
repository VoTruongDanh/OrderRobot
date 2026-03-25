import { useState } from 'react'
import type { FormEvent } from 'react'
import './admin.css'
import { debugBridgeChat } from './api'
import { getAiApiUrl } from './config'
import type { BridgeDebugChatResult } from './types'

const DEFAULT_TEXT = 'Cho minh 1 tra dao cam sa'
const DEFAULT_RULE = 'Tra loi than thien, ngan gon, tap trung goi mon.'

export default function DebugPage() {
  const [text, setText] = useState(DEFAULT_TEXT)
  const [rule, setRule] = useState(DEFAULT_RULE)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BridgeDebugChatResult | null>(null)

  const runDebugChat = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedText = text.trim()
    if (!normalizedText) {
      setError('Text khong duoc de trong.')
      return
    }

    setRunning(true)
    setError('')
    try {
      const payload = await debugBridgeChat(normalizedText, rule.trim())
      setResult(payload)
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'Bridge debug chat failed')
    } finally {
      setRunning(false)
    }
  }

  const sourceBadgeClass = result?.source === 'bridge' ? 'admin-badge--ok' : 'admin-badge--error'

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">Order Robot Debug</p>
          <h1>Bridge Web Debug</h1>
          <p>Test nhanh luong hidden bridge qua ai-backend, khong doi contract kiosk.</p>
        </div>
        <div className="admin-actions">
          <a className="admin-back" href="/">
            Kiosk
          </a>
          <a className="admin-back" href="/admin">
            Admin
          </a>
        </div>
      </header>

      <section className="admin-card">
        <div className="admin-card__head">
          <div>
            <h2>Run Bridge Chat</h2>
            <p className="admin-hint">POST {getAiApiUrl()}/debug/bridge-chat</p>
          </div>
          <button className="admin-btn" type="submit" form="bridge-debug-form" disabled={running}>
            {running ? 'Running...' : 'Run Debug'}
          </button>
        </div>

        <form id="bridge-debug-form" className="admin-fields" onSubmit={(event) => void runDebugChat(event)}>
          <label className="admin-field">
            <span>Text</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={4}
              className="admin-preview"
            />
          </label>
          <label className="admin-field">
            <span>Rule (optional)</span>
            <textarea
              value={rule}
              onChange={(event) => setRule(event.target.value)}
              rows={4}
              className="admin-preview"
            />
          </label>
        </form>

        {error ? <p className="admin-badge admin-badge--error">{error}</p> : null}
      </section>

      {result ? (
        <section className="admin-card">
          <div className="admin-card__head">
            <h2>Result</h2>
            <p className={`admin-badge ${sourceBadgeClass}`}>source={result.source}</p>
          </div>
          <p>bridge_enabled: {String(result.bridge_enabled)}</p>
          <p>latency_ms: {result.latency_ms}</p>
          {result.detail ? <p className="admin-badge admin-badge--error">{result.detail}</p> : null}
          <label className="admin-field">
            <span>Reply text</span>
            <textarea value={result.reply_text} readOnly rows={8} className="admin-preview" />
          </label>
        </section>
      ) : null}
    </main>
  )
}
