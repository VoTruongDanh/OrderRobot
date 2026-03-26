const LEGACY_ENV_VALUE_MIGRATIONS: Record<string, Record<string, string>> = {
  VITE_CORE_API_URL: {
    'http://127.0.0.1:8001': 'http://127.0.0.1:8011',
  },
  VITE_AI_API_URL: {
    'http://127.0.0.1:8002': 'http://127.0.0.1:8012',
  },
  VITE_MENU_API_URL: {
    'http://127.0.0.1:8001/menu': 'http://127.0.0.1:8011/menu',
  },
  VITE_ORDERS_API_URL: {
    'http://127.0.0.1:8001/orders': 'http://127.0.0.1:8011/orders',
  },
}

export const ADMIN_ENV_STORAGE_KEY = 'admin.env.fields'
const ADMIN_ENV_UPDATED_AT_KEY = 'admin.env.updatedAt'
const ADMIN_CONFIG_UPDATED_EVENT = 'orderrobot:admin-config-updated'

export function normalizeEnvValue(key: string, value: string): string {
  return LEGACY_ENV_VALUE_MIGRATIONS[key]?.[value] ?? value
}

function readSavedAdminEnv(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(ADMIN_ENV_STORAGE_KEY)
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return null
  }
}

export function saveAdminEnvConfig(nextConfig: Record<string, string>): void {
  const normalized = Object.fromEntries(
    Object.entries(nextConfig).map(([key, value]) => [key, normalizeEnvValue(key, String(value ?? ''))]),
  )

  const updatedAt = Date.now()
  localStorage.setItem(ADMIN_ENV_STORAGE_KEY, JSON.stringify(normalized))
  localStorage.setItem(ADMIN_ENV_UPDATED_AT_KEY, String(updatedAt))
  window.dispatchEvent(
    new CustomEvent(ADMIN_CONFIG_UPDATED_EVENT, {
      detail: { updatedAt, config: normalized },
    }),
  )
}

export function subscribeAdminConfigChanges(onChange: () => void): () => void {
  const handleCustomEvent = () => onChange()
  const handleStorage = (event: StorageEvent) => {
    if (event.key === ADMIN_ENV_STORAGE_KEY || event.key === ADMIN_ENV_UPDATED_AT_KEY) {
      onChange()
    }
  }

  window.addEventListener(ADMIN_CONFIG_UPDATED_EVENT, handleCustomEvent as EventListener)
  window.addEventListener('storage', handleStorage)

  return () => {
    window.removeEventListener(ADMIN_CONFIG_UPDATED_EVENT, handleCustomEvent as EventListener)
    window.removeEventListener('storage', handleStorage)
  }
}

export function getEnvConfig(key: string, defaultValue: string): string {
  try {
    const saved = readSavedAdminEnv()
    if (saved?.[key]) {
      return normalizeEnvValue(key, saved[key])
    }
  } catch {
    // ignore parsing errors
  }
  // Try to use import.meta.env if defined
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    if (import.meta.env[key]) {
      return normalizeEnvValue(key, import.meta.env[key] as string)
    }
  }
  return defaultValue
}

export function getAllAdminEnvConfig(): Record<string, string> {
  const saved = readSavedAdminEnv()
  if (!saved) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(saved).map(([key, value]) => [key, normalizeEnvValue(key, value)]),
  )
}

export function getAdminConfigUpdatedAt(): number | null {
  const raw = localStorage.getItem(ADMIN_ENV_UPDATED_AT_KEY)
  if (!raw) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function getCoreApiUrl(): string {
  return getEnvConfig('VITE_CORE_API_URL', 'http://127.0.0.1:8011')
}

export function getAiApiUrl(): string {
  return getEnvConfig('VITE_AI_API_URL', 'http://127.0.0.1:8012')
}

export function getMenuApiUrl(): string {
  return getEnvConfig('VITE_MENU_API_URL', `${getCoreApiUrl()}/menu`)
}

export function getOrdersApiUrl(): string {
  return getEnvConfig('VITE_ORDERS_API_URL', `${getCoreApiUrl()}/orders`)
}
