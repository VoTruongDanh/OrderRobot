import { useEffect, useMemo, useRef, useState } from 'react'
import './admin.css'
import { getAiApiUrl, getCoreApiUrl } from './config'

declare global {
  interface Window {
    SwaggerUIBundle?: (config: Record<string, unknown>) => unknown
    SwaggerUIStandalonePreset?: unknown
  }
}

type DocTab = 'core' | 'ai'

const SWAGGER_UI_CSS_ID = 'orderrobot-swagger-ui-css'
const SWAGGER_UI_BUNDLE_ID = 'orderrobot-swagger-ui-bundle'
const SWAGGER_UI_PRESET_ID = 'orderrobot-swagger-ui-preset'
const SWAGGER_UI_CSS_URL = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui.css'
const SWAGGER_UI_BUNDLE_URL = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js'
const SWAGGER_UI_PRESET_URL = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js'

function ensureStylesheet(id: string, href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLLinkElement | null
    if (existing) {
      resolve()
      return
    }
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = href
    link.onload = () => resolve()
    link.onerror = () => reject(new Error(`Cannot load stylesheet: ${href}`))
    document.head.appendChild(link)
  })
}

function ensureScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve()
        return
      }
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(`Cannot load script: ${src}`)), {
        once: true,
      })
      return
    }
    const script = document.createElement('script')
    script.id = id
    script.src = src
    script.async = true
    script.onload = () => {
      script.dataset.loaded = 'true'
      resolve()
    }
    script.onerror = () => reject(new Error(`Cannot load script: ${src}`))
    document.body.appendChild(script)
  })
}

async function ensureSwaggerUiRuntime(): Promise<void> {
  await ensureStylesheet(SWAGGER_UI_CSS_ID, SWAGGER_UI_CSS_URL)
  await ensureScript(SWAGGER_UI_BUNDLE_ID, SWAGGER_UI_BUNDLE_URL)
  await ensureScript(SWAGGER_UI_PRESET_ID, SWAGGER_UI_PRESET_URL)
  if (typeof window.SwaggerUIBundle !== 'function') {
    throw new Error('Swagger UI runtime is not available.')
  }
}

function SwaggerPanel({
  title,
  schemaUrl,
  active,
}: {
  title: string
  schemaUrl: string
  active: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!active || !containerRef.current) return
    let cancelled = false
    setLoadingState('loading')
    setError('')

    void (async () => {
      try {
        await ensureSwaggerUiRuntime()
        if (cancelled || !containerRef.current || typeof window.SwaggerUIBundle !== 'function') return
        containerRef.current.innerHTML = ''
        window.SwaggerUIBundle({
          url: schemaUrl,
          domNode: containerRef.current,
          deepLinking: true,
          docExpansion: 'list',
          displayRequestDuration: true,
          defaultModelsExpandDepth: 2,
          defaultModelExpandDepth: 2,
          presets: window.SwaggerUIStandalonePreset ? [window.SwaggerUIStandalonePreset] : [],
          layout: 'BaseLayout',
        })
        if (!cancelled) {
          setLoadingState('ready')
        }
      } catch (runtimeError) {
        if (!cancelled) {
          setLoadingState('error')
          setError(runtimeError instanceof Error ? runtimeError.message : 'Cannot render Swagger UI.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, schemaUrl])

  return (
    <section className="admin-card">
      <div className="admin-card__head">
        <div>
          <h2>{title}</h2>
          <p className="admin-hint">
            Schema: <code>{schemaUrl}</code>
          </p>
        </div>
        {loadingState === 'loading' ? <span className="admin-badge admin-badge--info">Loading UI…</span> : null}
      </div>

      {loadingState === 'error' ? (
        <p className="admin-badge admin-badge--error">
          {error || 'Không tải được Swagger UI. Kiểm tra mạng hoặc CDN runtime.'}
        </p>
      ) : null}

      <div
        ref={containerRef}
        style={{
          minHeight: 520,
          borderRadius: 20,
          overflow: 'hidden',
          background: '#fff',
          border: '1px solid rgba(148, 163, 184, 0.18)',
        }}
      />
    </section>
  )
}

export default function ApiDocsPage() {
  const [activeTab, setActiveTab] = useState<DocTab>('core')
  const coreBaseUrl = getCoreApiUrl().replace(/\/+$/, '')
  const aiBaseUrl = getAiApiUrl().replace(/\/+$/, '')
  const coreOpenApiUrl = useMemo(() => `${coreBaseUrl}/openapi.json`, [coreBaseUrl])
  const aiOpenApiUrl = useMemo(() => `${aiBaseUrl}/openapi.json`, [aiBaseUrl])

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">Developer Docs</p>
          <h1>API Docs</h1>
          <p>Swagger UI ngay trong frontend để xem schema Core và AI backend dễ hơn trên local lẫn LAN.</p>
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
            <h2>Schema Switcher</h2>
            <p className="admin-hint">Chọn schema muốn xem. POS vẫn mở qua Swagger ngoài.</p>
          </div>
          <div className="admin-actions">
            <button
              className="admin-btn"
              type="button"
              onClick={() => setActiveTab('core')}
              aria-pressed={activeTab === 'core'}
            >
              Core API
            </button>
            <button
              className="admin-btn"
              type="button"
              onClick={() => setActiveTab('ai')}
              aria-pressed={activeTab === 'ai'}
            >
              AI API
            </button>
            <a
              className="admin-btn"
              href="http://cnxvn.ddns.net:8080/api/v1/swagger-ui/index.html"
              target="_blank"
              rel="noreferrer"
            >
              POS Swagger
            </a>
          </div>
        </div>
      </section>

      <SwaggerPanel title="Core Backend Swagger UI" schemaUrl={coreOpenApiUrl} active={activeTab === 'core'} />
      <SwaggerPanel title="AI Backend Swagger UI" schemaUrl={aiOpenApiUrl} active={activeTab === 'ai'} />
    </main>
  )
}
