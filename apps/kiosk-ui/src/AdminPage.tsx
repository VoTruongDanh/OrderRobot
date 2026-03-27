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

type EnvField = {
  key: string
  label: string
  value: string
}

type TtsApplyStatus = 'idle' | 'saving' | 'success' | 'error'

const ADMIN_UI_LANGUAGE_KEY = 'admin.ui.language'

const TAB_ITEMS: Array<{ id: AdminTab; label: Record<UiLanguage, string>; hint: Record<UiLanguage, string> }> = [
  {
    id: 'overview',
    label: { vi: 'Tong quan', en: 'Overview' },
    hint: {
      vi: 'Xem nhanh he thong dang song hay loi.',
      en: 'Quickly check what is healthy and what is failing.',
    },
  },
  {
    id: 'voice',
    label: { vi: 'Giong noi', en: 'Voice' },
    hint: {
      vi: 'Cai dat TTS va an test ky thuat.',
      en: 'Configure TTS and run technical voice tests.',
    },
  },
  {
    id: 'robotStudio',
    label: { vi: 'Robot Studio', en: 'Robot Studio' },
    hint: {
      vi: 'Skin, action, graph va trigger.',
      en: 'Skin, actions, graphs, and triggers.',
    },
  },
  {
    id: 'config',
    label: { vi: 'Cau hinh', en: 'Configuration' },
    hint: {
      vi: 'Luu cai dat va dong bo sang kiosk ngay.',
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
  { value: 'vi-VN-HoaiMyNeural', label: 'HoaiMy Neural (Nu, tu nhien)' },
  { value: 'vi-VN-NamMinhNeural', label: 'NamMinh Neural (Nam, tu nhien)' },
  { value: 'en-US-AvaMultilingualNeural', label: 'Ava Multilingual Neural (Nu, mem)' },
  { value: 'en-US-AndrewMultilingualNeural', label: 'Andrew Multilingual Neural (Nam, dam)' },
  { value: 'vi-VN-An', label: 'vi-VN-An (Nam, Standard)' },
  { value: 'vi-VN-HoaiMy', label: 'vi-VN-HoaiMy (Nu, Standard)' },
]

const TTS_NATURAL_PRESETS: Array<{ label: Record<UiLanguage, string>; voice: string; rate: string }> = [
  {
    label: { vi: 'Nu tu nhien', en: 'Natural Female' },
    voice: 'vi-VN-HoaiMyNeural',
    rate: '165',
  },
  {
    label: { vi: 'Nam tu nhien', en: 'Natural Male' },
    voice: 'vi-VN-NamMinhNeural',
    rate: '160',
  },
  {
    label: { vi: 'Nu mem chat', en: 'Soft Chat Female' },
    voice: 'en-US-AvaMultilingualNeural',
    rate: '155',
  },
  {
    label: { vi: 'Nam am dam', en: 'Warm Deep Male' },
    voice: 'en-US-AndrewMultilingualNeural',
    rate: '155',
  },
]

function getMicNoiseFilterLabel(strength: number, uiLanguage: UiLanguage): string {
  const level = getMicNoiseFilterLevelFromStrength(strength)
  if (level === 'off') {
    return uiLanguage === 'vi' ? 'Tat loc on' : 'Noise filter off'
  }
  if (level === 'strong') {
    return uiLanguage === 'vi' ? 'Loc on manh' : 'Strong noise filter'
  }
  return uiLanguage === 'vi' ? 'Can bang' : 'Balanced'
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

function toEnvPayload(fields: EnvField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.key, normalizeEnvValue(field.key, field.value)]),
  )
}

function formatSyncTime(updatedAt: number | null, uiLanguage: UiLanguage): string {
  if (!updatedAt) {
    return uiLanguage === 'vi' ? 'Chua dong bo lan nao' : 'No sync yet'
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
    loadAdminUiLanguage() === 'vi' ? 'Chua check microphone' : 'Microphone has not been checked',
  )
  const [sttPartialText, setSttPartialText] = useState('')
  const [sttFinalText, setSttFinalText] = useState('')
  const [speechNotices, setSpeechNotices] = useState<Array<{ text: string; level: 'warning' | 'info' }>>([])
  const [envFields, setEnvFields] = useState<EnvField[]>(() => loadSavedEnv())
  const [ttsVoice, setTtsVoice] = useState(() =>
    getFieldValue(loadSavedEnv(), 'TTS_VOICE', 'vi-VN-HoaiMyNeural'),
  )
  const [ttsRate, setTtsRate] = useState(() => getFieldValue(loadSavedEnv(), 'TTS_RATE', '165'))
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
      ? 'Xin chao! Minh la robot dat mon. Ban muon goi gi hom nay?'
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
      detail: uiLanguage === 'vi' ? 'Chua kiem tra' : 'Not checked yet',
    })),
  )

  const { listening, interimTranscript, recognitionSupported, startListening, stopListening } = useSpeech({
    lang: speechLang,
    onTranscript: (transcript) => {
      setSttFinalText(transcript)
      setMicState('ok')
      setMicDetail('STT da nhan transcript')
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

  const isHealthChecking = services.some((service) => service.status === 'checking')

  useEffect(() => {
    localStorage.setItem(ADMIN_UI_LANGUAGE_KEY, uiLanguage)
  }, [uiLanguage])

  useEffect(() => {
    setSttPartialText(interimTranscript)
    if (interimTranscript.trim()) {
      setMicState('ok')
      setMicDetail('Dang nhan partial transcript...')
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
            detail: uiLanguage === 'vi' ? 'Chua kiem tra' : 'Not checked yet',
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
              ? 'URL da thay doi, can check lai'
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
        detail: error instanceof Error ? error.message : uiLanguage === 'vi' ? 'Loi khong ro' : 'Unknown error',
      }
    }
  }, [uiLanguage])

  const runHealthChecks = useCallback(async () => {
    const checkingList = services.map((service) => ({
      ...service,
      status: 'checking' as const,
      detail: uiLanguage === 'vi' ? 'Dang kiem tra...' : 'Checking...',
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
        'Da luu cau hinh. Trang kiosk index se nhan ngay.',
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
        text: showAdvancedConfig ? t('Da copy full .env', 'Full .env copied') : t('Da copy .env voi nhom cau hinh thiet yeu', 'Essential .env block copied'),
      })
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Khong the copy .env', 'Cannot copy .env'),
      })
    }
  }, [envText, essentialEnvText, showAdvancedConfig, t])

  const stopBrowserStt = useCallback(() => {
    if (!listening) {
      return
    }
    stopListening()
    setMicState('ok')
    setMicDetail(t('Da dung STT va cho transcript cuoi', 'STT stopped, waiting for final transcript'))
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
    setMicDetail(t('Dang xin quyen microphone va khoi dong STT...', 'Requesting microphone permission and starting STT...'))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicAudioConstraints(micNoiseFilterStrength),
      })
      const tracks = stream.getAudioTracks()
      const trackLabel = tracks[0]?.label || t('Microphone san sang', 'Microphone ready')
      tracks.forEach((track) => track.stop())

      if (!recognitionSupported) {
        setMicState('ok')
        setMicDetail(
          `${trackLabel}. ${t('Trinh duyet khong ho tro STT kiosk flow.', 'This browser does not support the kiosk STT flow.')}`,
        )
        return
      }

      await startListening()
      setMicState('ok')
      setMicDetail(`Mic ok (${trackLabel}). ${t('Dang nghe...', 'Listening...')}`)
    } catch (error) {
      setMicState('error')
      setMicDetail(error instanceof Error ? error.message : t('Khong the test microphone', 'Cannot test microphone'))
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
      text: t(`Da cap nhat do to robot: ${safeValue}%`, `Robot scale updated: ${safeValue}%`),
    })
  }, [t])

  const handleCameraPreviewVisibleChange = useCallback((visible: boolean) => {
    setCameraPreviewVisible(visible)
    persistCameraPreviewVisible(visible)
    setNotice({
      tone: 'info',
      text: visible
        ? t('Da bat khung camera tren kiosk.', 'Camera preview enabled on kiosk.')
        : t('Da an khung camera tren kiosk.', 'Camera preview hidden on kiosk.'),
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
        text: t('Dang do do on truc tiep tu microphone.', 'Live microphone noise monitoring is running.'),
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : t('Khong the bat do on microphone.', 'Cannot start microphone noise monitor.'),
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
    if (normalizedRate === null) {
      setTtsTestStatus('error')
      setNotice({
        tone: 'warning',
        text: t('TTS Rate phai la so trong khoang 100-300.', 'TTS rate must be a number between 100 and 300.'),
      })
      window.setTimeout(() => setTtsTestStatus('idle'), 2000)
      return
    }

    setTtsTestStatus('playing')
    try {
      const response = await fetch(`${currentAiApiUrl}/speech/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ttsTestText,
          voice: ttsVoice,
          rate: normalizedRate,
        }),
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
  }, [currentAiApiUrl, t, ttsRate, ttsTestText, ttsVoice])

  const applyTtsConfig = useCallback(async () => {
    const normalizedRate = toSafeTtsRate(ttsRate)
    if (normalizedRate === null) {
      setTtsApplyStatus('error')
      setNotice({
        tone: 'warning',
        text: t(
          'Khong the apply TTS: Rate phai nam trong khoang 100-300.',
          'Cannot apply TTS: rate must be between 100 and 300.',
        ),
      })
      window.setTimeout(() => setTtsApplyStatus('idle'), 2000)
      return
    }

    setTtsApplyStatus('saving')
    try {
      const response = await fetch(`${currentAiApiUrl}/config/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: ttsVoice,
          rate: normalizedRate,
          tts_voice: ttsVoice,
          tts_rate: normalizedRate,
        }),
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

      const nextFields = envFields.map((field) => {
        if (field.key === 'TTS_VOICE') {
          return { ...field, value: ttsVoice }
        }
        if (field.key === 'TTS_RATE') {
          return { ...field, value: ttsRate }
        }
        return field
      })
      setEnvFields(nextFields)
      saveAndSyncConfig(
        nextFields,
        t('Da apply TTS vao backend va dong bo vao kiosk.', 'TTS applied to backend and synced to kiosk.'),
      )
      setTtsApplyStatus('success')
    } catch (error) {
      setTtsApplyStatus('error')
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Khong the apply TTS config', 'Cannot apply TTS config'),
      })
    } finally {
      window.setTimeout(() => setTtsApplyStatus('idle'), 2000)
    }
  }, [currentAiApiUrl, envFields, saveAndSyncConfig, t, ttsRate, ttsVoice])

  return (
    <main className="admin-page">
      <div className="admin-page__backdrop admin-page__backdrop--one" />
      <div className="admin-page__backdrop admin-page__backdrop--two" />

      <header className="admin-header">
        <div className="admin-header__title">
          <p className="admin-kicker">Order Robot / Admin</p>
          <h1>{t('Bang dieu khien de quan ly nhanh va ro', 'Control center for fast and clear operations')}</h1>
          <p className="admin-subtitle">
            {t(
              'Khong can nho het tung config. Chi can lam theo thu tu: check he thong, test giong noi, sau do luu va dong bo.',
              'No need to memorize every config. Follow this order: check system, test voice, then save and sync.',
            )}
          </p>
        </div>
        <div className="admin-header__actions">
          <button
            className="admin-link"
            type="button"
            onClick={() => setUiLanguage((current) => (current === 'vi' ? 'en' : 'vi'))}
          >
            {uiLanguage === 'vi' ? 'EN' : 'VI'}
          </button>
          <a className="admin-link" href="/debug">
            {t('Bridge Debug', 'Bridge Debug')}
          </a>
          <a className="admin-link admin-link--primary" href="/">
            {t('Ve Kiosk', 'Back To Kiosk')}
          </a>
        </div>
      </header>

      {notice ? (
        <section className={`admin-notice admin-notice--${notice.tone}`} role="status">
          {notice.text}
        </section>
      ) : null}

      <section className="admin-metrics-grid">
        <article className="admin-metric-card">
          <p className="admin-metric-card__label">{t('He thong khoe', 'System Health')}</p>
          <p className="admin-metric-card__value">
            {healthyServiceCount}/{services.length}
          </p>
          <p className="admin-metric-card__hint">{t('service dang online', 'services online')}</p>
        </article>
        <article className="admin-metric-card">
          <p className="admin-metric-card__label">{t('Dong bo index', 'Index Sync')}</p>
          <p className="admin-metric-card__value">{formatSyncTime(lastSyncAt, uiLanguage)}</p>
          <p className="admin-metric-card__hint">{t('moi thay doi se cap nhat vao kiosk', 'every change syncs to kiosk')}</p>
        </article>
        <article className="admin-metric-card">
          <p className="admin-metric-card__label">Speech status</p>
          <p className="admin-metric-card__value">{listening ? t('Dang nghe', 'Listening') : t('Dang nghi', 'Idle')}</p>
          <p className="admin-metric-card__hint">
            Mic: {micState} | Caption: {liveCaption.status}
          </p>
        </article>
      </section>

      <section className="admin-panel admin-panel--robot-first">
        <header className="admin-panel__head">
          <div>
            <h2>{t('Tuy chinh robot', 'Robot Tuning')}</h2>
            <p>{t('Chinh do to robot truoc tien. Keo la kiosk cap nhat ngay.', 'Adjust robot scale first. Drag to update kiosk instantly.')}</p>
          </div>
          <p className="admin-chip admin-chip--ok">Scale: {robotScalePercent}%</p>
        </header>
        <div className="admin-fields-grid">
          <label className="admin-field admin-field--full">
            <span>{t('Do to robot (60-170%)', 'Robot scale (60-170%)')}</span>
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
            <span>{t('Khung camera mini (goc phai tren)', 'Mini camera tile (top-right)')}</span>
            <select
              value={cameraPreviewVisible ? 'show' : 'hide'}
              onChange={(event) => handleCameraPreviewVisibleChange(event.target.value === 'show')}
            >
              <option value="show">{t('Hien', 'Show')}</option>
              <option value="hide">{t('An', 'Hide')}</option>
            </select>
          </label>
        </div>
      </section>

      <nav className="admin-tabs" aria-label="Admin sections">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.id}
            className={`admin-tab ${activeTab === tab.id ? 'admin-tab--active' : ''}`}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            aria-pressed={activeTab === tab.id}
          >
            <span>{tab.label[uiLanguage]}</span>
            <small>{tab.hint[uiLanguage]}</small>
          </button>
        ))}
      </nav>

      {activeTab === 'overview' ? (
        <section className="admin-panel">
          <header className="admin-panel__head">
            <div>
              <h2>{t('Suc khoe backend', 'Backend Health')}</h2>
              <p>{t('Kiem tra ngay cac endpoint quan trong de biet cai nao dang cham, cai nao dang loi.', 'Check critical endpoints to see what is slow or failing.')}</p>
            </div>
            <button className="admin-btn" type="button" onClick={() => void runHealthChecks()}>
              {isHealthChecking ? t('Dang kiem tra...', 'Checking...') : t('Check ngay', 'Run Check')}
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
                <p>{t('Keo slider de chinh muc loc on, va xem do on realtime tu mic.', 'Drag slider to tune noise filter and view live mic level.')}</p>
              </div>
              <div className="admin-inline-actions">
                {noiseMonitorActive ? (
                  <button className="admin-btn admin-btn--ghost" type="button" onClick={stopNoiseMonitor}>
                    {t('Dung do on', 'Stop Meter')}
                  </button>
                ) : (
                  <button className="admin-btn" type="button" onClick={() => void startNoiseMonitor()}>
                    {t('Bat do on truc tiep', 'Start Live Meter')}
                  </button>
                )}
              </div>
            </header>
            <div className="admin-fields-grid">
              <label className="admin-field">
                <span>
                  {t('Muc loc on', 'Noise filter level')}: {micNoiseFilterStrength}% ({getMicNoiseFilterLabel(micNoiseFilterStrength, uiLanguage)})
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
              {t('Do on hien tai', 'Current noise')}: <strong>{noiseLevelDb.toFixed(1)} dB</strong>
            </p>
            <div className="admin-noise-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={noiseLevelPercent}>
              <div className="admin-noise-meter__bar" style={{ width: `${noiseLevelPercent}%` }} />
            </div>
          </article>

          <article className="admin-subcard">
            <header className="admin-subcard__head">
              <div>
                <h3>{t('Cai dat giong noi', 'Voice Settings')}</h3>
                <p>
                  {t('Chon voice va toc do doc. Test va apply ngay tai day.', 'Select voice and speaking rate. Test and apply right here.')}
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
                    ? t('Dang doc...', 'Speaking...')
                    : ttsTestStatus === 'error'
                      ? t('Doc thu bi loi', 'Preview failed')
                      : t('Doc thu', 'Preview')}
                </button>
                <button
                  className="admin-btn admin-btn--ghost"
                  type="button"
                  onClick={() => void applyTtsConfig()}
                  disabled={ttsApplyStatus === 'saving'}
                >
                  {ttsApplyStatus === 'saving'
                    ? t('Dang apply...', 'Applying...')
                    : ttsApplyStatus === 'success'
                      ? t('Apply xong', 'Applied')
                      : ttsApplyStatus === 'error'
                        ? t('Apply loi', 'Apply failed')
                        : t('Apply vao backend', 'Apply To Backend')}
                </button>
                <button
                  className="admin-btn admin-btn--minimal"
                  type="button"
                  onClick={() => setShowAdvancedVoiceTools((current) => !current)}
                >
                  {showAdvancedVoiceTools ? t('An test ky thuat', 'Hide Advanced Tests') : t('Hien test ky thuat', 'Show Advanced Tests')}
                </button>
              </div>
            </header>
            <div className="admin-fields-grid">
              <label className="admin-field">
                <span>TTS Voice</span>
                <select value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)}>
                  {TTS_VOICE_OPTIONS.map((voice) => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>TTS Rate (100-300)</span>
                <input
                  type="number"
                  min="100"
                  max="300"
                  step="5"
                  value={ttsRate}
                  onChange={(event) => setTtsRate(event.target.value)}
                />
              </label>
              <label className="admin-field admin-field--full">
                <span>{t('Text test', 'Test text')}</span>
                <textarea
                  value={ttsTestText}
                  onChange={(event) => setTtsTestText(event.target.value)}
                  placeholder={t('Nhap noi dung can doc thu...', 'Enter text to synthesize...')}
                />
              </label>
            </div>
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
                      text: t(`Da chon preset ${preset.label.vi}.`, `Preset selected: ${preset.label.en}.`),
                    })
                  }}
                >
                  {preset.label[uiLanguage]}
                </button>
              ))}
            </div>
            <p className="admin-service-card__detail">
              {t(
                'Goi y de nghe giong nguoi that hon: dung Neural voice, rate trong khoang 145-180.',
                'For more natural voice quality, use Neural voice with rate around 145-180.',
              )}
            </p>
          </article>

          {showAdvancedVoiceTools ? (
            <>
              <article className="admin-subcard">
                <header className="admin-subcard__head">
                  <div>
                    <h3>{t('Test mic nhanh (1 nut)', 'Quick Mic Test (one button)')}</h3>
                    <p>
                      {t(
                        'Bam mot lan de xin quyen mic va bat STT ngay. Bam lai de dung test.',
                        'Click once to request mic permission and start STT. Click again to stop.',
                      )}
                    </p>
                  </div>
                  <div className="admin-inline-actions">
                    <button className="admin-btn" type="button" onClick={() => void runQuickMicTest()}>
                      {listening ? t('Dung test mic', 'Stop Mic Test') : t('Test mic ngay', 'Start Mic Test')}
                    </button>
                  </div>
                </header>
                <p className={`admin-chip admin-chip--${micState}`}>{micState}</p>
                <p className="admin-service-card__detail">{micDetail}</p>
                <div className="admin-fields-grid admin-fields-grid--voice">
                  <label className="admin-field">
                    <span>{t('Realtime transcript', 'Realtime transcript')}</span>
                    <textarea value={sttPartialText} readOnly placeholder={t('Text tam thoi se hien o day...', 'Interim text appears here...')} />
                  </label>
                  <label className="admin-field">
                    <span>{t('Final transcript', 'Final transcript')}</span>
                    <textarea value={sttFinalText} readOnly placeholder={t('Text final se hien o day...', 'Final text appears here...')} />
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
                    <p>{t('Che do caption de theo doi text lien tuc, huu ich khi test o moi truong on ao.', 'Caption mode helps track continuous text, useful in noisy environments.')}</p>
                  </div>
                  <div className="admin-inline-actions">
                    <button className="admin-btn admin-btn--ghost" type="button" onClick={liveCaption.clear}>
                      {t('Xoa caption', 'Clear Caption')}
                    </button>
                    {liveCaption.isListening ? (
                      <button className="admin-btn" type="button" onClick={liveCaption.stop}>
                        {t('Dung Caption', 'Stop Caption')}
                      </button>
                    ) : (
                      <button className="admin-btn" type="button" onClick={() => void liveCaption.start()}>
                        {t('Bat Caption', 'Start Caption')}
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
                  {liveCaption.backendSupported ? t('co', 'yes') : t('khong', 'no')}
                </p>
                <div className="admin-fields-grid admin-fields-grid--voice">
                  <label className="admin-field">
                    <span>{t('Caption final', 'Caption final')}</span>
                    <textarea
                      value={liveCaption.finalTranscript}
                      readOnly
                      placeholder={t('Caption final se tich luy o day...', 'Final caption accumulates here...')}
                    />
                  </label>
                  <label className="admin-field">
                    <span>{t('Caption interim', 'Caption interim')}</span>
                    <textarea
                      value={liveCaption.interimTranscript}
                      readOnly
                      placeholder={t('Caption tam thoi se cap nhat o day...', 'Interim caption updates here...')}
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
                <h3>{t('Cau hinh thiet yeu', 'Essential Configuration')}</h3>
                <p>
                  {t(
                    'Nhom nay la du de van hanh. Nhan luu de dong bo ngay vao index, khong can refresh tay.',
                    'This set is enough for daily operation. Save to sync immediately without manual refresh.',
                  )}
                </p>
              </div>
              <div className="admin-inline-actions">
                <button className="admin-btn admin-btn--ghost" type="button" onClick={handleSaveConfig}>
                  {t('Luu va dong bo', 'Save And Sync')}
                </button>
                <button className="admin-btn" type="button" onClick={() => void handleCopyEnv()}>
                  {copied ? t('Da copy', 'Copied') : 'Copy .env'}
                </button>
              </div>
            </header>

            <p className="admin-service-card__detail">
              {t('Lan dong bo gan nhat', 'Last synced')}:{' '}
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
                ? t('An cau hinh nang cao', 'Hide Advanced Config')
                : t('Mo cau hinh nang cao', 'Show Advanced Config')}
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
                    ? t('Dang hien full cau hinh', 'Showing full config')
                    : t('Dang hien nhom thiet yeu', 'Showing essential config')}
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
    </main>
  )
}

