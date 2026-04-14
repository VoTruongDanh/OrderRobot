import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './index.css'
import App from './App.tsx'
import AdminPage from './AdminPage.tsx'
import DebugPage from './DebugPage.tsx'
import { getAllAdminEnvConfig } from './config'

const ADMIN_AUTH_TOKEN_KEY = 'admin.auth.accessToken'
const ADMIN_AUTH_USER_KEY = 'admin.auth.username'
const DEFAULT_ADMIN_LOGIN_URL = 'http://cnxvn.ddns.net:8080/api/v1/auth/login'
const DEFAULT_CORE_API_URL = 'http://127.0.0.1:8011'

function extractAccessToken(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return ''
  }
  const safePayload = payload as {
    data?: { accessToken?: string }
    accessToken?: string
  }
  return String(safePayload?.data?.accessToken || safePayload?.accessToken || '').trim().replace(/^Bearer\s+/i, '')
}

async function requestLogin(targetUrl: string, username: string, password: string): Promise<{ accessToken: string }> {
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = String(payload?.message || payload?.error || payload?.detail || `Login failed (HTTP ${response.status}).`)
    throw new Error(detail)
  }

  const accessToken = extractAccessToken(payload)
  if (!accessToken) {
    throw new Error('Login succeeded but no access token was returned.')
  }
  return { accessToken }
}

function isNetworkLikeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '')
  return /failed to fetch|networkerror|load failed|cors|network request failed/i.test(message)
}

function AdminLoginGate() {
  const [username, setUsername] = useState(() => localStorage.getItem(ADMIN_AUTH_USER_KEY) || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(localStorage.getItem(ADMIN_AUTH_TOKEN_KEY)))

  const loginUrl = useMemo(() => {
    const envConfig = getAllAdminEnvConfig()
    return String(envConfig.POS_AUTH_LOGIN_URL || DEFAULT_ADMIN_LOGIN_URL).trim() || DEFAULT_ADMIN_LOGIN_URL
  }, [])

  const coreApiBaseUrl = useMemo(() => {
    const raw = String(import.meta.env.VITE_CORE_API_URL || DEFAULT_CORE_API_URL).trim()
    return raw.replace(/\/+$/, '')
  }, [])

  const proxyLoginUrl = `${coreApiBaseUrl}/auth/login/proxy`

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleanUsername = username.trim()
    if (!cleanUsername || !password) {
      setError('Please enter both username and password.')
      return
    }

    setLoading(true)
    setError('')
    try {
      let accessToken = ''
      try {
        const result = await requestLogin(proxyLoginUrl, cleanUsername, password)
        accessToken = result.accessToken
      } catch (proxyErr) {
        if (!isNetworkLikeError(proxyErr) || loginUrl === proxyLoginUrl) {
          throw proxyErr
        }

        const result = await requestLogin(loginUrl, cleanUsername, password)
        accessToken = result.accessToken
      }

      localStorage.setItem(ADMIN_AUTH_TOKEN_KEY, accessToken)
      localStorage.setItem(ADMIN_AUTH_USER_KEY, cleanUsername)
      setIsAuthenticated(true)
      setPassword('')
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Login failed.'
      if (/failed to fetch/i.test(detail)) {
        setError('Cannot reach login service. Start core backend (port 8011) and try again.')
      } else {
        setError(detail)
      }
    } finally {
      setLoading(false)
    }
  }

  if (isAuthenticated) {
    return <AdminPage />
  }

  return (
    <main className="admin-page admin-login-page">
      <span className="admin-page__backdrop admin-page__backdrop--one" aria-hidden="true" />
      <span className="admin-page__backdrop admin-page__backdrop--two" aria-hidden="true" />

      <section className="admin-login-shell">
        <header className="admin-login-head">
          <p className="admin-kicker">Admin Access</p>
          <h1>Admin Sign In</h1>
          <p>Kiosk ordering stays open. Only the Admin page requires authentication.</p>
          <div className="admin-login-meta" aria-hidden="true">
            <span className="admin-login-meta__dot" />
            <span>Secure login via POS authentication API</span>
          </div>
        </header>

        <form className="admin-login-form" onSubmit={(event) => void handleLogin(event)}>
          <label className="admin-field admin-login-field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="Enter your account email"
              inputMode="email"
              aria-invalid={Boolean(error) && !username.trim()}
              aria-describedby="admin-login-help"
            />
          </label>

          <label className="admin-field admin-login-field">
            <span>Password</span>
            <div className="admin-login-password-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                aria-invalid={Boolean(error) && !password}
                aria-describedby="admin-login-help"
              />
              <button
                type="button"
                className="admin-login-toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <p id="admin-login-help" className="admin-login-help">
            Use your existing POS admin credentials.
          </p>

          <button className="admin-btn admin-login-submit" type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In to Admin'}
          </button>

          {error ? (
            <p className="admin-login-error" role="alert" aria-live="polite">
              {error}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  )
}

const isAdminRoute = window.location.pathname === '/admin'
const isDebugRoute = window.location.pathname === '/debug'
const routeClass = isAdminRoute ? 'route-admin' : isDebugRoute ? 'route-debug' : 'route-kiosk'

document.body.classList.remove('route-kiosk', 'route-admin', 'route-debug')
document.body.classList.add(routeClass)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute ? <AdminLoginGate /> : isDebugRoute ? <DebugPage /> : <App />}
  </StrictMode>,
)
