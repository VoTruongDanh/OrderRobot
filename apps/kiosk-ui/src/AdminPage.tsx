import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './admin.css'
import RobotStudioPanel from './RobotStudioPanel'
import {
  ADMIN_ENV_STORAGE_KEY,
  getAdminConfigUpdatedAt,
  getAiApiUrl,
  getCameraPreviewVisible,
  getCoreApiUrl,
  getMicAudioConstraints,
  getMicNoiseFilterLevelFromStrength,
  getMicNoiseFilterStrength,
  getRobotScalePercent,
  getMenuApiUrl,
  getOrdersApiUrl,
  normalizeEnvValue,
  saveAdminEnvConfig,
  setCameraPreviewVisible as persistCameraPreviewVisible,
  setMicNoiseFilterStrength as persistMicNoiseFilterStrength,
  setRobotScalePercent as persistRobotScalePercent,
} from './config'
import { useLiveCaption } from './hooks/useLiveCaption'
import { useSpeech } from './hooks/useSpeech'

type AdminTab = 'overview' | 'voice' | 'robotStudio' | 'config'
type UiLanguage = 'vi' | 'en'
type AdminMenuGroup = 'monitor' | 'audio' | 'robot' | 'system'

type ServiceStatus = {
  name: string
  url: string
  status: 'idle' | 'checking' | 'ok' | 'error'
  latencyMs: number | null
  detail: string
}

type NoticeTone = 'info' | 'success' | 'warning' | 'error'

type Notice = {
  tone: NoticeTone
  text: string
}

type VieneuRealtimeProfile = {
  id: string
  label: Record<UiLanguage, string>
  hint: Record<UiLanguage, string>
  modelPath: string
  sttModel: string
  sttDevice: string
  sttComputeType: string
}

type EnvField = {
  key: string
  label: string
  value: string
}

type TtsApplyStatus = 'idle' | 'saving' | 'success' | 'error'

const ADMIN_UI_LANGUAGE_KEY = 'admin.ui.language'

const MENU_GROUPS: Array<{ id: AdminMenuGroup; label: Record<UiLanguage, string> }> = [
  { id: 'monitor', label: { vi: 'Giám sát', en: 'Monitoring' } },
  { id: 'audio', label: { vi: 'Âm thanh', en: 'Audio' } },
  { id: 'robot', label: { vi: 'Robot', en: 'Robot' } },
  { id: 'system', label: { vi: 'Hệ thống', en: 'System' } },
]

const TAB_ITEMS: Array<{
  id: AdminTab
  group: AdminMenuGroup
  icon: string
  label: Record<UiLanguage, string>
  hint: Record<UiLanguage, string>
}> = [
  {
    id: 'overview',
    group: 'monitor',
    icon: '01',
    label: { vi: 'Tổng quan', en: 'Overview' },
    hint: {
      vi: 'Theo dõi dịch vụ và độ trễ theo thời gian thực.',
      en: 'Quickly check what is healthy and what is failing.',
    },
  },
  {
    id: 'voice',
    group: 'audio',
    icon: '02',
    label: { vi: 'Giọng nói', en: 'Voice' },
    hint: {
      vi: 'Tinh chỉnh TTS, STT và kiểm tra microphone.',
      en: 'Configure TTS and run technical voice tests.',
    },
  },
  {
    id: 'robotStudio',
    group: 'robot',
    icon: '03',
    label: { vi: 'Robot Studio', en: 'Robot Studio' },
    hint: {
      vi: 'Quản lý skin, hành vi và motion của robot.',
      en: 'Skin, actions, graphs, and triggers.',
    },
  },
  {
    id: 'config',
    group: 'system',
    icon: '04',
    label: { vi: 'Cấu hình', en: 'Configuration' },
    hint: {
      vi: 'Lưu biến môi trường và đồng bộ kiosk ngay.',
      en: 'Save settings and sync to kiosk instantly.',
    },
  },
]

const ESSENTIAL_ENV_KEYS = new Set([
  'VITE_CORE_API_URL',
  'VITE_AI_API_URL',
  'VITE_MENU_API_URL',
  'VITE_ORDERS_API_URL',
  'AI_MODEL',
  'CORE_BACKEND_URL',
  'TTS_ENGINE',
  'TTS_VOICE',
  'TTS_RATE',
  'VOICE_LANG',
  'SESSION_TIMEOUT_MINUTES',
])

const ENV_TEMPLATE: EnvField[] = [
  { key: 'AI_BASE_URL', label: 'AI Base URL', value: 'http://127.0.0.1:11434/v1' },
  { key: 'AI_API_KEY', label: 'AI API Key', value: '' },
  { key: 'AI_MODEL', label: 'AI Model', value: 'gpt-4o-mini' },
  { key: 'CORE_BACKEND_URL', label: 'Core Backend URL', value: getCoreApiUrl() },
  { key: 'VOICE_LANG', label: 'Voice Lang', value: 'vi-VN' },
  { key: 'VOICE_STYLE', label: 'Voice Style', value: 'cute_friendly' },
  { key: 'TTS_ENGINE', label: 'TTS Engine', value: 'vieneu' },
  { key: 'TTS_VIENEU_MODEL_PATH', label: 'VieNeu Model Path', value: 'pnnbao-ump/VieNeu-TTS-0.3B-q4-gguf' },
  { key: 'TTS_VIENEU_VOICE_ID', label: 'VieNeu Voice ID', value: '' },
  { key: 'TTS_VIENEU_REF_AUDIO', label: 'VieNeu Ref Audio Path', value: '' },
  { key: 'TTS_VIENEU_REF_TEXT', label: 'VieNeu Ref Text', value: '' },
  { key: 'TTS_VIENEU_TEMPERATURE', label: 'VieNeu Temperature', value: '1.0' },
  { key: 'TTS_VIENEU_TOP_K', label: 'VieNeu Top K', value: '50' },
  { key: 'TTS_VIENEU_MAX_CHARS', label: 'VieNeu Max Chars', value: '256' },
  { key: 'VIENEU_REALTIME_PROFILE', label: 'VieNeu Realtime Profile', value: 'cpu_realtime' },
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
  { key: 'VITE_CORE_API_URL', label: 'VITE Core URL', value: getCoreApiUrl() },
  { key: 'VITE_AI_API_URL', label: 'VITE AI URL', value: getAiApiUrl() },
  { key: 'VITE_MENU_API_URL', label: 'VITE Menu API URL', value: getMenuApiUrl() },
  { key: 'VITE_ORDERS_API_URL', label: 'VITE Orders API URL', value: getOrdersApiUrl() },
]

const TTS_VOICE_OPTIONS = [
  { value: 'vi-VN-HoaiMyNeural', label: 'Hoài My Neural (Nữ, tự nhiên)' },
  { value: 'vi-VN-NamMinhNeural', label: 'Nam Minh Neural (Nam, tự nhiên)' },
  { value: 'en-US-AvaMultilingualNeural', label: 'Ava Multilingual Neural (Nữ, mềm)' },
  { value: 'en-US-AndrewMultilingualNeural', label: 'Andrew Multilingual Neural (Nam, đầm)' },
  { value: 'vi-VN-An', label: 'vi-VN-An (Nam, Standard)' },
  { value: 'vi-VN-HoaiMy', label: 'vi-VN-HoaiMy (Nữ, Standard)' },
]

const TTS_NATURAL_PRESETS: Array<{ label: Record<UiLanguage, string>; voice: string; rate: string }> = [
  {
    label: { vi: 'Nữ tự nhiên', en: 'Natural Female' },
    voice: 'vi-VN-HoaiMyNeural',
    rate: '165',
  },
  {
    label: { vi: 'Nam tự nhiên', en: 'Natural Male' },
    voice: 'vi-VN-NamMinhNeural',
    rate: '160',
  },
  {
    label: { vi: 'Nữ mềm chat', en: 'Soft Chat Female' },
    voice: 'en-US-AvaMultilingualNeural',
    rate: '155',
  },
  {
    label: { vi: 'Nam âm đầm', en: 'Warm Deep Male' },
    voice: 'en-US-AndrewMultilingualNeural',
    rate: '155',
  },
]

const TTS_ENGINE_OPTIONS = [
  { value: 'vieneu', label: 'VieNeu-TTS (CPU/GPU offline)' },
  { value: 'edge', label: 'Edge Neural (cloud)' },
  { value: 'local', label: 'Local pyttsx3 (fallback)' },
  { value: 'auto', label: 'Auto (ưu tiên VieNeu)' },
]

const VIENEU_REALTIME_PROFILES: VieneuRealtimeProfile[] = [
  {
    id: 'cpu_realtime',
    label: { vi: 'CPU realtime (0.3B Q4)', en: 'CPU realtime (0.3B Q4)' },
    hint: {
      vi: 'Ưu tiên độ trễ thấp trên CPU, dùng model GGUF 0.3B-q4.',
      en: 'Prioritize low latency on CPU with GGUF 0.3B-q4 model.',
    },
    modelPath: 'pnnbao-ump/VieNeu-TTS-0.3B-q4-gguf',
    sttModel: 'base',
    sttDevice: 'cpu',
    sttComputeType: 'int8',
  },
  {
    id: 'gpu_realtime',
    label: { vi: 'GPU realtime (0.3B)', en: 'GPU realtime (0.3B)' },
    hint: {
      vi: 'Tốc độ nhanh hơn trên NVIDIA GPU, cần CUDA.',
      en: 'Faster throughput on NVIDIA GPU, requires CUDA.',
    },
    modelPath: 'pnnbao-ump/VieNeu-TTS-0.3B',
    sttModel: 'small',
    sttDevice: 'cuda',
    sttComputeType: 'float16',
  },
  {
    id: 'gpu_quality',
    label: { vi: 'GPU chất lượng cao (0.5B)', en: 'GPU high quality (0.5B)' },
    hint: {
      vi: 'Giọng đẹp hơn, đổi lại latency cao hơn nhẹ so với 0.3B.',
      en: 'Higher quality voice with slightly higher latency than 0.3B.',
    },
    modelPath: 'pnnbao-ump/VieNeu-TTS',
    sttModel: 'small',
    sttDevice: 'cuda',
    sttComputeType: 'float16',
  },
]

function getMicNoiseFilterLabel(strength: number, uiLanguage: UiLanguage): string {
  const level = getMicNoiseFilterLevelFromStrength(strength)
  if (level === 'off') {
    return uiLanguage === 'vi' ? 'Tắt lọc ồn' : 'Noise filter off'
  }
  if (level === 'strong') {
    return uiLanguage === 'vi' ? 'Lọc ồn mạnh' : 'Strong noise filter'
  }
  return uiLanguage === 'vi' ? 'Cân bằng' : 'Balanced'
}

function loadSavedEnv(): EnvField[] {
  try {
    const raw = localStorage.getItem(ADMIN_ENV_STORAGE_KEY)
    if (!raw) {
      return ENV_TEMPLATE
    }
    const saved = JSON.parse(raw) as Record<string, string>
    return ENV_TEMPLATE.map((field) => ({
      ...field,
      value: normalizeEnvValue(field.key, saved[field.key] ?? field.value),
    }))
  } catch {
    return ENV_TEMPLATE
  }
}

function getFieldValue(fields: EnvField[], key: string, fallback: string): string {
  return fields.find((field) => field.key === key)?.value ?? fallback
}

function getSavedEnvFieldValue(key: string, fallback: string): string {
  return getFieldValue(loadSavedEnv(), key, fallback)
}

function toEnvPayload(fields: EnvField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.key, normalizeEnvValue(field.key, field.value)]),
  )
}

function normalizeApiBaseUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

function getAiApiCandidates(preferredUrl: string): string[] {
  const normalizedPreferred = normalizeApiBaseUrl(preferredUrl)
  if (normalizedPreferred.length > 0) {
    return [normalizedPreferred]
  }
  return ['http://127.0.0.1:8012']
}

function formatSyncTime(updatedAt: number | null, uiLanguage: UiLanguage): string {
  if (!updatedAt) {
    return uiLanguage === 'vi' ? 'Chưa đồng bộ lần nào' : 'No sync yet'
  }
  return new Date(updatedAt).toLocaleString(uiLanguage === 'vi' ? 'vi-VN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
  })
}

function loadAdminUiLanguage(): UiLanguage {
  const saved = localStorage.getItem(ADMIN_UI_LANGUAGE_KEY)
  return saved === 'en' ? 'en' : 'vi'
}

function toSafeTtsRate(rawValue: string): number | null {
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isFinite(parsed)) {
    return null
  }
  if (parsed < 100 || parsed > 300) {
    return null
  }
  return parsed
}

function toSafeVieneuTemperature(rawValue: string): number | null {
  const parsed = Number.parseFloat(rawValue.trim())
  if (!Number.isFinite(parsed)) {
    return null
  }
  if (parsed < 0.1 || parsed > 2.0) {
    return null
  }
  return Number(parsed.toFixed(2))
}

function toSafeVieneuTopK(rawValue: string): number | null {
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isFinite(parsed)) {
    return null
  }
  if (parsed < 1 || parsed > 200) {
    return null
  }
  return parsed
}

function toSafeVieneuMaxChars(rawValue: string): number | null {
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isFinite(parsed)) {
    return null
  }
  if (parsed < 32 || parsed > 512) {
    return null
  }
  return parsed
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export default function AdminPage() {
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() => loadAdminUiLanguage())
  const [activeTab, setActiveTab] = useState<AdminTab>('overview')
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false)
  const [showAdvancedVoiceTools, setShowAdvancedVoiceTools] = useState(false)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(() => getAdminConfigUpdatedAt())
  const [micState, setMicState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [micDetail, setMicDetail] = useState(() =>
    loadAdminUiLanguage() === 'vi' ? 'Chưa kiểm tra microphone' : 'Microphone has not been checked',
  )
  const [sttPartialText, setSttPartialText] = useState('')
  const [sttFinalText, setSttFinalText] = useState('')
  const [speechNotices, setSpeechNotices] = useState<Array<{ text: string; level: 'warning' | 'info' }>>([])
  const [envFields, setEnvFields] = useState<EnvField[]>(() => loadSavedEnv())
  const [ttsEngine, setTtsEngine] = useState(() =>
    getSavedEnvFieldValue('TTS_ENGINE', 'vieneu'),
  )
  const [ttsVoice, setTtsVoice] = useState(() =>
    getSavedEnvFieldValue('TTS_VOICE', 'vi-VN-HoaiMyNeural'),
  )
  const [ttsRate, setTtsRate] = useState(() => getSavedEnvFieldValue('TTS_RATE', '165'))
  const [vieneuModelPath, setVieneuModelPath] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_MODEL_PATH', 'pnnbao-ump/VieNeu-TTS-0.3B-q4-gguf'),
  )
  const [vieneuVoiceId, setVieneuVoiceId] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_VOICE_ID', ''),
  )
  const [vieneuRefAudio, setVieneuRefAudio] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_REF_AUDIO', ''),
  )
  const [vieneuRefText, setVieneuRefText] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_REF_TEXT', ''),
  )
  const [vieneuTemperature, setVieneuTemperature] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_TEMPERATURE', '1.0'),
  )
  const [vieneuTopK, setVieneuTopK] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_TOP_K', '50'),
  )
  const [vieneuMaxChars, setVieneuMaxChars] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_MAX_CHARS', '256'),
  )
  const [vieneuRealtimeProfile, setVieneuRealtimeProfile] = useState(() =>
    getSavedEnvFieldValue('VIENEU_REALTIME_PROFILE', 'cpu_realtime'),
  )
  const [vieneuVoices, setVieneuVoices] = useState<Array<{ id: string; description: string }>>([])
  const [vieneuVoicesState, setVieneuVoicesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [vieneuInstallState, setVieneuInstallState] = useState<'idle' | 'installing' | 'success' | 'error'>('idle')
  const [resolvedVieneuApiBase, setResolvedVieneuApiBase] = useState('')
  const [micNoiseFilterStrength, setMicNoiseFilterStrength] = useState<number>(() =>
    getMicNoiseFilterStrength(),
  )
  const [robotScalePercent, setRobotScalePercent] = useState<number>(() => getRobotScalePercent())
  const [cameraPreviewVisible, setCameraPreviewVisible] = useState<boolean>(() =>
    getCameraPreviewVisible(),
  )
  const [noiseMonitorActive, setNoiseMonitorActive] = useState(false)
  const [noiseLevelDb, setNoiseLevelDb] = useState(-90)
  const [noiseLevelPercent, setNoiseLevelPercent] = useState(0)
  const noiseMonitorRef = useRef<{
    stream: MediaStream
    audioContext: AudioContext
    analyser: AnalyserNode
    intervalId: number
  } | null>(null)
  const [ttsTestText, setTtsTestText] = useState(() =>
    loadAdminUiLanguage() === 'vi'
      ? 'Xin chào! Mình là robot đặt món. Bạn muốn gọi gì hôm nay?'
      : 'Hello! I am your ordering robot. What would you like today?',
  )
  const [ttsTestStatus, setTtsTestStatus] = useState<'idle' | 'playing' | 'error'>('idle')
  const [ttsApplyStatus, setTtsApplyStatus] = useState<TtsApplyStatus>('idle')
  const speechLang = uiLanguage === 'vi' ? 'vi-VN' : 'en-US'
  const t = useCallback(
    (vi: string, en: string) => (uiLanguage === 'vi' ? vi : en),
    [uiLanguage],
  )
  const liveCaption = useLiveCaption({ lang: speechLang })

  const envFieldMap = useMemo(
    () => Object.fromEntries(envFields.map((field) => [field.key, normalizeEnvValue(field.key, field.value)])),
    [envFields],
  )

  const currentCoreApiUrl = envFieldMap.VITE_CORE_API_URL || getCoreApiUrl()
  const currentAiApiUrl = envFieldMap.VITE_AI_API_URL || getAiApiUrl()
  const currentMenuApiUrl = envFieldMap.VITE_MENU_API_URL || getMenuApiUrl()
  const currentOrdersApiUrl = envFieldMap.VITE_ORDERS_API_URL || getOrdersApiUrl()

  const serviceTargets = useMemo(
    () => [
      { name: 'Core Backend', url: `${currentCoreApiUrl}/health` },
      { name: 'AI Backend', url: `${currentAiApiUrl}/health` },
      { name: 'Menu API', url: currentMenuApiUrl },
      { name: 'Orders API', url: `${currentOrdersApiUrl}?limit=1` },
    ],
    [currentAiApiUrl, currentCoreApiUrl, currentMenuApiUrl, currentOrdersApiUrl],
  )

  const [services, setServices] = useState<ServiceStatus[]>(
    serviceTargets.map((target) => ({
      name: target.name,
      url: target.url,
      status: 'idle',
      latencyMs: null,
      detail: uiLanguage === 'vi' ? 'Chưa kiểm tra' : 'Not checked yet',
    })),
  )

  const { listening, interimTranscript, recognitionSupported, startListening, stopListening } = useSpeech({
    lang: speechLang,
    onTranscript: (transcript) => {
      setSttFinalText(transcript)
      setMicState('ok')
      setMicDetail('STT đã nhận transcript')
    },
    onNotice: (message, level = 'warning') => {
      setSpeechNotices((current) => {
        if (current.some((item) => item.text === message)) {
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

  const essentialFields = useMemo(
    () => envFields.filter((field) => ESSENTIAL_ENV_KEYS.has(field.key)),
    [envFields],
  )
  const advancedFields = useMemo(
    () => envFields.filter((field) => !ESSENTIAL_ENV_KEYS.has(field.key)),
    [envFields],
  )

  const envText = useMemo(
    () => envFields.map((field) => `${field.key}=${normalizeEnvValue(field.key, field.value)}`).join('\n'),
    [envFields],
  )
  const essentialEnvText = useMemo(
    () =>
      essentialFields
        .map((field) => `${field.key}=${normalizeEnvValue(field.key, field.value)}`)
        .join('\n'),
    [essentialFields],
  )

  const healthyServiceCount = useMemo(
    () => services.filter((service) => service.status === 'ok').length,
    [services],
  )
  const normalizedVieneuVoiceId = vieneuVoiceId.trim()
  const hasCustomVieneuVoiceId =
    normalizedVieneuVoiceId.length > 0 &&
    !vieneuVoices.some((voice) => voice.id === normalizedVieneuVoiceId)

  const isHealthChecking = services.some((service) => service.status === 'checking')

  useEffect(() => {
    localStorage.setItem(ADMIN_UI_LANGUAGE_KEY, uiLanguage)
  }, [uiLanguage])

  useEffect(() => {
    setSttPartialText(interimTranscript)
    if (interimTranscript.trim()) {
      setMicState('ok')
      setMicDetail('Đang nhận partial transcript...')
    }
  }, [interimTranscript])

  useEffect(() => {
    setEnvFields((current) => {
      const normalized = current.map((field) => {
        const value = normalizeEnvValue(field.key, field.value)
        return value === field.value ? field : { ...field, value }
      })
      const changed = normalized.some((field, index) => field.value !== current[index]?.value)
      return changed ? normalized : current
    })
  }, [])

  useEffect(() => {
    setServices((current) =>
      serviceTargets.map((target) => {
        const existing = current.find((item) => item.name === target.name)
        if (!existing) {
          return {
            name: target.name,
            url: target.url,
            status: 'idle',
            latencyMs: null,
            detail: uiLanguage === 'vi' ? 'Chưa kiểm tra' : 'Not checked yet',
          }
        }
        if (existing.url === target.url) {
          return existing
        }
        return {
          ...existing,
          url: target.url,
          status: 'idle',
          latencyMs: null,
          detail:
            uiLanguage === 'vi'
              ? 'URL đã thay đổi, cần kiểm tra lại'
              : 'URL changed, please re-run check',
        }
      }),
    )
  }, [serviceTargets, uiLanguage])

  const setFieldValue = useCallback((key: string, value: string) => {
    setEnvFields((current) =>
      current.map((field) => (field.key === key ? { ...field, value } : field)),
    )
  }, [])

  const applyVieneuRealtimeProfile = useCallback(
    (profileId: string) => {
      const profile = VIENEU_REALTIME_PROFILES.find((item) => item.id === profileId)
      if (!profile) {
        return
      }
      setTtsEngine('vieneu')
      setVieneuRealtimeProfile(profile.id)
      setVieneuModelPath(profile.modelPath)
      setFieldValue('TTS_ENGINE', 'vieneu')
      setFieldValue('VIENEU_REALTIME_PROFILE', profile.id)
      setFieldValue('TTS_VIENEU_MODEL_PATH', profile.modelPath)
      setFieldValue('STT_MODEL', profile.sttModel)
      setFieldValue('STT_DEVICE', profile.sttDevice)
      setFieldValue('STT_COMPUTE_TYPE', profile.sttComputeType)
      setNotice({
        tone: 'info',
        text: t(
          `Đã áp preset ${profile.label.vi}. Nhớ bấm "Áp dụng vào backend".`,
          `Preset ${profile.label.en} applied. Click "Apply To Backend" to activate.`,
        ),
      })
    },
    [setFieldValue, t],
  )

  const checkService = useCallback(async (service: ServiceStatus): Promise<ServiceStatus> => {
    const startedAt = performance.now()
    try {
      const response = await fetch(service.url, { method: 'GET' })
      const latencyMs = Math.round(performance.now() - startedAt)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return {
        ...service,
        status: 'ok',
        latencyMs,
        detail: uiLanguage === 'vi' ? 'Online' : 'Online',
      }
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt)
      return {
        ...service,
        status: 'error',
        latencyMs,
        detail: error instanceof Error ? error.message : uiLanguage === 'vi' ? 'Lỗi không rõ' : 'Unknown error',
      }
    }
  }, [uiLanguage])

  const runHealthChecks = useCallback(async () => {
    const checkingList = services.map((service) => ({
      ...service,
      status: 'checking' as const,
      detail: uiLanguage === 'vi' ? 'Đang kiểm tra...' : 'Checking...',
    }))
    setServices(checkingList)
    const checked = await Promise.all(checkingList.map((service) => checkService(service)))
    setServices(checked)
  }, [checkService, services, uiLanguage])

  const saveAndSyncConfig = useCallback(
    (fields: EnvField[], successText: string) => {
      saveAdminEnvConfig(toEnvPayload(fields))
      setLastSyncAt(getAdminConfigUpdatedAt())
      setNotice({
        tone: 'success',
        text: successText,
      })
    },
    [],
  )

  const handleSaveConfig = useCallback(() => {
    saveAndSyncConfig(
      envFields,
      t(
        'Đã lưu cấu hình. Trang kiosk index sẽ nhận ngay.',
        'Configuration saved. Kiosk index will receive updates immediately.',
      ),
    )
  }, [envFields, saveAndSyncConfig, t])

  const handleCopyEnv = useCallback(async () => {
    const textToCopy = showAdvancedConfig ? envText : essentialEnvText
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      setNotice({
        tone: 'info',
        text: showAdvancedConfig ? t('Đã copy full .env', 'Full .env copied') : t('Đã copy .env với nhóm cấu hình thiết yếu', 'Essential .env block copied'),
      })
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Không thể copy .env', 'Cannot copy .env'),
      })
    }
  }, [envText, essentialEnvText, showAdvancedConfig, t])

  const loadVieneuVoices = useCallback(
    async (showSuccessNotice = true) => {
      if (ttsEngine !== 'vieneu') {
        setVieneuVoices([])
        setVieneuVoicesState('idle')
        return
      }

      setVieneuVoicesState('loading')
      try {
        const [apiBase] = getAiApiCandidates(currentAiApiUrl)
        const nextResponse = await fetch(`${apiBase}/speech/vieneu/voices`, {
          method: 'GET',
        })

        if (nextResponse.status === 404) {
          throw new Error(
            t(
              `Backend reachable but voices endpoint missing: ${apiBase}/speech/vieneu/voices`,
              `Backend reachable but voices endpoint missing: ${apiBase}/speech/vieneu/voices`,
            ),
          )
        }

        if (!nextResponse.ok) {
          throw new Error(
            t(
              `Backend reachable but voices endpoint error (${nextResponse.status}) tại ${apiBase}/speech/vieneu/voices`,
              `Backend reachable but voices endpoint error (${nextResponse.status}) at ${apiBase}/speech/vieneu/voices`,
            ),
          )
        }

        const payload = (await nextResponse.json()) as {
          vieneu_installed?: boolean
          voices?: Array<{ id?: string; description?: string }>
        }
        const selectedVoices = Array.isArray(payload.voices)
          ? payload.voices
              .map((item) => ({
                id: String(item.id || '').trim(),
                description: String(item.description || '').trim(),
              }))
              .filter((item) => item.id.length > 0)
          : []

        setVieneuVoices(selectedVoices)
        setResolvedVieneuApiBase(apiBase)
        setVieneuVoicesState('ready')
        if (showSuccessNotice) {
          if (payload.vieneu_installed === false) {
            setNotice({
              tone: 'warning',
              text: t(
                'Backend chưa cài vieneu. Cài package vieneu trước khi dùng preset voice.',
                'The backend does not have vieneu installed yet. Install vieneu before using preset voices.',
              ),
            })
            return
          }
          if (selectedVoices.length === 0) {
            setNotice({
              tone: 'warning',
              text: t(
                'Đã kết nối VieNeu nhưng endpoint này chưa trả preset voice. Thử đổi model/preset trong backend rồi tải lại.',
                'Connected to VieNeu but this endpoint returned no preset voices. Try switching model/runtime and reload voices.',
              ),
            })
            return
          }
          setNotice({
            tone: 'info',
            text: t(
              `Voices loaded from ${apiBase}: ${selectedVoices.length} giong VieNeu.`,
              `Voices loaded from ${apiBase}: ${selectedVoices.length} VieNeu presets.`,
            ),
          })
        }
      } catch (error) {
        setVieneuVoicesState('error')
        const errorText = error instanceof Error ? error.message : ''
        const normalizedError = errorText.toLowerCase()
        const isNetworkError =
          normalizedError.includes('failed to fetch') ||
          normalizedError.includes('networkerror') ||
          normalizedError.includes('err_connection_refused')
        if (showSuccessNotice) {
          setNotice({
            tone: 'warning',
            text: isNetworkError
              ? t(
                  `Backend URL not reachable: ${currentAiApiUrl}`,
                  `Backend URL not reachable: ${currentAiApiUrl}`,
                )
              : (error instanceof Error
                  ? error.message
                  : t('Không thể tải danh sách voice VieNeu.', 'Cannot load VieNeu voice list.')),
          })
        }
      }
    },
    [currentAiApiUrl, t, ttsEngine],
  )

  const installVieneuRuntime = useCallback(async () => {
    if (ttsEngine !== 'vieneu') {
      return
    }

    setVieneuInstallState('installing')
    try {
      const [apiBase] = getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
      const response = await fetch(`${apiBase}/speech/vieneu/install`, {
        method: 'POST',
      })

      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          const payload = (await response.json()) as { detail?: string }
          if (payload?.detail) {
            detail = payload.detail
          }
        } catch {}
        throw new Error(detail)
      }

      const payload = (await response.json()) as {
        vieneu_installed?: boolean
        already_installed?: boolean
      }
      setResolvedVieneuApiBase(apiBase)

      if (payload.vieneu_installed !== true) {
        setVieneuInstallState('error')
        setNotice({
          tone: 'warning',
          text: t(
            'Đã gọi cài VieNeu nhưng backend chưa nhận module. Thử restart AI backend.',
            'VieNeu install command finished but backend still cannot load module. Restart AI backend.',
          ),
        })
        return
      }

      setVieneuInstallState('success')
      setNotice({
        tone: 'success',
        text: payload.already_installed
          ? t('VieNeu đã được cài sẵn trên backend.', 'VieNeu is already installed on backend.')
          : t('Cài VieNeu thành công. Đang tải lại danh sách voice...', 'VieNeu installed successfully. Reloading voices...'),
      })
      await loadVieneuVoices(false)
    } catch (error) {
      setVieneuInstallState('error')
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Không thể cài VieNeu.', 'Cannot install VieNeu.'),
      })
    } finally {
      window.setTimeout(() => {
        setVieneuInstallState('idle')
      }, 1800)
    }
  }, [currentAiApiUrl, loadVieneuVoices, resolvedVieneuApiBase, t, ttsEngine])

  useEffect(() => {
    if (activeTab !== 'voice' || ttsEngine !== 'vieneu') {
      return
    }
    void loadVieneuVoices(false)
  }, [activeTab, loadVieneuVoices, ttsEngine])

  const stopBrowserStt = useCallback(() => {
    if (!listening) {
      return
    }
    stopListening()
    setMicState('ok')
    setMicDetail(t('Đã dừng STT và chờ transcript cuối', 'STT stopped, waiting for final transcript'))
  }, [listening, stopListening, t])

  const runQuickMicTest = useCallback(async () => {
    if (listening) {
      stopBrowserStt()
      return
    }

    setSpeechNotices([])
    setSttPartialText('')
    setSttFinalText('')
    setMicState('checking')
    setMicDetail(t('Đang xin quyền microphone và khởi động STT...', 'Requesting microphone permission and starting STT...'))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicAudioConstraints(micNoiseFilterStrength),
      })
      const tracks = stream.getAudioTracks()
      const trackLabel = tracks[0]?.label || t('Microphone sẵn sàng', 'Microphone ready')
      tracks.forEach((track) => track.stop())

      if (!recognitionSupported) {
        setMicState('ok')
        setMicDetail(
          `${trackLabel}. ${t('Trình duyệt không hỗ trợ STT kiosk flow.', 'This browser does not support the kiosk STT flow.')}`,
        )
        return
      }

      await startListening()
      setMicState('ok')
      setMicDetail(`Mic ok (${trackLabel}). ${t('Đang nghe...', 'Listening...')}`)
    } catch (error) {
      setMicState('error')
      setMicDetail(error instanceof Error ? error.message : t('Không thể kiểm tra microphone', 'Cannot test microphone'))
    }
  }, [listening, micNoiseFilterStrength, recognitionSupported, startListening, stopBrowserStt, t])

  const handleMicNoiseFilterStrengthChange = useCallback((nextStrength: number) => {
    const safeStrength = Math.max(0, Math.min(100, Math.round(nextStrength)))
    setMicNoiseFilterStrength(safeStrength)
    persistMicNoiseFilterStrength(safeStrength)
  }, [])

  const handleRobotScaleChange = useCallback((nextValue: number) => {
    const safeValue = Math.max(60, Math.min(170, Math.round(nextValue)))
    setRobotScalePercent(safeValue)
    persistRobotScalePercent(safeValue)
    setNotice({
      tone: 'info',
      text: t(`Đã cập nhật độ to robot: ${safeValue}%`, `Robot scale updated: ${safeValue}%`),
    })
  }, [t])

  const handleCameraPreviewVisibleChange = useCallback((visible: boolean) => {
    setCameraPreviewVisible(visible)
    persistCameraPreviewVisible(visible)
    setNotice({
      tone: 'info',
      text: visible
        ? t('Đã bật khung camera trên kiosk.', 'Camera preview enabled on kiosk.')
        : t('Đã ẩn khung camera trên kiosk.', 'Camera preview hidden on kiosk.'),
    })
  }, [t])

  const stopNoiseMonitor = useCallback(() => {
    const current = noiseMonitorRef.current
    if (!current) {
      setNoiseMonitorActive(false)
      return
    }

    window.clearInterval(current.intervalId)
    current.stream.getTracks().forEach((track) => track.stop())
    void current.audioContext.close()
    noiseMonitorRef.current = null
    setNoiseMonitorActive(false)
  }, [])

  const startNoiseMonitor = useCallback(async () => {
    if (noiseMonitorRef.current) {
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicAudioConstraints(micNoiseFilterStrength),
      })
      const audioContext = new AudioContext()
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.35
      source.connect(analyser)
      // Keep node graph active without audible output.
      const silentGain = audioContext.createGain()
      silentGain.gain.value = 0
      analyser.connect(silentGain)
      silentGain.connect(audioContext.destination)

      const floatData = new Float32Array(analyser.fftSize)
      const intervalId = window.setInterval(() => {
        analyser.getFloatTimeDomainData(floatData)
        let sumSquares = 0
        let peak = 0
        for (let index = 0; index < floatData.length; index += 1) {
          const sample = floatData[index]
          const absSample = Math.abs(sample)
          if (absSample > peak) {
            peak = absSample
          }
          sumSquares += sample * sample
        }
        const rms = Math.sqrt(sumSquares / floatData.length)
        const effectiveSignal = Math.max(rms, peak * 0.5, 1e-6)
        const db = 20 * Math.log10(effectiveSignal)
        const clampedDb = Math.max(-70, Math.min(0, db))
        const normalizedPercent = Math.max(0, Math.min(100, ((clampedDb + 70) / 70) * 100))
        setNoiseLevelDb(Number(clampedDb.toFixed(1)))
        setNoiseLevelPercent((current) => Math.round(current * 0.65 + normalizedPercent * 0.35))
      }, 120)

      noiseMonitorRef.current = {
        stream,
        audioContext,
        analyser,
        intervalId,
      }
      setNoiseMonitorActive(true)
      setNotice({
        tone: 'info',
        text: t('Đang đo độ ồn trực tiếp từ microphone.', 'Live microphone noise monitoring is running.'),
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : t('Không thể bật đo ồn microphone.', 'Cannot start microphone noise monitor.'),
      })
      stopNoiseMonitor()
    }
  }, [micNoiseFilterStrength, stopNoiseMonitor, t])

  useEffect(() => {
    return () => {
      stopNoiseMonitor()
    }
  }, [stopNoiseMonitor])

  const testTtsVoice = useCallback(async () => {
    const normalizedRate = toSafeTtsRate(ttsRate)
    if (ttsEngine !== 'vieneu' && normalizedRate === null) {
      setTtsTestStatus('error')
      setNotice({
        tone: 'warning',
        text: t('TTS Rate phải là số trong khoảng 100-300.', 'TTS rate must be a number between 100 and 300.'),
      })
      window.setTimeout(() => setTtsTestStatus('idle'), 2000)
      return
    }

    const normalizedVieneuTemperature = toSafeVieneuTemperature(vieneuTemperature)
    const normalizedVieneuTopK = toSafeVieneuTopK(vieneuTopK)
    const normalizedVieneuMaxChars = toSafeVieneuMaxChars(vieneuMaxChars)
    if (
      ttsEngine === 'vieneu' &&
      (normalizedVieneuTemperature === null ||
        normalizedVieneuTopK === null ||
        normalizedVieneuMaxChars === null)
    ) {
      setTtsTestStatus('error')
      setNotice({
        tone: 'warning',
        text: t(
          'Cấu hình VieNeu chưa hợp lệ. Temperature 0.1-2.0, Top-K 1-200, Max chars 32-512.',
          'Invalid VieNeu config. Temperature 0.1-2.0, Top-K 1-200, Max chars 32-512.',
        ),
      })
      window.setTimeout(() => setTtsTestStatus('idle'), 2200)
      return
    }

    setTtsTestStatus('playing')
    try {
      const testApiBase =
        ttsEngine === 'vieneu'
          ? normalizeApiBaseUrl(resolvedVieneuApiBase || currentAiApiUrl)
          : normalizeApiBaseUrl(currentAiApiUrl)
      const body: Record<string, unknown> = {
        text: ttsTestText,
        voice: ttsVoice,
        rate: normalizedRate ?? 165,
        engine: ttsEngine,
      }
      if (ttsEngine === 'vieneu') {
        const cloneRefAudio = toSingleLine(vieneuRefAudio)
        const cloneRefText = toSingleLine(vieneuRefText)
        const useCloneVoice = cloneRefAudio.length > 0 && cloneRefText.length > 0
        body.vieneu_voice_id = useCloneVoice ? '' : toSingleLine(vieneuVoiceId)
        body.vieneu_ref_audio = cloneRefAudio
        body.vieneu_ref_text = cloneRefText
        body.vieneu_temperature = normalizedVieneuTemperature
        body.vieneu_top_k = normalizedVieneuTopK
        body.vieneu_max_chars = normalizedVieneuMaxChars
      }

      const response = await fetch(`${testApiBase}/speech/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          const payload = (await response.json()) as { detail?: string }
          detail = payload.detail ?? detail
        } catch {
          // ignore json parse error
        }
        throw new Error(detail)
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
    } catch {
      setTtsTestStatus('error')
      window.setTimeout(() => setTtsTestStatus('idle'), 2000)
    }
  }, [
    currentAiApiUrl,
    resolvedVieneuApiBase,
    t,
    ttsEngine,
    ttsRate,
    ttsTestText,
    ttsVoice,
    vieneuMaxChars,
    vieneuRefAudio,
    vieneuRefText,
    vieneuTemperature,
    vieneuTopK,
    vieneuVoiceId,
  ])

  const secondaryLanguage: UiLanguage = uiLanguage === 'vi' ? 'en' : 'vi'
  const activeTabMeta = TAB_ITEMS.find((tab) => tab.id === activeTab)
  const menuGroups = useMemo(
    () =>
      MENU_GROUPS.map((group) => ({
        ...group,
        tabs: TAB_ITEMS.filter((tab) => tab.group === group.id),
      })).filter((group) => group.tabs.length > 0),
    [],
  )

  const applyTtsConfig = useCallback(async () => {
    const normalizedRate = toSafeTtsRate(ttsRate)
    if (ttsEngine !== 'vieneu' && normalizedRate === null) {
      setTtsApplyStatus('error')
      setNotice({
        tone: 'warning',
        text: t(
          'Không thể áp dụng TTS: Rate phải nằm trong khoảng 100-300.',
          'Cannot apply TTS: rate must be between 100 and 300.',
        ),
      })
      window.setTimeout(() => setTtsApplyStatus('idle'), 2000)
      return
    }

    const normalizedVieneuTemperature = toSafeVieneuTemperature(vieneuTemperature)
    const normalizedVieneuTopK = toSafeVieneuTopK(vieneuTopK)
    const normalizedVieneuMaxChars = toSafeVieneuMaxChars(vieneuMaxChars)
    if (
      ttsEngine === 'vieneu' &&
      (normalizedVieneuTemperature === null ||
        normalizedVieneuTopK === null ||
        normalizedVieneuMaxChars === null)
    ) {
      setTtsApplyStatus('error')
      setNotice({
        tone: 'warning',
        text: t(
          'Không thể áp dụng VieNeu: Temperature 0.1-2.0, Top-K 1-200, Max chars 32-512.',
          'Cannot apply VieNeu: Temperature 0.1-2.0, Top-K 1-200, Max chars 32-512.',
        ),
      })
      window.setTimeout(() => setTtsApplyStatus('idle'), 2200)
      return
    }

    setTtsApplyStatus('saving')
    try {
      const cloneRefAudioValue = toSingleLine(vieneuRefAudio)
      const cloneRefTextValue = toSingleLine(vieneuRefText)
      const useCloneVoiceMode =
        ttsEngine === 'vieneu' && cloneRefAudioValue.length > 0 && cloneRefTextValue.length > 0
      const effectiveVieneuVoiceId = useCloneVoiceMode ? '' : toSingleLine(vieneuVoiceId)
      const requestPayload: Record<string, unknown> = {
        engine: ttsEngine,
        tts_engine: ttsEngine,
        voice: ttsVoice,
        rate: normalizedRate ?? 165,
        tts_voice: ttsVoice,
        tts_rate: normalizedRate ?? 165,
      }
      if (ttsEngine === 'vieneu') {
        requestPayload.vieneu_model_path = toSingleLine(vieneuModelPath)
        requestPayload.tts_vieneu_model_path = toSingleLine(vieneuModelPath)
        requestPayload.vieneu_voice_id = effectiveVieneuVoiceId
        requestPayload.tts_vieneu_voice_id = effectiveVieneuVoiceId
        requestPayload.vieneu_ref_audio = cloneRefAudioValue
        requestPayload.tts_vieneu_ref_audio = cloneRefAudioValue
        requestPayload.vieneu_ref_text = cloneRefTextValue
        requestPayload.tts_vieneu_ref_text = cloneRefTextValue
        requestPayload.vieneu_temperature = normalizedVieneuTemperature
        requestPayload.tts_vieneu_temperature = normalizedVieneuTemperature
        requestPayload.vieneu_top_k = normalizedVieneuTopK
        requestPayload.tts_vieneu_top_k = normalizedVieneuTopK
        requestPayload.vieneu_max_chars = normalizedVieneuMaxChars
        requestPayload.tts_vieneu_max_chars = normalizedVieneuMaxChars
      }

      const targets =
        ttsEngine === 'vieneu'
          ? getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
          : [normalizeApiBaseUrl(currentAiApiUrl)]

      let successCount = 0
      let lastError: Error | null = null
      for (const apiBase of targets) {
        try {
          const response = await fetch(`${apiBase}/config/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload),
          })
          if (!response.ok) {
            let detail = `HTTP ${response.status}`
            try {
              const payload = (await response.json()) as { detail?: string }
              detail = payload.detail ?? detail
            } catch {
              // ignore json parse error
            }
            throw new Error(`${apiBase}: ${detail}`)
          }
          successCount += 1
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (successCount === 0) {
        throw (lastError || new Error('Không áp dụng được TTS cho backend nào.'))
      }

      const nextValues: Record<string, string> = {
        TTS_ENGINE: ttsEngine,
        TTS_VOICE: ttsVoice,
        TTS_RATE: String(normalizedRate ?? 165),
        TTS_VIENEU_MODEL_PATH: toSingleLine(vieneuModelPath),
        VIENEU_REALTIME_PROFILE: vieneuRealtimeProfile,
        TTS_VIENEU_VOICE_ID: effectiveVieneuVoiceId,
        TTS_VIENEU_REF_AUDIO: cloneRefAudioValue,
        TTS_VIENEU_REF_TEXT: cloneRefTextValue,
        TTS_VIENEU_TEMPERATURE: String(normalizedVieneuTemperature ?? 1.0),
        TTS_VIENEU_TOP_K: String(normalizedVieneuTopK ?? 50),
        TTS_VIENEU_MAX_CHARS: String(normalizedVieneuMaxChars ?? 256),
      }
      const nextFields = envFields.map((field) =>
        field.key in nextValues ? { ...field, value: nextValues[field.key] } : field,
      )
      setEnvFields(nextFields)
      saveAndSyncConfig(
        nextFields,
        t(
          `Đã áp dụng TTS vào ${successCount} backend và đồng bộ vào kiosk.`,
          `TTS applied to ${successCount} backend endpoints and synced to kiosk.`,
        ),
      )
      if (ttsEngine === 'vieneu') {
        void loadVieneuVoices(false)
      }
      setTtsApplyStatus('success')
    } catch (error) {
      setTtsApplyStatus('error')
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Không thể áp dụng TTS config', 'Cannot apply TTS config'),
      })
    } finally {
      window.setTimeout(() => setTtsApplyStatus('idle'), 2000)
    }
  }, [
    currentAiApiUrl,
    envFields,
    saveAndSyncConfig,
    resolvedVieneuApiBase,
    t,
    loadVieneuVoices,
    ttsEngine,
    ttsRate,
    ttsVoice,
    vieneuMaxChars,
    vieneuRealtimeProfile,
    vieneuModelPath,
    vieneuRefAudio,
    vieneuRefText,
    vieneuTemperature,
    vieneuTopK,
    vieneuVoiceId,
  ])

  return (
    <main className="admin-page">
      <div className="admin-page__backdrop admin-page__backdrop--one" />
      <div className="admin-page__backdrop admin-page__backdrop--two" />
      <div className="admin-shell">
        <aside className="admin-sidebar" aria-label={t('Menu quản trị bên trái', 'Left admin menu')}>
          <div className="admin-sidebar__brand">
            <p className="admin-kicker">Order Robot / Admin</p>
            <h1>{t('Trung tâm quản trị', 'Admin Control Center')}</h1>
            <p>
              {t(
                'Bố cục sáng, rõ từng nhóm chức năng để vận hành nhanh và ít nhầm thao tác.',
                'Bright and structured layout for faster and safer operations.',
              )}
            </p>
          </div>

          <div className="admin-sidebar__controls">
            <button
              className="admin-link"
              type="button"
              onClick={() => setUiLanguage((current) => (current === 'vi' ? 'en' : 'vi'))}
            >
              {uiLanguage === 'vi' ? 'English / Tiếng Việt' : 'Tiếng Việt / English'}
            </button>
            <a className="admin-link" href="/debug">
              {t('Debug Bridge', 'Bridge Debug')}
            </a>
            <a className="admin-link admin-link--primary" href="/">
              {t('Về Kiosk', 'Back To Kiosk')}
            </a>
          </div>

          <nav className="admin-sidebar__nav" aria-label={t('Điều hướng theo nhóm', 'Grouped navigation')}>
            {menuGroups.map((group) => (
              <section key={group.id} className="admin-sidebar__group">
                <p className="admin-sidebar__group-title">{group.label[uiLanguage]}</p>
                <div className="admin-sidebar__group-items">
                  {group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      className={`admin-nav-item ${activeTab === tab.id ? 'admin-nav-item--active' : ''}`}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      aria-pressed={activeTab === tab.id}
                    >
                      <span className="admin-nav-item__badge">{tab.icon}</span>
                      <span className="admin-nav-item__content">
                        <strong>{tab.label[uiLanguage]}</strong>
                        <small>{tab.hint[uiLanguage]}</small>
                        <em>{tab.label[secondaryLanguage]}</em>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </nav>

          <div className="admin-sidebar__status">
            <p>{t('Đồng bộ gần nhất', 'Last synced')}</p>
            <strong>{formatSyncTime(lastSyncAt, uiLanguage)}</strong>
            <span>
              {t(
                'Mọi thay đổi trong cấu hình sẽ đẩy sang kiosk ngay sau khi lưu.',
                'Every saved configuration is synced to kiosk immediately.',
              )}
            </span>
          </div>
        </aside>

        <section className="admin-main">
          <header className="admin-header">
            <div className="admin-header__title">
              <p className="admin-kicker">{t('Bảng điều khiển vận hành', 'Operations Console')}</p>
              <h2>{activeTabMeta ? activeTabMeta.label[uiLanguage] : t('Tổng quan', 'Overview')}</h2>
              <p className="admin-subtitle">
                {activeTabMeta
                  ? activeTabMeta.hint[uiLanguage]
                  : t('Quản lý hệ thống gọi món tại một nơi.', 'Manage ordering system in one place.')}
              </p>
            </div>
            <div className="admin-header__actions">
              <p className="admin-chip admin-chip--ok">
                {t('Dịch vụ online', 'Services online')}: {healthyServiceCount}/{services.length}
              </p>
              <p className="admin-chip admin-chip--ok">
                {t('Mic', 'Mic')}: {micState}
              </p>
              <p className="admin-chip admin-chip--ok">
                Caption: {liveCaption.status}
              </p>
            </div>
          </header>

          {notice ? (
            <section className={`admin-notice admin-notice--${notice.tone}`} role="status">
              {notice.text}
            </section>
          ) : null}

          <section className="admin-metrics-grid">
            <article className="admin-metric-card">
              <p className="admin-metric-card__label">{t('Sức khỏe hệ thống', 'System Health')}</p>
              <p className="admin-metric-card__value">
                {healthyServiceCount}/{services.length}
              </p>
              <p className="admin-metric-card__hint">{t('dịch vụ đang hoạt động', 'services online')}</p>
            </article>
            <article className="admin-metric-card">
              <p className="admin-metric-card__label">{t('Lần đồng bộ', 'Latest Sync')}</p>
              <p className="admin-metric-card__value">{formatSyncTime(lastSyncAt, uiLanguage)}</p>
              <p className="admin-metric-card__hint">{t('thay đổi được đẩy ngay sang kiosk', 'changes are synced instantly')}</p>
            </article>
            <article className="admin-metric-card">
              <p className="admin-metric-card__label">{t('Trạng thái hội thoại', 'Speech Status')}</p>
              <p className="admin-metric-card__value">{listening ? t('Đang nghe', 'Listening') : t('Đang nghỉ', 'Idle')}</p>
              <p className="admin-metric-card__hint">
                Mic: {micState} | Caption: {liveCaption.status}
              </p>
            </article>
          </section>

          {activeTab !== 'robotStudio' ? (
            <section className="admin-panel admin-panel--robot-first">
              <header className="admin-panel__head">
                <div>
                  <h2>{t('Tối ưu robot nhanh', 'Quick Robot Tuning')}</h2>
                  <p>
                    {t(
                      'Điều chỉnh nhanh tỷ lệ robot và khung camera để khớp màn kiosk tại quầy.',
                      'Quickly tune robot scale and camera tile for kiosk display fit.',
                    )}
                  </p>
                </div>
                <p className="admin-chip admin-chip--ok">Scale: {robotScalePercent}%</p>
              </header>
              <div className="admin-fields-grid">
                <label className="admin-field admin-field--full">
                  <span>{t('Độ to robot (60-170%)', 'Robot scale (60-170%)')}</span>
                  <input
                    type="range"
                    min="60"
                    max="170"
                    step="1"
                    value={robotScalePercent}
                    onChange={(event) => handleRobotScaleChange(Number(event.target.value))}
                  />
                </label>
                <label className="admin-field">
                  <span>{t('Khung camera mini (góc phải trên)', 'Mini camera tile (top-right)')}</span>
                  <select
                    value={cameraPreviewVisible ? 'show' : 'hide'}
                    onChange={(event) => handleCameraPreviewVisibleChange(event.target.value === 'show')}
                  >
                    <option value="show">{t('Hiện', 'Show')}</option>
                    <option value="hide">{t('Ẩn', 'Hide')}</option>
                  </select>
                </label>
              </div>
            </section>
          ) : null}

      {activeTab === 'overview' ? (
        <section className="admin-panel">
          <header className="admin-panel__head">
            <div>
              <h2>{t('Sức khỏe backend', 'Backend Health')}</h2>
              <p>{t('Kiểm tra các endpoint quan trọng để biết điểm nào đang chậm hoặc lỗi.', 'Check critical endpoints to see what is slow or failing.')}</p>
            </div>
            <button className="admin-btn" type="button" onClick={() => void runHealthChecks()}>
              {isHealthChecking ? t('Đang kiểm tra...', 'Checking...') : t('Kiểm tra ngay', 'Run Check')}
            </button>
          </header>

          <div className="admin-service-grid">
            {services.map((service) => (
              <article key={service.name} className="admin-service-card">
                <h3>{service.name}</h3>
                <p className="admin-service-card__url">{service.url}</p>
                <p className={`admin-chip admin-chip--${service.status}`}>{service.status}</p>
                <p className="admin-service-card__detail">{service.detail}</p>
                <p className="admin-service-card__latency">
                  {service.latencyMs === null ? '-' : `${service.latencyMs} ms`}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === 'voice' ? (
        <section className="admin-panel admin-panel--stacked">
          <article className="admin-subcard">
            <header className="admin-subcard__head">
              <div>
                <h3>{t('Mic Noise Filter', 'Mic Noise Filter')}</h3>
                <p>{t('Kéo slider để chỉnh mức lọc ồn và xem độ ồn realtime từ mic.', 'Drag slider to tune noise filter and view live mic level.')}</p>
              </div>
              <div className="admin-inline-actions">
                {noiseMonitorActive ? (
                  <button className="admin-btn admin-btn--ghost" type="button" onClick={stopNoiseMonitor}>
                    {t('Dừng đo ồn', 'Stop Meter')}
                  </button>
                ) : (
                  <button className="admin-btn" type="button" onClick={() => void startNoiseMonitor()}>
                    {t('Bật đo ồn trực tiếp', 'Start Live Meter')}
                  </button>
                )}
              </div>
            </header>
            <div className="admin-fields-grid">
              <label className="admin-field">
                <span>
                  {t('Mức lọc ồn', 'Noise filter level')}: {micNoiseFilterStrength}% ({getMicNoiseFilterLabel(micNoiseFilterStrength, uiLanguage)})
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={micNoiseFilterStrength}
                  onChange={(event) => handleMicNoiseFilterStrengthChange(Number(event.target.value))}
                />
              </label>
            </div>
            <p className="admin-service-card__detail">
              {t('Độ ồn hiện tại', 'Current noise')}: <strong>{noiseLevelDb.toFixed(1)} dB</strong>
            </p>
            <div className="admin-noise-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={noiseLevelPercent}>
              <div className="admin-noise-meter__bar" style={{ width: `${noiseLevelPercent}%` }} />
            </div>
          </article>

          <article className="admin-subcard">
            <header className="admin-subcard__head">
              <div>
                <h3>{t('Cài đặt giọng nói', 'Voice Settings')}</h3>
                <p>
                  {t('Chọn voice và tốc độ đọc. Kiểm thử rồi áp dụng ngay tại đây.', 'Select voice and speaking rate. Test and apply right here.')}
                </p>
              </div>
              <div className="admin-inline-actions">
                <button
                  className="admin-btn"
                  type="button"
                  onClick={() => void testTtsVoice()}
                  disabled={ttsTestStatus === 'playing'}
                >
                  {ttsTestStatus === 'playing'
                    ? t('Đang đọc...', 'Speaking...')
                    : ttsTestStatus === 'error'
                      ? t('Đọc thử bị lỗi', 'Preview failed')
                      : t('Đọc thử', 'Preview')}
                </button>
                <button
                  className="admin-btn admin-btn--ghost"
                  type="button"
                  onClick={() => void applyTtsConfig()}
                  disabled={ttsApplyStatus === 'saving'}
                >
                  {ttsApplyStatus === 'saving'
                    ? t('Đang áp dụng...', 'Applying...')
                    : ttsApplyStatus === 'success'
                      ? t('Áp dụng xong', 'Applied')
                      : ttsApplyStatus === 'error'
                        ? t('Áp dụng lỗi', 'Apply failed')
                        : t('Áp dụng vào backend', 'Apply To Backend')}
                </button>
                {ttsEngine === 'vieneu' ? (
                  <button
                    className="admin-btn admin-btn--minimal"
                    type="button"
                    onClick={() => void installVieneuRuntime()}
                    disabled={vieneuInstallState === 'installing'}
                  >
                    {vieneuInstallState === 'installing'
                      ? t('Đang cài VieNeu...', 'Installing VieNeu...')
                      : vieneuInstallState === 'success'
                        ? t('Đã cài VieNeu', 'VieNeu Installed')
                        : vieneuInstallState === 'error'
                          ? t('Cài VieNeu lỗi', 'VieNeu Install Failed')
                          : t('Cài VieNeu', 'Install VieNeu')}
                  </button>
                ) : null}
                {ttsEngine === 'vieneu' ? (
                  <button
                    className="admin-btn admin-btn--minimal"
                    type="button"
                    onClick={() => void loadVieneuVoices()}
                    disabled={vieneuVoicesState === 'loading'}
                  >
                    {vieneuVoicesState === 'loading'
                      ? t('Đang tải voice...', 'Loading voices...')
                      : t('Tải voice VieNeu', 'Load VieNeu Voices')}
                  </button>
                ) : null}
                <button
                  className="admin-btn admin-btn--minimal"
                  type="button"
                  onClick={() => setShowAdvancedVoiceTools((current) => !current)}
                >
                  {showAdvancedVoiceTools ? t('Ẩn test kỹ thuật', 'Hide Advanced Tests') : t('Hiện test kỹ thuật', 'Show Advanced Tests')}
                </button>
              </div>
            </header>
            <div className="admin-fields-grid">
              <label className="admin-field">
                <span>TTS Engine</span>
                <select value={ttsEngine} onChange={(event) => setTtsEngine(event.target.value)}>
                  {TTS_ENGINE_OPTIONS.map((engine) => (
                    <option key={engine.value} value={engine.value}>
                      {engine.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>{t('TTS Voice (fallback)', 'TTS Voice (fallback)')}</span>
                <select value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)}>
                  {TTS_VOICE_OPTIONS.map((voice) => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>{t('TTS Rate 100-300 (fallback)', 'TTS Rate 100-300 (fallback)')}</span>
                <input
                  type="number"
                  min="100"
                  max="300"
                  step="5"
                  value={ttsRate}
                  onChange={(event) => setTtsRate(event.target.value)}
                />
              </label>
              {ttsEngine === 'vieneu' ? (
                <>
                  <label className="admin-field">
                    <span>{t('Preset realtime VieNeu', 'VieNeu realtime preset')}</span>
                    <select
                      value={vieneuRealtimeProfile}
                      onChange={(event) => applyVieneuRealtimeProfile(event.target.value)}
                    >
                      {VIENEU_REALTIME_PROFILES.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label[uiLanguage]}
                        </option>
                      ))}
                      <option value="custom">{t('Tùy chỉnh thủ công', 'Manual custom')}</option>
                    </select>
                  </label>
                  <label className="admin-field">
                    <span>{t('VieNeu Model path/repo (optional)', 'VieNeu model path/repo (optional)')}</span>
                    <input
                      value={vieneuModelPath}
                      onChange={(event) => {
                        setVieneuModelPath(event.target.value)
                        setVieneuRealtimeProfile('custom')
                        setFieldValue('VIENEU_REALTIME_PROFILE', 'custom')
                      }}
                      placeholder={t(
                        'Vi du: pnnbao-ump/VieNeu-TTS-0.3B-q4-gguf',
                        'Example: pnnbao-ump/VieNeu-TTS-0.3B-q4-gguf',
                      )}
                    />
                  </label>
                  <label className="admin-field">
                    <span>{t('VieNeu Preset voice', 'VieNeu Preset voice')}</span>
                    <select value={vieneuVoiceId} onChange={(event) => setVieneuVoiceId(event.target.value)}>
                      <option value="">{t('Mặc định theo model', 'Model default voice')}</option>
                      {hasCustomVieneuVoiceId ? (
                        <option value={normalizedVieneuVoiceId}>
                          {t(`Custom: ${normalizedVieneuVoiceId}`, `Custom: ${normalizedVieneuVoiceId}`)}
                        </option>
                      ) : null}
                      {vieneuVoices.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.description} ({voice.id})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="admin-field">
                    <span>{t('Hoặc nhập voice id thủ công', 'Or enter voice id manually')}</span>
                    <input
                      value={vieneuVoiceId}
                      onChange={(event) => setVieneuVoiceId(event.target.value)}
                      placeholder={t('Ví dụ: Tuyen', 'Example: Tuyen')}
                    />
                  </label>
                  <label className="admin-field">
                    <span>VieNeu Temperature (0.1-2.0)</span>
                    <input
                      type="number"
                      min="0.1"
                      max="2.0"
                      step="0.05"
                      value={vieneuTemperature}
                      onChange={(event) => setVieneuTemperature(event.target.value)}
                    />
                  </label>
                  <label className="admin-field">
                    <span>VieNeu Top-K (1-200)</span>
                    <input
                      type="number"
                      min="1"
                      max="200"
                      step="1"
                      value={vieneuTopK}
                      onChange={(event) => setVieneuTopK(event.target.value)}
                    />
                  </label>
                  <label className="admin-field">
                    <span>VieNeu Max Chars (32-512)</span>
                    <input
                      type="number"
                      min="32"
                      max="512"
                      step="8"
                      value={vieneuMaxChars}
                      onChange={(event) => setVieneuMaxChars(event.target.value)}
                    />
                  </label>
                  <label className="admin-field">
                    <span>{t('Clone voice: wav file path', 'Clone voice: wav file path')}</span>
                    <input
                      value={vieneuRefAudio}
                      onChange={(event) => setVieneuRefAudio(event.target.value)}
                      placeholder={t(
                        'Vi du: C:/CNX/voices/banmau.wav',
                        'Example: C:/CNX/voices/reference.wav',
                      )}
                    />
                  </label>
                  <label className="admin-field admin-field--full">
                    <span>{t('Clone voice: ref text', 'Clone voice: ref text')}</span>
                    <textarea
                      value={vieneuRefText}
                      onChange={(event) => setVieneuRefText(event.target.value)}
                      placeholder={t(
                        'Nhập câu text đúng với file mẫu để clone giọng ổn định.',
                        'Enter transcript matching the reference audio for stable cloning.',
                      )}
                    />
                  </label>
                </>
              ) : null}
              <label className="admin-field admin-field--full">
                <span>{t('Text test', 'Test text')}</span>
                <textarea
                  value={ttsTestText}
                  onChange={(event) => setTtsTestText(event.target.value)}
                  placeholder={t('Nhập nội dung cần đọc thử...', 'Enter text to synthesize...')}
                />
              </label>
            </div>
            {ttsEngine !== 'vieneu' ? (
              <div className="admin-inline-actions">
                {TTS_NATURAL_PRESETS.map((preset) => (
                  <button
                    key={`${preset.voice}-${preset.rate}`}
                    className="admin-btn admin-btn--ghost"
                    type="button"
                    onClick={() => {
                      setTtsVoice(preset.voice)
                      setTtsRate(preset.rate)
                      setNotice({
                        tone: 'info',
                        text: t(`Đã chọn preset ${preset.label.vi}.`, `Preset selected: ${preset.label.en}.`),
                      })
                    }}
                  >
                    {preset.label[uiLanguage]}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="admin-service-card__detail">
              {ttsEngine === 'vieneu'
                  ? t(
                    'VieNeu: có thể chọn preset voice hoặc clone giọng bằng ref audio + ref text, sau đó bấm Apply.',
                    'VieNeu: choose a preset voice or clone from ref audio + ref text, then press Apply.',
                  )
                : t(
                    'Goi y de nghe giong nguoi that hon: dung Neural voice, rate trong khoang 145-180.',
                    'For more natural voice quality, use Neural voice with rate around 145-180.',
                  )}
            </p>
            {ttsEngine === 'vieneu' ? (
              <div className="admin-chip-list">
                {VIENEU_REALTIME_PROFILES.map((profile) => (
                  <button
                    key={profile.id}
                    className={`admin-btn ${vieneuRealtimeProfile === profile.id ? '' : 'admin-btn--ghost'}`}
                    type="button"
                    onClick={() => applyVieneuRealtimeProfile(profile.id)}
                  >
                    {profile.label[uiLanguage]}
                  </button>
                ))}
              </div>
            ) : null}
          </article>

          {showAdvancedVoiceTools ? (
            <>
              <article className="admin-subcard">
                <header className="admin-subcard__head">
                  <div>
                    <h3>{t('Test mic nhanh (1 nút)', 'Quick Mic Test (one button)')}</h3>
                    <p>
                      {t(
                        'Bấm một lần để xin quyền mic và bật STT ngay. Bấm lại để dừng test.',
                        'Click once to request mic permission and start STT. Click again to stop.',
                      )}
                    </p>
                  </div>
                  <div className="admin-inline-actions">
                    <button className="admin-btn" type="button" onClick={() => void runQuickMicTest()}>
                      {listening ? t('Dừng test mic', 'Stop Mic Test') : t('Kiểm tra mic ngay', 'Start Mic Test')}
                    </button>
                  </div>
                </header>
                <p className={`admin-chip admin-chip--${micState}`}>{micState}</p>
                <p className="admin-service-card__detail">{micDetail}</p>
                <div className="admin-fields-grid admin-fields-grid--voice">
                  <label className="admin-field">
                    <span>{t('Realtime transcript', 'Realtime transcript')}</span>
                    <textarea value={sttPartialText} readOnly placeholder={t('Text tạm thời sẽ hiện ở đây...', 'Interim text appears here...')} />
                  </label>
                  <label className="admin-field">
                    <span>{t('Final transcript', 'Final transcript')}</span>
                    <textarea value={sttFinalText} readOnly placeholder={t('Text final sẽ hiện ở đây...', 'Final text appears here...')} />
                  </label>
                </div>
                {speechNotices.length > 0 ? (
                  <div className="admin-chip-list">
                    {speechNotices.map((item) => (
                      <p
                        key={`${item.level}-${item.text}`}
                        className={`admin-chip admin-chip--${item.level === 'warning' ? 'error' : 'ok'}`}
                      >
                        {item.text}
                      </p>
                    ))}
                  </div>
                ) : null}
              </article>

              <article className="admin-subcard">
                <header className="admin-subcard__head">
                  <div>
                    <h3>Live caption alternative</h3>
                    <p>{t('Chế độ caption để theo dõi text liên tục, hữu ích khi test ở môi trường ồn ào.', 'Caption mode helps track continuous text, useful in noisy environments.')}</p>
                  </div>
                  <div className="admin-inline-actions">
                    <button className="admin-btn admin-btn--ghost" type="button" onClick={liveCaption.clear}>
                      {t('Xóa caption', 'Clear Caption')}
                    </button>
                    {liveCaption.isListening ? (
                      <button className="admin-btn" type="button" onClick={liveCaption.stop}>
                        {t('Dừng Caption', 'Stop Caption')}
                      </button>
                    ) : (
                      <button className="admin-btn" type="button" onClick={() => void liveCaption.start()}>
                        {t('Bật Caption', 'Start Caption')}
                      </button>
                    )}
                  </div>
                </header>
                <p
                  className={`admin-chip admin-chip--${
                    liveCaption.status === 'error' || liveCaption.status === 'unsupported'
                      ? 'error'
                      : 'ok'
                  }`}
                >
                  {liveCaption.status}
                </p>
                <p className="admin-service-card__detail">
                  Engine: {liveCaption.engine ?? 'none'} | {t('Backend support', 'Backend support')}:{' '}
                  {liveCaption.backendSupported ? t('có', 'yes') : t('không', 'no')}
                </p>
                <div className="admin-fields-grid admin-fields-grid--voice">
                  <label className="admin-field">
                    <span>{t('Caption final', 'Caption final')}</span>
                    <textarea
                      value={liveCaption.finalTranscript}
                      readOnly
                      placeholder={t('Caption final sẽ tích lũy ở đây...', 'Final caption accumulates here...')}
                    />
                  </label>
                  <label className="admin-field">
                    <span>{t('Caption interim', 'Caption interim')}</span>
                    <textarea
                      value={liveCaption.interimTranscript}
                      readOnly
                      placeholder={t('Caption tạm thời sẽ cập nhật ở đây...', 'Interim caption updates here...')}
                    />
                  </label>
                </div>
                {liveCaption.error ? (
                  <p className="admin-chip admin-chip--error">{liveCaption.error}</p>
                ) : null}
              </article>
            </>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'robotStudio' ? (
        <RobotStudioPanel onNotice={setNotice} uiLanguage={uiLanguage} />
      ) : null}

      {activeTab === 'config' ? (
        <section className="admin-panel admin-panel--stacked">
          <article className="admin-subcard">
            <header className="admin-subcard__head">
              <div>
                <h3>{t('Cấu hình thiết yếu', 'Essential Configuration')}</h3>
                <p>
                  {t(
                    'Nhóm này là đủ để vận hành. Nhấn lưu để đồng bộ ngay vào index, không cần refresh tay.',
                    'This set is enough for daily operation. Save to sync immediately without manual refresh.',
                  )}
                </p>
              </div>
              <div className="admin-inline-actions">
                <button className="admin-btn admin-btn--ghost" type="button" onClick={handleSaveConfig}>
                  {t('Lưu và đồng bộ', 'Save And Sync')}
                </button>
                <button className="admin-btn" type="button" onClick={() => void handleCopyEnv()}>
                  {copied ? t('Đã copy', 'Copied') : 'Copy .env'}
                </button>
              </div>
            </header>

            <p className="admin-service-card__detail">
              {t('Lần đồng bộ gần nhất', 'Last synced')}:{' '}
              {formatSyncTime(lastSyncAt, uiLanguage)}
            </p>

            <div className="admin-fields-grid">
              {essentialFields.map((field) => (
                <label key={field.key} className="admin-field">
                  <span>{field.label}</span>
                  <input
                    value={field.value}
                    onChange={(event) => setFieldValue(field.key, event.target.value)}
                    onBlur={handleSaveConfig}
                  />
                </label>
              ))}
            </div>

            <button
              className="admin-btn admin-btn--minimal"
              type="button"
              onClick={() => setShowAdvancedConfig((current) => !current)}
            >
              {showAdvancedConfig
                ? t('Ẩn cấu hình nâng cao', 'Hide Advanced Config')
                : t('Mở cấu hình nâng cao', 'Show Advanced Config')}
            </button>

            {showAdvancedConfig ? (
              <div className="admin-fields-grid">
                {advancedFields.map((field) => (
                  <label key={field.key} className="admin-field">
                    <span>{field.label}</span>
                    <input
                      value={field.value}
                      onChange={(event) => setFieldValue(field.key, event.target.value)}
                      onBlur={handleSaveConfig}
                    />
                  </label>
                ))}
              </div>
            ) : null}
          </article>

          <article className="admin-subcard">
            <header className="admin-subcard__head">
              <div>
                <h3>Preview .env</h3>
                <p>
                  {showAdvancedConfig
                    ? t('Đang hiển thị full cấu hình', 'Showing full config')
                    : t('Đang hiển thị nhóm thiết yếu', 'Showing essential config')}
                </p>
              </div>
            </header>
            <textarea
              className="admin-env-preview"
              value={showAdvancedConfig ? envText : essentialEnvText}
              readOnly
            />
          </article>
        </section>
      ) : null}
        </section>
      </div>
    </main>
  )
}



