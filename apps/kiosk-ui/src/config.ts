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
const ADMIN_MIC_NOISE_FILTER_KEY = 'admin.mic.noiseFilter'
const ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY = 'admin.mic.noiseFilterStrength'
const ADMIN_ROBOT_SCALE_PERCENT_KEY = 'admin.robot.scalePercent'
const ADMIN_CAMERA_PREVIEW_VISIBLE_KEY = 'admin.camera.previewVisible'

export type MicNoiseFilterLevel = 'off' | 'balanced' | 'strong'

function clampRobotScalePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 100
  }
  return Math.max(60, Math.min(170, Math.round(value)))
}

function clampMicStrength(value: number): number {
  if (!Number.isFinite(value)) {
    return 60
  }
  return Math.max(0, Math.min(100, Math.round(value)))
}

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

export function getMicNoiseFilterLevel(): MicNoiseFilterLevel {
  const strength = getMicNoiseFilterStrength()
  return getMicNoiseFilterLevelFromStrength(strength)
}

export function getMicNoiseFilterStrength(): number {
  const rawStrength = localStorage.getItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY)
  if (rawStrength !== null) {
    const parsed = Number(rawStrength)
    return clampMicStrength(parsed)
  }

  const saved = localStorage.getItem(ADMIN_MIC_NOISE_FILTER_KEY)
  if (saved === 'off') {
    return 0
  }
  if (saved === 'strong') {
    return 100
  }
  return 60
}

export function getMicNoiseFilterLevelFromStrength(strength: number): MicNoiseFilterLevel {
  if (strength <= 20) {
    return 'off'
  }
  if (strength >= 75) {
    return 'strong'
  }
  return 'balanced'
}

export function setMicNoiseFilterLevel(level: MicNoiseFilterLevel): void {
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_KEY, level)
  const mappedStrength = level === 'off' ? 0 : level === 'strong' ? 100 : 60
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY, String(mappedStrength))
}

export function setMicNoiseFilterStrength(strength: number): void {
  const safeStrength = clampMicStrength(strength)
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY, String(safeStrength))
  localStorage.setItem(
    ADMIN_MIC_NOISE_FILTER_KEY,
    getMicNoiseFilterLevelFromStrength(safeStrength),
  )
}

export function getRobotScalePercent(): number {
  const raw = localStorage.getItem(ADMIN_ROBOT_SCALE_PERCENT_KEY)
  if (raw === null) {
    return 100
  }
  return clampRobotScalePercent(Number(raw))
}

export function setRobotScalePercent(scalePercent: number): void {
  const safeValue = clampRobotScalePercent(scalePercent)
  localStorage.setItem(ADMIN_ROBOT_SCALE_PERCENT_KEY, String(safeValue))
  const updatedAt = Date.now()
  localStorage.setItem(ADMIN_ENV_UPDATED_AT_KEY, String(updatedAt))
  window.dispatchEvent(
    new CustomEvent(ADMIN_CONFIG_UPDATED_EVENT, {
      detail: { updatedAt, robotScalePercent: safeValue },
    }),
  )
}

export function getCameraPreviewVisible(): boolean {
  const raw = localStorage.getItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY)
  if (raw === null) {
    return true
  }
  return raw !== 'false'
}

export function setCameraPreviewVisible(visible: boolean): void {
  localStorage.setItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY, String(Boolean(visible)))
  const updatedAt = Date.now()
  localStorage.setItem(ADMIN_ENV_UPDATED_AT_KEY, String(updatedAt))
  window.dispatchEvent(
    new CustomEvent(ADMIN_CONFIG_UPDATED_EVENT, {
      detail: { updatedAt, cameraPreviewVisible: Boolean(visible) },
    }),
  )
}

export function getMicAudioConstraints(
  levelOrStrength: MicNoiseFilterLevel | number = getMicNoiseFilterStrength(),
): MediaTrackConstraints {
  const level =
    typeof levelOrStrength === 'number'
      ? getMicNoiseFilterLevelFromStrength(levelOrStrength)
      : levelOrStrength

  if (level === 'off') {
    return {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
  }

  if (level === 'strong') {
    return {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  }

  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
}
