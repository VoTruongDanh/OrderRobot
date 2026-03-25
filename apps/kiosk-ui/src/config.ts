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

export function normalizeEnvValue(key: string, value: string): string {
  return LEGACY_ENV_VALUE_MIGRATIONS[key]?.[value] ?? value
}

export function getEnvConfig(key: string, defaultValue: string): string {
  try {
    const raw = localStorage.getItem('admin.env.fields')
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, string>
      if (saved[key]) {
        return normalizeEnvValue(key, saved[key])
      }
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
