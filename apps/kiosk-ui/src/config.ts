export function getEnvConfig(key: string, defaultValue: string): string {
  try {
    const raw = localStorage.getItem('admin.env.fields')
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, string>
      if (saved[key]) {
        return saved[key]
      }
    }
  } catch {
    // ignore parsing errors
  }
  // Try to use import.meta.env if defined
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    if (import.meta.env[key]) {
      return import.meta.env[key] as string
    }
  }
  return defaultValue
}

export function getCoreApiUrl(): string {
  return getEnvConfig('VITE_CORE_API_URL', 'http://127.0.0.1:8001')
}

export function getAiApiUrl(): string {
  return getEnvConfig('VITE_AI_API_URL', 'http://127.0.0.1:8002')
}
