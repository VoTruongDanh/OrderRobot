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
  getProductDefaultSizeName,
  getProductSizeApiUrl,
  getRobotScalePercent,
  getMenuApiUrl,
  getOrdersApiUrl,
  resolveBrowserSafeAiApiUrl,
  resolveBrowserSafeMenuApiUrl,
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

type EnvSyncState = {
  status: 'idle' | 'saving' | 'ok' | 'error'
  detail: string
  apiBase: string
}

type VieneuRealtimeProfile = {
  id: string
  label: Record<UiLanguage, string>
  hint: Record<UiLanguage, string>
  modelPath: string
  vieneuMode: string
  backboneDevice: string
  codecRepo: string
  codecDevice: string
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
type VoiceListenMode = 'always' | 'sequential'
type AdminPageProps = { onLogout?: () => void }

type VieneuDiagnostics = {
  available?: boolean
  engine?: string
  mode?: string
  configured_model_path?: string
  model_path?: string
  backbone_device?: string
  configured_codec_repo?: string
  codec_repo?: string
  codec_device?: string
  remote_api_base?: string
  instance_ready?: boolean
  last_init_ms?: number
  prewarm_ms?: number
  prewarmed_at_unix?: number
  last_error?: string
  compat_warning?: string
  vieneu_version?: string
  stream_realtime_factor?: number
  stream_cfg?: {
    frames_per_chunk?: number
    lookforward?: number
    lookback?: number
    overlap_frames?: number
  }
  cpu_processing?: Record<string, string>
}

type VieneuBackendCapabilities = {
  voices: boolean
  diag: boolean
  prewarm: boolean
  install: boolean
  synth: boolean
}

const ADMIN_UI_LANGUAGE_KEY = 'admin.ui.language'

const MENU_GROUPS: Array<{ id: AdminMenuGroup; label: Record<UiLanguage, string> }> = [
  { id: 'monitor', label: { vi: 'Monitoring', en: 'Monitoring' } },
  { id: 'audio', label: { vi: 'Audio', en: 'Audio' } },
  { id: 'robot', label: { vi: 'Robot', en: 'Robot' } },
  { id: 'system', label: { vi: 'System', en: 'System' } },
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
    label: { vi: 'Overview', en: 'Overview' },
    hint: {
      vi: 'Quickly check what is healthy and what is failing.',
      en: 'Quickly check what is healthy and what is failing.',
    },
  },
  {
    id: 'voice',
    group: 'audio',
    icon: '02',
    label: { vi: 'Voice', en: 'Voice' },
    hint: {
      vi: 'Configure TTS and run technical voice tests.',
      en: 'Configure TTS and run technical voice tests.',
    },
  },
  {
    id: 'robotStudio',
    group: 'robot',
    icon: '03',
    label: { vi: 'Robot Studio', en: 'Robot Studio' },
    hint: {
      vi: 'Skin, actions, graphs, and triggers.',
      en: 'Skin, actions, graphs, and triggers.',
    },
  },
  {
    id: 'config',
    group: 'system',
    icon: '04',
    label: { vi: 'Configuration', en: 'Configuration' },
    hint: {
      vi: 'Save settings and sync to kiosk instantly.',
      en: 'Save settings and sync to kiosk instantly.',
    },
  },
]

const ESSENTIAL_ENV_KEYS = new Set([
  'VITE_CORE_API_URL',
  'VITE_AI_API_URL',
  'VITE_MENU_API_URL',
  'VITE_PRODUCT_SIZE_API_URL',
  'VITE_ORDERS_API_URL',
  'VITE_TAX_PERCENT',
  'AI_MODEL',
  'CORE_BACKEND_URL',
  'TTS_ENGINE',
  'TTS_VOICE',
  'TTS_RATE',
  'VOICE_LANG',
  'SESSION_TIMEOUT_MINUTES',
  'VOICE_LISTEN_MODE',
  'POS_API_BASE_URL',
  'POS_ORDER_TYPE',
  'POS_PAYMENT_METHOD',
  'POS_TAG_NUMBER',
  'POS_MENU_SOURCE_MODE',
  'POS_MENU_SOURCE_URL',
  'POS_SIZE_SOURCE_URL',
  'POS_DEFAULT_SIZE_NAME',
])

const HIDDEN_ADMIN_ENV_KEYS = new Set([
  'POS_API_TOKEN',
  'POS_API_USERNAME',
  'POS_API_PASSWORD',
  'POS_AUTH_LOGIN_URL',
  'POS_AUTH_REFRESH_URL',
  'POS_STORE_ID',
  'POS_STORE_PROFILE_MAP_JSON',
])

const VIENEU_CODEC_REPO_DISTILL = 'neuphonic/distill-neucodec'
const VIENEU_CODEC_REPO_AUTO = ''

const ENV_TEMPLATE: EnvField[] = [
  { key: 'AI_BASE_URL', label: 'AI Base URL', value: 'http://127.0.0.1:11434/v1' },
  { key: 'AI_API_KEY', label: 'AI API Key', value: '' },
  { key: 'AI_MODEL', label: 'AI Model', value: 'gpt-4o-mini' },
  { key: 'CORE_BACKEND_URL', label: 'Core Backend URL', value: getCoreApiUrl() },
  { key: 'POS_API_BASE_URL', label: 'POS API Base URL', value: 'http://cnxvn.ddns.net:8080/api/v1' },
  { key: 'POS_API_TOKEN', label: 'POS API Token (Bearer)', value: '' },
  { key: 'POS_API_USERNAME', label: 'POS API Username', value: '' },
  { key: 'POS_API_PASSWORD', label: 'POS API Password', value: '' },
  { key: 'POS_AUTH_LOGIN_URL', label: 'POS Auth Login URL', value: 'http://cnxvn.ddns.net:8080/api/v1/auth/login' },
  { key: 'POS_AUTH_REFRESH_URL', label: 'POS Auth Refresh URL', value: 'http://cnxvn.ddns.net:8080/api/v1/auth/refresh' },
  { key: 'POS_STORE_ID', label: 'POS Store ID', value: '9' },
  { key: 'POS_STORE_PROFILE_MAP_JSON', label: 'POS Store Profile Map JSON', value: '' },
  { key: 'POS_ORDER_TYPE', label: 'POS Order Type', value: 'POS' },
  { key: 'POS_PAYMENT_METHOD', label: 'POS Payment Method', value: 'ONLINE_PAYMENT' },
  { key: 'POS_TAG_NUMBER', label: 'POS Tag Number', value: '1' },
  { key: 'POS_MENU_SOURCE_MODE', label: 'POS Menu Source Mode', value: 'remote_strict' },
  { key: 'POS_MENU_SOURCE_URL', label: 'POS Menu Source URL', value: 'http://cnxvn.ddns.net:8080/api/v1/product-availability/filter?storeId={storeId}&page=0&size=1000&sort=' },
  { key: 'POS_SIZE_SOURCE_URL', label: 'POS Size Source URL', value: 'http://cnxvn.ddns.net:8080/api/v1/product-size/filter?productId={productId}&page=0&size=10&sort=' },
  { key: 'POS_DEFAULT_SIZE_NAME', label: 'POS Default Size Name', value: 'M' },
  { key: 'LLM_MODE', label: 'LLM Mode', value: 'bridge_only' },
  { key: 'BRIDGE_BASE_URL', label: 'Bridge Base URL', value: 'http://127.0.0.1:1122' },
  { key: 'BRIDGE_TIMEOUT_SECONDS', label: 'Bridge Timeout Seconds', value: '8' },
  { key: 'VOICE_LANG', label: 'Voice Lang', value: 'vi-VN' },
  { key: 'VOICE_STYLE', label: 'Voice Style', value: 'cute_friendly' },
  { key: 'TTS_ENGINE', label: 'TTS Engine', value: 'vieneu' },
  { key: 'TTS_VIENEU_MODEL_PATH', label: 'VieNeu Model Path', value: 'pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF' },
  { key: 'TTS_VIENEU_MODE', label: 'VieNeu Mode', value: 'turbo' },
  { key: 'TTS_VIENEU_BACKBONE_DEVICE', label: 'VieNeu Backbone Device', value: 'cpu' },
  { key: 'TTS_VIENEU_CODEC_REPO', label: 'VieNeu Codec Repo', value: VIENEU_CODEC_REPO_AUTO },
  { key: 'TTS_VIENEU_CODEC_DEVICE', label: 'VieNeu Codec Device', value: 'cpu' },
  { key: 'TTS_VIENEU_REMOTE_API_BASE', label: 'VieNeu Remote API Base', value: 'http://localhost:23333/v1' },
  { key: 'TTS_VIENEU_VOICE_ID', label: 'VieNeu Voice ID', value: '' },
  { key: 'TTS_VIENEU_REF_AUDIO', label: 'VieNeu Ref Audio Path', value: '' },
  { key: 'TTS_VIENEU_REF_TEXT', label: 'VieNeu Ref Text', value: '' },
  { key: 'TTS_VIENEU_TEMPERATURE', label: 'VieNeu Temperature', value: '1.0' },
  { key: 'TTS_VIENEU_TOP_K', label: 'VieNeu Top K', value: '50' },
  { key: 'TTS_VIENEU_MAX_CHARS', label: 'VieNeu Max Chars', value: '256' },
  { key: 'TTS_VIENEU_STREAM_FRAMES_PER_CHUNK', label: 'VieNeu Stream Frames/Chunk', value: '25' },
  { key: 'TTS_VIENEU_STREAM_LOOKFORWARD', label: 'VieNeu Stream Lookforward', value: '10' },
  { key: 'TTS_VIENEU_STREAM_LOOKBACK', label: 'VieNeu Stream Lookback', value: '100' },
  { key: 'TTS_VIENEU_STREAM_OVERLAP_FRAMES', label: 'VieNeu Stream Overlap Frames', value: '1' },
  { key: 'VIENEU_REALTIME_PROFILE', label: 'VieNeu Realtime Profile', value: 'cpu_realtime' },
  { key: 'TTS_VOICE', label: 'TTS Voice', value: 'vi-VN-HoaiMyNeural' },
  { key: 'TTS_RATE', label: 'TTS Rate', value: '185' },
  { key: 'STT_MODEL', label: 'STT Model', value: 'small' },
  { key: 'STT_DEVICE', label: 'STT Device', value: 'cpu' },
  { key: 'STT_COMPUTE_TYPE', label: 'STT Compute Type', value: 'int8' },
  { key: 'STT_BEAM_SIZE', label: 'STT Beam Size', value: '5' },
  { key: 'STT_BEST_OF', label: 'STT Best Of', value: '3' },
  { key: 'STT_PARTIAL_BEAM_SIZE', label: 'STT Partial Beam', value: '1' },
  { key: 'STT_PARTIAL_BEST_OF', label: 'STT Partial Best Of', value: '1' },
  { key: 'BACKEND_STT_CHUNK_MS', label: 'Kiosk STT Chunk Ms', value: '120' },
  { key: 'BACKEND_STT_FINALIZE_SILENCE_MS', label: 'Kiosk STT Finalize Silence Ms', value: '420' },
  { key: 'BACKEND_STT_FORCE_FINALIZE_MS', label: 'Kiosk STT Force Finalize Ms', value: '1400' },
  { key: 'SUBMIT_SILENCE_MS', label: 'Submit Silence Ms', value: '1200' },
  { key: 'VOICE_LISTEN_MODE', label: 'Voice Listen Mode', value: 'always' },
  { key: 'VOICE_ALWAYS_LISTEN', label: 'Voice Always Listen', value: 'true' },
  { key: 'VOICE_TTS_WS_REALTIME', label: 'Voice TTS WS Realtime', value: 'true' },
  { key: 'CHAT_CLEAR_AFTER_ABSENCE_MS', label: 'Chat Clear After Absence Ms', value: '0' },
  { key: 'CHAT_CLEAR_ON_ORDER_COMPLETE', label: 'Chat Clear On Order Complete', value: 'false' },
  { key: 'TTS_STREAM_PLAYBACK_RATE', label: 'TTS Stream Playback Rate', value: '1.15' },
  { key: 'STT_VAD_MIN_SILENCE_MS', label: 'STT VAD Min Silence', value: '450' },
  { key: 'STT_PRELOAD', label: 'STT Preload', value: 'true' },
  { key: 'STT_CPU_THREADS', label: 'STT CPU Threads', value: '8' },
  { key: 'STT_NUM_WORKERS', label: 'STT Num Workers', value: '1' },
  { key: 'SESSION_TIMEOUT_MINUTES', label: 'Session Timeout Minutes', value: '15' },
  { key: 'VITE_CORE_API_URL', label: 'VITE Core URL', value: getCoreApiUrl() },
  { key: 'VITE_AI_API_URL', label: 'VITE AI URL', value: getAiApiUrl() },
  { key: 'VITE_MENU_API_URL', label: 'VITE Menu API URL', value: getMenuApiUrl() },
  { key: 'VITE_PRODUCT_SIZE_API_URL', label: 'VITE Product Size API URL', value: getProductSizeApiUrl() },
  { key: 'VITE_PRODUCT_DEFAULT_SIZE_NAME', label: 'VITE Product Default Size Name', value: getProductDefaultSizeName() },
  { key: 'VITE_ORDERS_API_URL', label: 'VITE Orders API URL', value: getOrdersApiUrl() },
  { key: 'VITE_TAX_PERCENT', label: 'VITE Tax Percent (%)', value: '10' },
]

const TTS_VOICE_OPTIONS = [
  { value: 'vi-VN-HoaiMyNeural', label: 'Hoai My Neural (Female, natural)' },
  { value: 'vi-VN-NamMinhNeural', label: 'Nam Minh Neural (Male, natural)' },
  { value: 'en-US-AvaMultilingualNeural', label: 'Ava Multilingual Neural (Female, soft)' },
  { value: 'en-US-AndrewMultilingualNeural', label: 'Andrew Multilingual Neural (Male, warm)' },
  { value: 'vi-VN-An', label: 'vi-VN-An (Male, Standard)' },
  { value: 'vi-VN-HoaiMy', label: 'vi-VN-HoaiMy (Female, Standard)' },
]

const TTS_NATURAL_PRESETS: Array<{ label: Record<UiLanguage, string>; voice: string; rate: string }> = [
  {
    label: { vi: 'Natural Female', en: 'Natural Female' },
    voice: 'vi-VN-HoaiMyNeural',
    rate: '165',
  },
  {
    label: { vi: 'Natural Male', en: 'Natural Male' },
    voice: 'vi-VN-NamMinhNeural',
    rate: '160',
  },
  {
    label: { vi: 'Soft Chat Female', en: 'Soft Chat Female' },
    voice: 'en-US-AvaMultilingualNeural',
    rate: '155',
  },
  {
    label: { vi: 'Warm Deep Male', en: 'Warm Deep Male' },
    voice: 'en-US-AndrewMultilingualNeural',
    rate: '155',
  },
]

const TTS_ENGINE_OPTIONS = [
  { value: 'vieneu', label: 'VieNeu-TTS (CPU/GPU offline)' },
  { value: 'edge', label: 'Edge Neural (cloud)' },
  { value: 'local', label: 'Local pyttsx3 (fallback)' },
  { value: 'auto', label: 'Auto (prefer VieNeu)' },
]

const STT_MODEL_OPTIONS = [
  { value: 'tiny', label: 'tiny (fastest)' },
  { value: 'base', label: 'base (balanced)' },
  { value: 'small', label: 'small (current standard)' },
  { value: 'medium', label: 'medium (more accurate)' },
  { value: 'large-v3', label: 'large-v3 (high accuracy)' },
  { value: 'distil-large-v3', label: 'distil-large-v3 (fast + good)' },
  { value: 'turbo', label: 'turbo (new fast)' },
]

const VOICE_LISTEN_MODE_OPTIONS: Array<{
  value: VoiceListenMode
  label: Record<UiLanguage, string>
  hint: Record<UiLanguage, string>
}> = [
  {
    value: 'always',
    label: { vi: 'Always Listen', en: 'Always Listen' },
    hint: {
      vi: 'Continuously listens and can capture new speech even while robot is replying.',
      en: 'Continuously listens and can capture new speech even while robot is replying.',
    },
  },
  {
    value: 'sequential',
    label: { vi: 'Sequential Listen', en: 'Sequential Listen' },
    hint: {
      vi: 'Turn-by-turn: user speaks -> robot replies -> microphone opens again for next turn.',
      en: 'Turn-by-turn: user speaks -> robot replies -> microphone opens again for next turn.',
    },
  },
]

const POS_MENU_SOURCE_MODE_OPTIONS = [
  { value: 'remote_strict', label: 'Remote Strict (Live POS)' },
  { value: 'local', label: 'Local CSV (Offline)' },
]

const CPU_DEPENDENCY_LABELS: Record<string, string> = {
  onnxruntime: 'onnxruntime',
  torch: 'PyTorch (CPU)',
  'llama-cpp-python': 'llama-cpp-python',
  vieneu: 'vieneu',
}

const VIENEU_REALTIME_PROFILES: VieneuRealtimeProfile[] = [
  {
    id: 'cpu_realtime',
    label: { vi: 'CPU realtime (v2 Turbo GGUF)', en: 'CPU realtime (v2 Turbo GGUF)' },
    hint: {
      vi: 'Prioritize low latency with v2 Turbo GGUF (stream mode).',
      en: 'Prioritize low latency with v2 Turbo GGUF (stream mode).',
    },
    modelPath: 'pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF',
    vieneuMode: 'turbo',
    backboneDevice: 'cpu',
    codecRepo: VIENEU_CODEC_REPO_AUTO,
    codecDevice: 'cpu',
    sttModel: 'base',
    sttDevice: 'cpu',
    sttComputeType: 'int8',
  },
  {
    id: 'gpu_realtime',
    label: { vi: 'GPU realtime (0.3B)', en: 'GPU realtime (0.3B)' },
    hint: {
      vi: 'Faster throughput on NVIDIA GPU, requires CUDA.',
      en: 'Faster throughput on NVIDIA GPU, requires CUDA.',
    },
    modelPath: 'pnnbao-ump/VieNeu-TTS-0.3B',
    vieneuMode: 'fast',
    backboneDevice: 'cuda',
    codecRepo: VIENEU_CODEC_REPO_DISTILL,
    codecDevice: 'cuda',
    sttModel: 'small',
    sttDevice: 'cuda',
    sttComputeType: 'float16',
  },
  {
    id: 'gpu_quality',
    label: { vi: 'GPU high quality (0.5B)', en: 'GPU high quality (0.5B)' },
    hint: {
      vi: 'Higher quality voice with slightly higher latency than 0.3B.',
      en: 'Higher quality voice with slightly higher latency than 0.3B.',
    },
    modelPath: 'pnnbao-ump/VieNeu-TTS',
    vieneuMode: 'fast',
    backboneDevice: 'cuda',
    codecRepo: VIENEU_CODEC_REPO_DISTILL,
    codecDevice: 'cuda',
    sttModel: 'small',
    sttDevice: 'cuda',
    sttComputeType: 'float16',
  },
]

function getMicNoiseFilterLabel(strength: number, uiLanguage: UiLanguage): string {
  const level = getMicNoiseFilterLevelFromStrength(strength)
  if (level === 'off') {
    return uiLanguage === 'vi' ? 'Noise filter off' : 'Noise filter off'
  }
  if (level === 'strong') {
    return uiLanguage === 'vi' ? 'Strong noise filter' : 'Strong noise filter'
  }
  return uiLanguage === 'vi' ? 'Balanced' : 'Balanced'
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

function getCoreReloadCandidates(preferredUrl: string): string[] {
  const normalizedPreferred = normalizeApiBaseUrl(preferredUrl)
  const defaults = ['/api/core', 'http://127.0.0.1:8080/api/core', 'http://localhost:8080/api/core']
  const unique = new Set<string>()
  if (normalizedPreferred.length > 0) {
    unique.add(normalizedPreferred)
  }
  for (const url of defaults) {
    unique.add(url)
  }
  return Array.from(unique)
}

function getAiApiCandidates(preferredUrl: string): string[] {
  const normalizedPreferred = normalizeApiBaseUrl(resolveBrowserSafeAiApiUrl(preferredUrl))
  const defaults = ['/api/ai', 'http://127.0.0.1:8080/api/ai', 'http://localhost:8080/api/ai']
  const unique = new Set<string>()
  // Always prioritize the currently configured/active URL first to reduce
  // noisy connection-refused logs from non-running ports.
  if (normalizedPreferred.length > 0) {
    unique.add(normalizedPreferred)
  }
  for (const url of defaults) {
    unique.add(url)
  }
  return Array.from(unique)
}

function isTruthyValue(value: string): boolean {
  return String(value || '').trim().length > 0
}

function validateLivePosConfig(fields: EnvField[]): string | null {
  const get = (key: string, fallback = '') => getFieldValue(fields, key, fallback).trim()
  const mode = get('POS_MENU_SOURCE_MODE', 'remote_strict').toLowerCase()
  if (mode !== 'remote_strict') {
    return null
  }

  const requiredFields = [
    'POS_API_BASE_URL',
    'POS_MENU_SOURCE_URL',
    'POS_SIZE_SOURCE_URL',
    'POS_ORDER_TYPE',
    'POS_PAYMENT_METHOD',
    'POS_TAG_NUMBER',
  ]
  const missing = requiredFields.filter((key) => !isTruthyValue(get(key)))
  const hasToken = isTruthyValue(get('POS_API_TOKEN'))
  const hasCredentialLogin =
    isTruthyValue(get('POS_API_USERNAME')) &&
    isTruthyValue(get('POS_API_PASSWORD')) &&
    isTruthyValue(get('POS_AUTH_LOGIN_URL'))
  const hasStoreProfileMap = isTruthyValue(get('POS_STORE_PROFILE_MAP_JSON'))
  if (!hasToken && !hasCredentialLogin && !hasStoreProfileMap) {
    missing.push('POS_API_TOKEN or POS_API_USERNAME/POS_API_PASSWORD/POS_AUTH_LOGIN_URL or POS_STORE_PROFILE_MAP_JSON')
  }
  if (missing.length > 0) {
    return `Live POS mode missing required config: ${missing.join(', ')}`
  }
  return null
}

function normalizeFieldsForPersistence(fields: EnvField[]): EnvField[] {
  const mode = getFieldValue(fields, 'POS_MENU_SOURCE_MODE', 'remote_strict').trim().toLowerCase()
  const coreApi = normalizeApiBaseUrl(getFieldValue(fields, 'VITE_CORE_API_URL', getCoreApiUrl()))
  const canonicalMenuUrl = `${coreApi}/menu`
  const canonicalOrdersUrl = `${coreApi}/orders`
  const posApiBase = normalizeApiBaseUrl(getFieldValue(fields, 'POS_API_BASE_URL', ''))
  const canonicalPosLoginUrl = posApiBase ? `${posApiBase}/auth/login` : ''
  const canonicalPosRefreshUrl = posApiBase ? `${posApiBase}/auth/refresh` : ''
  const posSizeSourceUrl = getFieldValue(fields, 'POS_SIZE_SOURCE_URL', '').trim()
  const posDefaultSizeName = getFieldValue(fields, 'POS_DEFAULT_SIZE_NAME', '').trim()
  const canonicalMenuSourceUrl = posApiBase
    ? `${posApiBase}/product-availability/filter?storeId={storeId}&page=0&size=1000&sort=`
    : ''
  const canonicalSizeSourceUrl = posApiBase
    ? `${posApiBase}/product-size/filter?productId={productId}&page=0&size=10&sort=`
    : ''
  const normalizeTaxPercent = (raw: string) => {
    const parsed = Number.parseFloat(String(raw || '').trim())
    if (!Number.isFinite(parsed)) return '10'
    const clamped = Math.max(0, Math.min(100, parsed))
    return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(2).replace(/\.?0+$/, '')
  }
  return fields.map((field) => {
    if (field.key === 'POS_MENU_SOURCE_MODE') {
      const nextMode = mode === 'local' ? 'local' : 'remote_strict'
      return field.value === nextMode ? field : { ...field, value: nextMode }
    }
    if (field.key === 'VITE_MENU_API_URL' && mode === 'remote_strict' && canonicalMenuUrl) {
      return field.value === canonicalMenuUrl ? field : { ...field, value: canonicalMenuUrl }
    }
    if (field.key === 'VITE_ORDERS_API_URL' && canonicalOrdersUrl) {
      return field.value === canonicalOrdersUrl ? field : { ...field, value: canonicalOrdersUrl }
    }
    if (field.key === 'POS_MENU_SOURCE_URL' && canonicalMenuSourceUrl) {
      return field.value === canonicalMenuSourceUrl
        ? field
        : { ...field, value: canonicalMenuSourceUrl }
    }
    if (field.key === 'POS_AUTH_LOGIN_URL' && canonicalPosLoginUrl) {
      return field.value === canonicalPosLoginUrl ? field : { ...field, value: canonicalPosLoginUrl }
    }
    if (field.key === 'POS_AUTH_REFRESH_URL' && canonicalPosRefreshUrl) {
      return field.value === canonicalPosRefreshUrl ? field : { ...field, value: canonicalPosRefreshUrl }
    }
    if (field.key === 'POS_SIZE_SOURCE_URL' && canonicalSizeSourceUrl) {
      return field.value === canonicalSizeSourceUrl
        ? field
        : { ...field, value: canonicalSizeSourceUrl }
    }
    if (field.key === 'VITE_PRODUCT_SIZE_API_URL' && posSizeSourceUrl) {
      return field.value === posSizeSourceUrl ? field : { ...field, value: posSizeSourceUrl }
    }
    if (field.key === 'VITE_PRODUCT_DEFAULT_SIZE_NAME' && posDefaultSizeName) {
      return field.value === posDefaultSizeName ? field : { ...field, value: posDefaultSizeName }
    }
    if (field.key === 'VITE_TAX_PERCENT') {
      const nextTax = normalizeTaxPercent(field.value)
      return field.value === nextTax ? field : { ...field, value: nextTax }
    }
    return field
  })
}

function formatSyncTime(updatedAt: number | null, uiLanguage: UiLanguage): string {
  if (!updatedAt) {
    return uiLanguage === 'vi' ? 'No sync yet' : 'No sync yet'
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

function normalizeLooseText(value: string): string {
  return toSingleLine(String(value || ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function resolveVieneuVoiceId(
  rawVoiceId: string,
  voices: Array<{ id: string; description: string }>,
): { id: string; source: 'id' | 'description' | 'fuzzy' } | null {
  const normalizedRaw = toSingleLine(rawVoiceId)
  if (!normalizedRaw) {
    return null
  }
  const strict = voices.find((voice) => toSingleLine(voice.id) === normalizedRaw)
  if (strict) {
    return { id: strict.id, source: 'id' }
  }

  const target = normalizeLooseText(normalizedRaw)
  if (!target) {
    return null
  }
  const byDescription = voices.find(
    (voice) => normalizeLooseText(voice.description) === target,
  )
  if (byDescription) {
    return { id: byDescription.id, source: 'description' }
  }

  const byContains = voices.find((voice) => {
    const idNorm = normalizeLooseText(voice.id)
    const descNorm = normalizeLooseText(voice.description)
    return (
      idNorm.includes(target) ||
      target.includes(idNorm) ||
      descNorm.includes(target) ||
      target.includes(descNorm)
    )
  })
  if (byContains) {
    return { id: byContains.id, source: 'fuzzy' }
  }
  return null
}

function isCpuDependencyReady(version: string): boolean {
  const normalized = String(version || '').trim().toLowerCase()
  return normalized.length > 0 && normalized !== 'not-installed' && normalized !== 'unknown'
}

function getCapabilitiesFromOpenApi(payload: unknown): VieneuBackendCapabilities {
  const paths = (payload as { paths?: Record<string, unknown> } | null)?.paths ?? {}
  return {
    voices: Boolean(paths['/speech/vieneu/voices']),
    diag: Boolean(paths['/speech/vieneu/diag']),
    prewarm: Boolean(paths['/speech/vieneu/prewarm']),
    install: Boolean(paths['/speech/vieneu/install']),
    synth: Boolean(paths['/speech/synthesize']),
  }
}

export default function AdminPage({ onLogout }: AdminPageProps) {
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() => loadAdminUiLanguage())
  const [activeTab, setActiveTab] = useState<AdminTab>('overview')
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false)
  const [showAdvancedVoiceTools, setShowAdvancedVoiceTools] = useState(false)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [envSyncState, setEnvSyncState] = useState<EnvSyncState>({
    status: 'idle',
    detail: '',
    apiBase: '',
  })
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(() => getAdminConfigUpdatedAt())
  const [micState, setMicState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [micDetail, setMicDetail] = useState(() =>
    loadAdminUiLanguage() === 'vi' ? 'Microphone not checked yet' : 'Microphone has not been checked',
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
  const [ttsRate, setTtsRate] = useState(() => getSavedEnvFieldValue('TTS_RATE', '185'))
  const [vieneuModelPath, setVieneuModelPath] = useState(() =>
    getSavedEnvFieldValue('TTS_VIENEU_MODEL_PATH', 'pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF'),
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
  const [vieneuPrewarmState, setVieneuPrewarmState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [vieneuDiagState, setVieneuDiagState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [vieneuDiagnostics, setVieneuDiagnostics] = useState<VieneuDiagnostics | null>(null)
  const [vieneuBackendState, setVieneuBackendState] = useState<{
    activeApiBase: string
    tried: string[]
    capabilities: VieneuBackendCapabilities
    status: 'idle' | 'checking' | 'connected' | 'offline'
    detail: string
  }>({
    activeApiBase: '',
    tried: [],
    capabilities: { voices: false, diag: false, prewarm: false, install: false, synth: false },
    status: 'idle',
    detail: '',
  })
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
      ? 'Hello! I am your ordering robot. What would you like today?'
      : 'Hello! I am your ordering robot. What would you like today?',
  )
  const [ttsTestStatus, setTtsTestStatus] = useState<'idle' | 'playing' | 'error'>('idle')
  const [ttsApplyStatus, setTtsApplyStatus] = useState<TtsApplyStatus>('idle')
  const hasHydratedEnvRef = useRef(false)
  const hasLoadedEnvFileRef = useRef(false)
  const envAutoSaveTimerRef = useRef<number | null>(null)
  const speechLang = uiLanguage === 'vi' ? 'vi-VN' : 'en-US'
  const t = useCallback(
    (_vi: string, en: string) => en,
    [],
  )
  const liveCaption = useLiveCaption({ lang: speechLang })

  const envFieldMap = useMemo(
    () => Object.fromEntries(envFields.map((field) => [field.key, normalizeEnvValue(field.key, field.value)])),
    [envFields],
  )

  const currentCoreApiUrl = envFieldMap.VITE_CORE_API_URL || getCoreApiUrl()
  const currentAiApiUrl = envFieldMap.VITE_AI_API_URL || getAiApiUrl()
  const currentMenuApiUrl = envFieldMap.VITE_MENU_API_URL || getMenuApiUrl()
  const browserSafeMenuApiUrl = resolveBrowserSafeMenuApiUrl(currentMenuApiUrl, currentCoreApiUrl)
  const currentOrdersApiUrl = envFieldMap.VITE_ORDERS_API_URL || getOrdersApiUrl()
  const livePosMode = (envFieldMap.POS_MENU_SOURCE_MODE || 'remote_strict').trim().toLowerCase()
  const livePosEnabled = livePosMode === 'remote_strict'
  const livePosAuthConfigured = Boolean(
    (envFieldMap.POS_API_TOKEN || '').trim() ||
      (
        (envFieldMap.POS_API_USERNAME || '').trim() &&
        (envFieldMap.POS_API_PASSWORD || '').trim() &&
        (envFieldMap.POS_AUTH_LOGIN_URL || '').trim()
      ) ||
      (envFieldMap.POS_STORE_PROFILE_MAP_JSON || '').trim(),
  )
  const livePosValidationError = useMemo(() => validateLivePosConfig(envFields), [envFields])

  const serviceTargets = useMemo(
    () => [
      { name: 'Core Backend', url: `${currentCoreApiUrl}/health` },
      { name: 'AI Backend', url: `${currentAiApiUrl}/health` },
      { name: 'Menu API', url: browserSafeMenuApiUrl },
      { name: 'Orders API', url: `${currentOrdersApiUrl}?limit=1` },
      { name: 'POS Contract', url: `${currentCoreApiUrl}/pos/contract-check` },
    ],
    [browserSafeMenuApiUrl, currentAiApiUrl, currentCoreApiUrl, currentOrdersApiUrl],
  )

  const [services, setServices] = useState<ServiceStatus[]>(
    serviceTargets.map((target) => ({
      name: target.name,
      url: target.url,
      status: 'idle',
      latencyMs: null,
      detail: uiLanguage === 'vi' ? 'Not checked yet' : 'Not checked yet',
    })),
  )

  const { listening, interimTranscript, recognitionSupported, startListening, stopListening } = useSpeech({
    lang: speechLang,
    onTranscript: (transcript) => {
      setSttFinalText(transcript)
      setMicState('ok')
      setMicDetail('STT d? nh?n transcript')
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
    () =>
      envFields.filter(
        (field) => ESSENTIAL_ENV_KEYS.has(field.key) && !HIDDEN_ADMIN_ENV_KEYS.has(field.key),
      ),
    [envFields],
  )
  const advancedFields = useMemo(
    () =>
      envFields.filter(
        (field) =>
          !ESSENTIAL_ENV_KEYS.has(field.key) &&
          !HIDDEN_ADMIN_ENV_KEYS.has(field.key) &&
          field.key !== 'VOICE_ALWAYS_LISTEN',
      ),
    [envFields],
  )

  const envText = useMemo(
    () =>
      envFields
        .filter((field) => !HIDDEN_ADMIN_ENV_KEYS.has(field.key))
        .map((field) => `${field.key}=${normalizeEnvValue(field.key, field.value)}`)
        .join('\n'),
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
  const resolvedVieneuVoice = useMemo(
    () => resolveVieneuVoiceId(normalizedVieneuVoiceId, vieneuVoices),
    [normalizedVieneuVoiceId, vieneuVoices],
  )
  const hasCustomVieneuVoiceId =
    normalizedVieneuVoiceId.length > 0 && resolvedVieneuVoice === null
  const cpuDependencies = useMemo(
    () =>
      Object.entries(vieneuDiagnostics?.cpu_processing || {}).map(([name, version]) => ({
        name,
        label: CPU_DEPENDENCY_LABELS[name] || name,
        version: String(version || 'unknown'),
        ready: isCpuDependencyReady(String(version || 'unknown')),
      })),
    [vieneuDiagnostics],
  )
  const missingCpuDependencies = cpuDependencies.filter((item) => !item.ready)
  const cpuDepsByName = useMemo(
    () => Object.fromEntries(cpuDependencies.map((item) => [item.name, item])) as Record<string, { ready: boolean; version: string; label: string; name: string }>,
    [cpuDependencies],
  )
  const configuredVieneuMode = toSingleLine(getFieldValue(envFields, 'TTS_VIENEU_MODE', 'turbo')).toLowerCase()
  const configuredBackboneDevice = toSingleLine(getFieldValue(envFields, 'TTS_VIENEU_BACKBONE_DEVICE', 'cpu')).toLowerCase()
  const configuredCodecDevice = toSingleLine(getFieldValue(envFields, 'TTS_VIENEU_CODEC_DEVICE', 'cpu')).toLowerCase()
  const normalizedConfiguredModelPath = toSingleLine(vieneuModelPath)
  const normalizedRuntimeModelPath = toSingleLine(String(vieneuDiagnostics?.model_path || ''))
  const runtimeModelMatchesConfigured =
    normalizedConfiguredModelPath.length > 0 &&
    normalizedRuntimeModelPath.length > 0 &&
    normalizedConfiguredModelPath.toLowerCase() === normalizedRuntimeModelPath.toLowerCase()
  const runtimeModelLoaded =
    Boolean(vieneuDiagnostics?.instance_ready) &&
    normalizedRuntimeModelPath.length > 0
  const onnxPackageReady =
    Boolean(cpuDepsByName['onnxruntime']?.ready) &&
    Boolean(cpuDepsByName['torch']?.ready) &&
    Boolean(cpuDepsByName['llama-cpp-python']?.ready) &&
    Boolean(cpuDepsByName['vieneu']?.ready)
  const onnxProfileSelected =
    ttsEngine === 'vieneu' &&
    (configuredVieneuMode === 'standard' || configuredVieneuMode === 'turbo') &&
    configuredBackboneDevice === 'cpu' &&
    configuredCodecDevice === 'cpu'
  const onnxRecommendedModel =
    normalizedConfiguredModelPath.toLowerCase().includes('vieneu-tts-0.3b-q4-gguf') ||
    normalizedConfiguredModelPath.toLowerCase().includes('vieneu-tts-v2-turbo-gguf')
  const onnxReadyForRun = onnxPackageReady && onnxProfileSelected && onnxRecommendedModel
  const voiceActionStatus = useMemo(() => {
    if (ttsEngine !== 'vieneu') {
      return ''
    }
    if (vieneuPrewarmState === 'loading') {
      return t('?ang t?i/kh?i t?o model VieNeu...', 'Prewarming VieNeu model...')
    }
    if (vieneuInstallState === 'installing') {
      return t('?ang c?i CPU dependencies...', 'Installing CPU dependencies...')
    }
    if (vieneuDiagState === 'loading') {
      return t('?ang ki?m tra runtime...', 'Checking runtime...')
    }
    if (vieneuPrewarmState === 'error' || vieneuInstallState === 'error' || vieneuDiagState === 'error') {
      return t('C? l?i ? thao t?c g?n nh?t. Xem th?ng b?o l?i ph?a tr?n.', 'Last action failed. Check the error notice above.')
    }
    return t('S?n s?ng thao t?c VieNeu.', 'VieNeu actions ready.')
  }, [t, ttsEngine, vieneuDiagState, vieneuInstallState, vieneuPrewarmState])
  const hasConnectedVieneuBackend = vieneuBackendState.status === 'connected'
  const canLoadVoices = hasConnectedVieneuBackend && vieneuBackendState.capabilities.voices
  const canCheckDiag = hasConnectedVieneuBackend && vieneuBackendState.capabilities.diag
  const canInstallDeps = hasConnectedVieneuBackend && vieneuBackendState.capabilities.install
  const canPrewarm =
    hasConnectedVieneuBackend &&
    (vieneuBackendState.capabilities.prewarm || vieneuBackendState.capabilities.synth)

  const isHealthChecking = services.some((service) => service.status === 'checking')

  useEffect(() => {
    if (ttsEngine !== 'vieneu') {
      return
    }
    if (vieneuVoices.length === 0) {
      return
    }
    if (!normalizedVieneuVoiceId) {
      return
    }
    if (!resolvedVieneuVoice) {
      return
    }
    if (resolvedVieneuVoice.id !== normalizedVieneuVoiceId) {
      setVieneuVoiceId(resolvedVieneuVoice.id)
    }
  }, [
    normalizedVieneuVoiceId,
    resolvedVieneuVoice,
    ttsEngine,
    vieneuVoices.length,
  ])

  useEffect(() => {
    localStorage.setItem(ADMIN_UI_LANGUAGE_KEY, uiLanguage)
  }, [uiLanguage])

  useEffect(() => {
    setSttPartialText(interimTranscript)
    if (interimTranscript.trim()) {
      setMicState('ok')
      setMicDetail('?ang nh?n partial transcript...')
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
    if (!hasHydratedEnvRef.current) {
      hasHydratedEnvRef.current = true
      return
    }
    if (livePosValidationError) {
      return
    }
    if (envAutoSaveTimerRef.current) {
      window.clearTimeout(envAutoSaveTimerRef.current)
    }
    envAutoSaveTimerRef.current = window.setTimeout(() => {
      const normalizedFields = normalizeFieldsForPersistence(envFields)
      const changed =
        normalizedFields.length !== envFields.length ||
        normalizedFields.some((field, index) => {
          const current = envFields[index]
          return !current || current.key !== field.key || current.value !== field.value
        })
      if (changed) {
        setEnvFields(normalizedFields)
      }
      saveAdminEnvConfig(toEnvPayload(normalizedFields))
      setLastSyncAt(getAdminConfigUpdatedAt())
      envAutoSaveTimerRef.current = null
    }, 260)

    return () => {
      if (envAutoSaveTimerRef.current) {
        window.clearTimeout(envAutoSaveTimerRef.current)
        envAutoSaveTimerRef.current = null
      }
    }
  }, [envFields, livePosValidationError])

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
            detail: uiLanguage === 'vi' ? 'Not checked yet' : 'Not checked yet',
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
              ? 'URL d? thay d?i, c?n ki?m tra l?i'
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

  const applyVoiceListenModeInstant = useCallback(
    (nextModeRaw: string) => {
      const nextMode: VoiceListenMode = nextModeRaw === 'sequential' ? 'sequential' : 'always'
      const nextFields = normalizeFieldsForPersistence(
        envFields.map((field) => {
          if (field.key === 'VOICE_LISTEN_MODE') {
            return { ...field, value: nextMode }
          }
          if (field.key === 'VOICE_ALWAYS_LISTEN') {
            return { ...field, value: nextMode === 'always' ? 'true' : 'false' }
          }
          return field
        }),
      )
      saveAdminEnvConfig(toEnvPayload(nextFields))
      setEnvFields(nextFields)
      setLastSyncAt(getAdminConfigUpdatedAt())
      setNotice({
        tone: 'info',
        text:
          nextMode === 'sequential'
            ? t(
                'Da ap dung ngay che do nghe theo luot (Sequential) cho kiosk.',
                'Sequential listen mode is now applied instantly on kiosk.',
              )
            : t(
                'Da ap dung ngay che do nghe lien tuc (Always) cho kiosk.',
                'Always listen mode is now applied instantly on kiosk.',
              ),
      })
    },
    [envFields, t],
  )

  const renderEnvFieldInput = useCallback(
    (field: EnvField, onFieldBlur: () => void) => {
      if (field.key === 'VOICE_LISTEN_MODE') {
        const modeValue = field.value === 'sequential' ? 'sequential' : 'always'
        return (
          <select
            value={modeValue}
            onChange={(event) => {
              const nextMode = event.target.value === 'sequential' ? 'sequential' : 'always'
              applyVoiceListenModeInstant(nextMode)
            }}
            onBlur={onFieldBlur}
          >
            {VOICE_LISTEN_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label[uiLanguage]}
              </option>
            ))}
          </select>
        )
      }
      if (field.key === 'POS_MENU_SOURCE_MODE') {
        const modeValue = field.value === 'local' ? 'local' : 'remote_strict'
        return (
          <select
            value={modeValue}
            onChange={(event) => {
              const nextMode = event.target.value === 'local' ? 'local' : 'remote_strict'
              setFieldValue('POS_MENU_SOURCE_MODE', nextMode)
              if (nextMode === 'remote_strict') {
                const normalizedCoreUrl = normalizeApiBaseUrl(
                  getFieldValue(envFields, 'VITE_CORE_API_URL', getCoreApiUrl()),
                )
                if (normalizedCoreUrl) {
                  setFieldValue('VITE_MENU_API_URL', `${normalizedCoreUrl}/menu`)
                }
              }
            }}
            onBlur={onFieldBlur}
          >
            {POS_MENU_SOURCE_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )
      }
      if (field.key === 'STT_MODEL') {
        const hasKnownOption = STT_MODEL_OPTIONS.some((option) => option.value === field.value)
        return (
          <select
            value={hasKnownOption ? field.value : '__custom__'}
            onChange={(event) => {
              const nextValue = event.target.value
              if (nextValue === '__custom__') return
              setFieldValue(field.key, nextValue)
            }}
            onBlur={onFieldBlur}
          >
            {STT_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!hasKnownOption ? (
              <option value="__custom__">{`custom: ${field.value || '(empty)'}`}</option>
            ) : null}
          </select>
        )
      }
      return (
        <input
          value={field.value}
          onChange={(event) => setFieldValue(field.key, event.target.value)}
          onBlur={onFieldBlur}
        />
      )
    },
    [applyVoiceListenModeInstant, envFields, uiLanguage],
  )

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
      setFieldValue('TTS_VIENEU_MODE', profile.vieneuMode)
      setFieldValue('TTS_VIENEU_BACKBONE_DEVICE', profile.backboneDevice)
      setFieldValue('TTS_VIENEU_CODEC_REPO', profile.codecRepo)
      setFieldValue('TTS_VIENEU_CODEC_DEVICE', profile.codecDevice)
      setFieldValue('TTS_VIENEU_STREAM_FRAMES_PER_CHUNK', '25')
      setFieldValue('TTS_VIENEU_STREAM_LOOKFORWARD', '10')
      setFieldValue('TTS_VIENEU_STREAM_LOOKBACK', '100')
      setFieldValue('TTS_VIENEU_STREAM_OVERLAP_FRAMES', '1')
      const tunedTopK = '50'
      const tunedMaxChars = '256'
      setVieneuTemperature('1.0')
      setFieldValue('TTS_VIENEU_TEMPERATURE', '1.0')
      setVieneuTopK(tunedTopK)
      setFieldValue('TTS_VIENEU_TOP_K', tunedTopK)
      setVieneuMaxChars(tunedMaxChars)
      setFieldValue('TTS_VIENEU_MAX_CHARS', tunedMaxChars)
      setFieldValue('STT_MODEL', profile.sttModel)
      setFieldValue('STT_DEVICE', profile.sttDevice)
      setFieldValue('STT_COMPUTE_TYPE', profile.sttComputeType)
      setFieldValue('STT_BEAM_SIZE', '5')
      setFieldValue('STT_BEST_OF', '3')
      setFieldValue('STT_PARTIAL_BEAM_SIZE', '1')
      setFieldValue('STT_PARTIAL_BEST_OF', '1')
      setFieldValue('BACKEND_STT_CHUNK_MS', '120')
      setFieldValue('BACKEND_STT_FINALIZE_SILENCE_MS', '420')
      setFieldValue('BACKEND_STT_FORCE_FINALIZE_MS', '1400')
      setFieldValue('SUBMIT_SILENCE_MS', '1200')
      setFieldValue('VOICE_LISTEN_MODE', 'always')
      setFieldValue('VOICE_ALWAYS_LISTEN', 'true')
      setFieldValue('VOICE_TTS_WS_REALTIME', 'true')
      setFieldValue('CHAT_CLEAR_AFTER_ABSENCE_MS', '0')
      setFieldValue('CHAT_CLEAR_ON_ORDER_COMPLETE', 'false')
      setTtsRate('185')
      setFieldValue('TTS_RATE', '185')
      setFieldValue('TTS_STREAM_PLAYBACK_RATE', '1.15')
      setNotice({
        tone: 'info',
        text: t(
          `?? ?p preset ${profile.label.vi}. Nh? b?m "?p d?ng v?o backend".`,
          `Preset ${profile.label.en} applied. Click "Apply To Backend" to activate.`,
        ),
      })
    },
    [setFieldValue, t],
  )

  const applyCpuOnnxPreset = useCallback(() => {
    applyVieneuRealtimeProfile('cpu_realtime')
    setNotice({
      tone: 'info',
      text: t(
        '?? di?n c?u h?nh ONNX CPU chu?n. B?m "?p d?ng v?o backend" d? k?ch ho?t ngay.',
        'ONNX CPU preset is filled. Click "Apply To Backend" to activate now.',
      ),
    })
  }, [applyVieneuRealtimeProfile, t])

  const checkService = useCallback(async (service: ServiceStatus): Promise<ServiceStatus> => {
    const startedAt = performance.now()
    try {
      const response = await fetch(service.url, { method: 'GET' })
      const latencyMs = Math.round(performance.now() - startedAt)
      let responsePayload: unknown = null
      let responseMessage = ''
      try {
        responsePayload = await response.json()
      } catch {
        responsePayload = null
      }
      if (
        responsePayload &&
        typeof responsePayload === 'object' &&
        'ok' in responsePayload &&
        (responsePayload as { ok?: boolean }).ok === false
      ) {
        const detail = (responsePayload as { detail?: string }).detail || ''
        throw new Error(detail || 'contract-check-failed')
      }
      if (!response.ok) {
        if (responsePayload && typeof responsePayload === 'object') {
          const detailField = (responsePayload as { detail?: unknown }).detail
          if (typeof detailField === 'string' && detailField.trim()) {
            responseMessage = detailField.trim()
          } else if (detailField && typeof detailField === 'object') {
            const detailObj = detailField as { message?: string; checks?: unknown }
            if (typeof detailObj.message === 'string' && detailObj.message.trim()) {
              responseMessage = detailObj.message.trim()
            } else if (detailObj.checks && typeof detailObj.checks === 'object') {
              const checksText = Object.entries(detailObj.checks as Record<string, { detail?: string; ok?: boolean }>)
                .filter(([, value]) => value?.ok === false)
                .map(([key, value]) => `${key}: ${String(value?.detail || 'failed')}`)
                .join(' | ')
              responseMessage = checksText
            }
          }
        }
        throw new Error(responseMessage || `HTTP ${response.status}`)
      }
      return {
        ...service,
        status: 'ok',
        latencyMs,
        detail:
          responsePayload && typeof responsePayload === 'object' && 'checks' in responsePayload
            ? (uiLanguage === 'vi' ? 'Contract h?p l?' : 'Contract valid')
            : uiLanguage === 'vi'
              ? 'Online'
              : 'Online',
      }
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt)
      return {
        ...service,
        status: 'error',
        latencyMs,
        detail: error instanceof Error ? error.message : uiLanguage === 'vi' ? 'L?i kh?ng r?' : 'Unknown error',
      }
    }
  }, [uiLanguage])

  const runHealthChecks = useCallback(async () => {
    const checkingList = services.map((service) => ({
      ...service,
      status: 'checking' as const,
      detail: uiLanguage === 'vi' ? '?ang ki?m tra...' : 'Checking...',
    }))
    setServices(checkingList)
    const checked = await Promise.all(checkingList.map((service) => checkService(service)))
    setServices(checked)
  }, [checkService, services, uiLanguage])

  const loadEnvFromFile = useCallback(async () => {
    const keys = ENV_TEMPLATE.map((field) => field.key)
    const candidates = getAiApiCandidates(currentAiApiUrl)
    let lastError = ''

    for (const apiBase of candidates) {
      try {
        const response = await fetch(`${apiBase}/config/env/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys }),
        })
        const payload = (await response.json().catch(() => null)) as
          | { detail?: unknown; fields?: Record<string, string> }
          | null
        if (!response.ok) {
          const detail = typeof payload?.detail === 'string' ? payload.detail.trim() : ''
          throw new Error(detail || `HTTP ${response.status}`)
        }
        const loadedFields = payload?.fields && typeof payload.fields === 'object' ? payload.fields : {}
        setEnvFields((current) => {
          const nextFields = current.map((field) => {
            if (!(field.key in loadedFields)) {
              return field
            }
            const nextValue = normalizeEnvValue(field.key, String(loadedFields[field.key] ?? ''))
            return nextValue === field.value ? field : { ...field, value: nextValue }
          })
          saveAdminEnvConfig(toEnvPayload(nextFields))
          return nextFields
        })
        setLastSyncAt(getAdminConfigUpdatedAt())
        setNotice({
          tone: 'info',
          text: t('Da nap cau hinh tu file .env', 'Loaded configuration from .env'),
        })
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'unknown'
      }
    }

    setNotice({
      tone: 'warning',
      text: t(
        `Khong the nap .env tu backend: ${lastError || 'unknown error'}`,
        `Cannot load .env from backend: ${lastError || 'unknown error'}`,
      ),
    })
  }, [currentAiApiUrl, t])

  useEffect(() => {
    if (hasLoadedEnvFileRef.current) {
      return
    }
    hasLoadedEnvFileRef.current = true
    void loadEnvFromFile()
  }, [loadEnvFromFile])

  const saveAndSyncConfig = useCallback(
    async (fields: EnvField[], successText: string) => {
      const validationError = validateLivePosConfig(fields)
      // Keep sync non-blocking: still persist ENV so user can save partial config
      // and continue filling required POS fields afterward.
      if (validationError) {
        setNotice({
          tone: 'warning',
          text: validationError,
        })
      }

      const normalizedFields = normalizeFieldsForPersistence(fields)
      const envPayload = toEnvPayload(normalizedFields)
      saveAdminEnvConfig(envPayload)
      setEnvFields(normalizedFields)
      setLastSyncAt(getAdminConfigUpdatedAt())

      const preferredAiUrl = getFieldValue(normalizedFields, 'VITE_AI_API_URL', currentAiApiUrl)
      const candidates = getAiApiCandidates(preferredAiUrl)
      setEnvSyncState({
        status: 'saving',
        detail: t('Dang ghi file .env...', 'Persisting .env file...'),
        apiBase: candidates[0] || '',
      })

      let syncedApiBase = ''
      let syncErrorMessage = ''
      for (const apiBase of candidates) {
        try {
          const response = await fetch(`${apiBase}/config/env/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: envPayload }),
          })
          const payload = (await response.json().catch(() => null)) as
            | { detail?: unknown; env_path?: string }
            | null
          if (!response.ok) {
            const detail = typeof payload?.detail === 'string' ? payload.detail.trim() : ''
            throw new Error(detail || `HTTP ${response.status}`)
          }
          syncedApiBase = apiBase
          setEnvSyncState({
            status: 'ok',
            detail: t('Da ghi .env thanh cong.', '.env persisted successfully.'),
            apiBase,
          })
          break
        } catch (error) {
          syncErrorMessage = error instanceof Error ? error.message : 'unknown'
        }
      }

      if (!syncedApiBase) {
        setEnvSyncState({
          status: 'error',
          detail: syncErrorMessage || t('Khong the ghi .env', 'Cannot persist .env'),
          apiBase: '',
        })
        setNotice({
          tone: 'warning',
          text: t(
            `Da dong bo index ngay, nhung chua ghi duoc .env: ${syncErrorMessage || 'unknown error'}`,
            `Index synced immediately, but failed to persist .env: ${syncErrorMessage || 'unknown error'}`,
          ),
        })
        return
      }

      const preferredCoreUrl = getFieldValue(normalizedFields, 'VITE_CORE_API_URL', getCoreApiUrl())
      const coreReloadCandidates = getCoreReloadCandidates(preferredCoreUrl)
      let coreReloadApiBase = ''
      let coreReloadErrorMessage = ''
      for (const apiBase of coreReloadCandidates) {
        try {
          const response = await fetch(`${apiBase}/config/reload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
          const payload = (await response.json().catch(() => null)) as
            | { detail?: unknown; pos_store_id?: unknown }
            | null
          if (!response.ok) {
            const detail = typeof payload?.detail === 'string' ? payload.detail.trim() : ''
            throw new Error(detail || `HTTP ${response.status}`)
          }
          coreReloadApiBase = apiBase
          break
        } catch (error) {
          coreReloadErrorMessage = error instanceof Error ? error.message : 'unknown'
        }
      }

      if (!coreReloadApiBase) {
        setNotice({
          tone: 'warning',
          text: t(
            `Da ghi .env, nhung core backend chua nap lai cau hinh moi: ${coreReloadErrorMessage || 'unknown error'}`,
            `Saved .env, but core backend did not reload the new config: ${coreReloadErrorMessage || 'unknown error'}`,
          ),
        })
        return
      }

      setNotice({
        tone: 'success',
        text: `${successText} ${t(`(.env da ghi qua ${syncedApiBase}; core reload qua ${coreReloadApiBase})`, `(.env persisted via ${syncedApiBase}; core reloaded via ${coreReloadApiBase})`)}`,
      })
    },
    [currentAiApiUrl, t],
  )

  const handleSaveConfig = useCallback(async () => {
    await saveAndSyncConfig(
      envFields,
      t(
        '?? luu c?u h?nh. Trang kiosk index s? nh?n ngay.',
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
        text: showAdvancedConfig ? t('?? copy full .env', 'Full .env copied') : t('?? copy .env v?i nh?m c?u h?nh thi?t y?u', 'Essential .env block copied'),
      })
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Kh?ng th? copy .env', 'Cannot copy .env'),
      })
    }
  }, [envText, essentialEnvText, showAdvancedConfig, t])

  const refreshVieneuBackendState = useCallback(async () => {
    if (ttsEngine !== 'vieneu') {
      setVieneuBackendState({
        activeApiBase: '',
        tried: [],
        capabilities: { voices: false, diag: false, prewarm: false, install: false, synth: false },
        status: 'idle',
        detail: '',
      })
      return
    }

    const candidates = getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
    setVieneuBackendState((prev) => ({
      ...prev,
      status: 'checking',
      tried: candidates,
      detail: '',
    }))

    let lastError = ''
    for (const apiBase of candidates) {
      try {
        const healthResponse = await fetch(`${apiBase}/health`, { method: 'GET' })
        if (!healthResponse.ok) {
          throw new Error(`health HTTP ${healthResponse.status}`)
        }
        let capabilities: VieneuBackendCapabilities = {
          voices: false,
          diag: false,
          prewarm: false,
          install: false,
          synth: false,
        }
        try {
          const openApiResponse = await fetch(`${apiBase}/openapi.json`, { method: 'GET' })
          if (openApiResponse.ok) {
            const openApiPayload = (await openApiResponse.json()) as unknown
            capabilities = getCapabilitiesFromOpenApi(openApiPayload)
          }
        } catch {
          // keep fallback false flags if openapi probing fails
        }

        setResolvedVieneuApiBase(apiBase)
        setVieneuBackendState({
          activeApiBase: apiBase,
          tried: candidates,
          capabilities,
          status: 'connected',
          detail: capabilities.prewarm
            ? t('Backend h? tr? prewarm tr?c ti?p.', 'Backend supports direct prewarm.')
            : t('Backend kh?ng c? prewarm route, s? d?ng warmup fallback.', 'Backend has no prewarm route, fallback warmup will be used.'),
        })
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    setVieneuBackendState({
      activeApiBase: '',
      tried: candidates,
      capabilities: { voices: false, diag: false, prewarm: false, install: false, synth: false },
      status: 'offline',
      detail: t(
        `Kh?ng k?t n?i du?c backend VieNeu. L?i cu?i: ${lastError || 'unknown'}`,
        `Cannot connect to VieNeu backend. Last error: ${lastError || 'unknown'}`,
      ),
    })
  }, [currentAiApiUrl, resolvedVieneuApiBase, t, ttsEngine])

  const loadVieneuVoices = useCallback(
    async (showSuccessNotice = true) => {
      if (ttsEngine !== 'vieneu') {
        setVieneuVoices([])
        setVieneuVoicesState('idle')
        return
      }

      setVieneuVoicesState('loading')
      try {
        const candidates = getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
        let successApiBase = ''
        let selectedVoices: Array<{ id: string; description: string }> = []
        let vieneuInstalled: boolean | undefined
        let lastError: Error | null = null

        for (const apiBase of candidates) {
          try {
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
                  `Backend reachable but voices endpoint error (${nextResponse.status}) t?i ${apiBase}/speech/vieneu/voices`,
                  `Backend reachable but voices endpoint error (${nextResponse.status}) at ${apiBase}/speech/vieneu/voices`,
                ),
              )
            }
            const payload = (await nextResponse.json()) as {
              vieneu_installed?: boolean
              voices?: Array<{ id?: string; description?: string }>
            }
            selectedVoices = Array.isArray(payload.voices)
              ? payload.voices
                  .map((item) => ({
                    id: String(item.id || '').trim(),
                    description: String(item.description || '').trim(),
                  }))
                  .filter((item) => item.id.length > 0)
              : []
            vieneuInstalled = payload.vieneu_installed
            successApiBase = apiBase
            break
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
          }
        }

        if (!successApiBase) {
          throw new Error(
            t(
              `Kh?ng t?i du?c voices. ?? th?: ${candidates.join(', ')}. L?i cu?i: ${lastError?.message ?? 'unknown'}`,
              `Cannot load voices. Tried: ${candidates.join(', ')}. Last error: ${lastError?.message ?? 'unknown'}`,
            ),
          )
        }

        setVieneuVoices(selectedVoices)
        setResolvedVieneuApiBase(successApiBase)
        setVieneuVoicesState('ready')
        if (showSuccessNotice) {
          if (vieneuInstalled === false) {
            setNotice({
              tone: 'warning',
              text: t(
                'Backend chua c?i vieneu. C?i package vieneu tru?c khi d?ng preset voice.',
                'The backend does not have vieneu installed yet. Install vieneu before using preset voices.',
              ),
            })
            return
          }
          if (selectedVoices.length === 0) {
            setNotice({
              tone: 'warning',
              text: t(
                '?? k?t n?i VieNeu nhung endpoint n?y chua tr? preset voice. Th? d?i model/preset trong backend r?i t?i l?i.',
                'Connected to VieNeu but this endpoint returned no preset voices. Try switching model/runtime and reload voices.',
              ),
            })
            return
          }
          setNotice({
            tone: 'info',
            text: t(
              `Voices loaded from ${successApiBase}: ${selectedVoices.length} giong VieNeu.`,
              `Voices loaded from ${successApiBase}: ${selectedVoices.length} VieNeu presets.`,
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
                  : t('Kh?ng th? t?i danh s?ch voice VieNeu.', 'Cannot load VieNeu voice list.')),
          })
        }
      }
    },
    [currentAiApiUrl, resolvedVieneuApiBase, t, ttsEngine],
  )

  const loadVieneuDiagnostics = useCallback(
    async (showSuccessNotice = true) => {
      if (ttsEngine !== 'vieneu') {
        setVieneuDiagState('idle')
        setVieneuDiagnostics(null)
        return
      }

      setVieneuDiagState('loading')
      try {
        const candidates = getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
        let lastError: Error | null = null
        let success = false
        for (const apiBase of candidates) {
          try {
            const response = await fetch(`${apiBase}/speech/vieneu/diag`, { method: 'GET' })
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`)
            }
            const payload = (await response.json()) as { diag?: VieneuDiagnostics }
            const diag = payload.diag ?? {}
            setVieneuDiagnostics(diag)
            setVieneuDiagState('ready')
            setResolvedVieneuApiBase(apiBase)
            success = true
            break
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
          }
        }
        if (!success) {
          throw new Error(
            t(
              `Kh?ng k?t n?i du?c endpoint ki?m tra VieNeu. ?? th?: ${candidates.join(', ')}. L?i cu?i: ${lastError?.message ?? 'unknown'}`,
              `Cannot reach VieNeu diagnostics endpoint. Tried: ${candidates.join(', ')}. Last error: ${lastError?.message ?? 'unknown'}`,
            ),
          )
        }
        if (showSuccessNotice) {
          setNotice({
            tone: 'info',
            text: t('?? c?p nh?t tr?ng th?i VieNeu runtime.', 'VieNeu runtime status refreshed.'),
          })
        }
      } catch (error) {
        setVieneuDiagState('error')
        if (showSuccessNotice) {
          setNotice({
            tone: 'warning',
            text: error instanceof Error ? error.message : t('Cannot check VieNeu runtime.', 'Cannot check VieNeu runtime.'),
          })
        }
      }
    },
    [currentAiApiUrl, resolvedVieneuApiBase, t, ttsEngine],
  )

  const prewarmVieneuModel = useCallback(async () => {
    if (ttsEngine !== 'vieneu') {
      return
    }
    setVieneuPrewarmState('loading')
    try {
      const candidates = getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
      let lastError: Error | null = null
      let successApiBase = ''
      let prewarmDiag: VieneuDiagnostics | null = null

      for (const apiBase of candidates) {
        try {
          const response = await fetch(`${apiBase}/speech/vieneu/prewarm`, {
            method: 'POST',
          })
          if (response.ok) {
            const payload = (await response.json()) as { diag?: VieneuDiagnostics }
            successApiBase = apiBase
            prewarmDiag = payload.diag ?? null
            break
          }
          if (response.status === 404) {
            // Fallback for older backends without prewarm endpoint:
            // trigger a tiny synth request to force lazy model init.
            const warmupResponse = await fetch(`${apiBase}/speech/synthesize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: 'xin chao',
                engine: 'vieneu',
              }),
            })
            if (warmupResponse.ok) {
              successApiBase = apiBase
              break
            }
            throw new Error(`Fallback warmup failed: HTTP ${warmupResponse.status}`)
          }
          let detail = `HTTP ${response.status}`
          try {
            const payload = (await response.json()) as { detail?: string }
            if (payload?.detail) {
              detail = payload.detail
            }
          } catch {
            // ignore response parse
          }
          throw new Error(detail)
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }

      if (!successApiBase) {
        throw new Error(
          t(
            `Kh?ng t?i du?c model t? giao di?n. ?? th?: ${candidates.join(', ')}. L?i cu?i: ${lastError?.message ?? 'unknown'}`,
            `Cannot prewarm model from UI. Tried: ${candidates.join(', ')}. Last error: ${lastError?.message ?? 'unknown'}`,
          ),
        )
      }

      setResolvedVieneuApiBase(successApiBase)
      if (prewarmDiag) {
        setVieneuDiagnostics(prewarmDiag)
        setVieneuDiagState('ready')
      } else {
        await loadVieneuDiagnostics(false)
      }
      await refreshVieneuBackendState()
      setVieneuPrewarmState('success')
      setNotice({
        tone: 'success',
        text: t(
          `?? t?i/kh?i t?o model VieNeu th?nh c?ng qua ${successApiBase}.`,
          `VieNeu model prewarmed successfully via ${successApiBase}.`,
        ),
      })
    } catch (error) {
      setVieneuPrewarmState('error')
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Kh?ng th? t?i model VieNeu.', 'Cannot prewarm VieNeu model.'),
      })
    } finally {
      window.setTimeout(() => {
        setVieneuPrewarmState('idle')
      }, 1800)
    }
  }, [currentAiApiUrl, loadVieneuDiagnostics, refreshVieneuBackendState, resolvedVieneuApiBase, t, ttsEngine])

  const installVieneuRuntime = useCallback(async () => {
    if (ttsEngine !== 'vieneu') {
      return
    }

    setVieneuInstallState('installing')
    try {
      const candidates = getAiApiCandidates(resolvedVieneuApiBase || currentAiApiUrl)
      let successApiBase = ''
      let installPayload: {
        vieneu_installed?: boolean
        already_installed?: boolean
      } | null = null
      let lastError: Error | null = null
      for (const apiBase of candidates) {
        try {
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
          installPayload = (await response.json()) as {
            vieneu_installed?: boolean
            already_installed?: boolean
          }
          successApiBase = apiBase
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (!successApiBase || !installPayload) {
        throw new Error(
          t(
            `Kh?ng k?t n?i du?c endpoint c?i VieNeu. ?? th?: ${candidates.join(', ')}. L?i cu?i: ${lastError?.message ?? 'unknown'}`,
            `Cannot reach VieNeu install endpoint. Tried: ${candidates.join(', ')}. Last error: ${lastError?.message ?? 'unknown'}`,
          ),
        )
      }
      setResolvedVieneuApiBase(successApiBase)

      if (installPayload.vieneu_installed !== true) {
        setVieneuInstallState('error')
        setNotice({
          tone: 'warning',
          text: t(
            '?? g?i c?i VieNeu nhung backend chua nh?n module. Th? restart AI backend.',
            'VieNeu install command finished but backend still cannot load module. Restart AI backend.',
          ),
        })
        return
      }

      setVieneuInstallState('success')
      setNotice({
        tone: 'success',
        text: installPayload.already_installed
          ? t(
              `VieNeu d? du?c c?i s?n tr?n backend (${successApiBase}).`,
              `VieNeu is already installed on backend (${successApiBase}).`,
            )
          : t(
              `C?i VieNeu th?nh c?ng tr?n ${successApiBase}. ?ang t?i l?i danh s?ch voice...`,
              `VieNeu installed successfully on ${successApiBase}. Reloading voices...`,
            ),
      })
      await loadVieneuVoices(false)
      await loadVieneuDiagnostics(false)
      await refreshVieneuBackendState()
    } catch (error) {
      setVieneuInstallState('error')
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Kh?ng th? c?i VieNeu.', 'Cannot install VieNeu.'),
      })
    } finally {
      window.setTimeout(() => {
        setVieneuInstallState('idle')
      }, 1800)
    }
  }, [currentAiApiUrl, loadVieneuDiagnostics, loadVieneuVoices, refreshVieneuBackendState, resolvedVieneuApiBase, t, ttsEngine])

  useEffect(() => {
    if (activeTab !== 'voice' || ttsEngine !== 'vieneu') {
      return
    }
    let cancelled = false
    const run = async () => {
      await refreshVieneuBackendState()
      if (cancelled) {
        return
      }
      await loadVieneuVoices(false)
      if (cancelled) {
        return
      }
      await loadVieneuDiagnostics(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeTab, loadVieneuDiagnostics, loadVieneuVoices, refreshVieneuBackendState, ttsEngine])

  const stopBrowserStt = useCallback(() => {
    if (!listening) {
      return
    }
    stopListening()
    setMicState('ok')
    setMicDetail(t('?? d?ng STT v? ch? transcript cu?i', 'STT stopped, waiting for final transcript'))
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
    setMicDetail(t('?ang xin quy?n microphone v? kh?i d?ng STT...', 'Requesting microphone permission and starting STT...'))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicAudioConstraints(micNoiseFilterStrength),
      })
      const tracks = stream.getAudioTracks()
      const trackLabel = tracks[0]?.label || t('Microphone s?n s?ng', 'Microphone ready')
      tracks.forEach((track) => track.stop())

      if (!recognitionSupported) {
        setMicState('ok')
        setMicDetail(
          `${trackLabel}. ${t('Tr?nh duy?t kh?ng h? tr? STT kiosk flow.', 'This browser does not support the kiosk STT flow.')}`,
        )
        return
      }

      await startListening()
      setMicState('ok')
      setMicDetail(`Mic ok (${trackLabel}). ${t('?ang nghe...', 'Listening...')}`)
    } catch (error) {
      setMicState('error')
      setMicDetail(error instanceof Error ? error.message : t('Cannot test microphone', 'Cannot test microphone'))
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
      text: t(`?? c?p nh?t d? to robot: ${safeValue}%`, `Robot scale updated: ${safeValue}%`),
    })
  }, [t])

  const handleCameraPreviewVisibleChange = useCallback((visible: boolean) => {
    setCameraPreviewVisible(visible)
    persistCameraPreviewVisible(visible)
    setNotice({
      tone: 'info',
      text: visible
        ? t('?? b?t khung camera tr?n kiosk.', 'Camera preview enabled on kiosk.')
        : t('?? ?n khung camera tr?n kiosk.', 'Camera preview hidden on kiosk.'),
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
        text: t('?ang do d? ?n tr?c ti?p t? microphone.', 'Live microphone noise monitoring is running.'),
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : t('Kh?ng th? b?t do ?n microphone.', 'Cannot start microphone noise monitor.'),
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
        text: t('TTS Rate ph?i l? s? trong kho?ng 100-300.', 'TTS rate must be a number between 100 and 300.'),
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
          'C?u h?nh VieNeu chua h?p l?. Temperature 0.1-2.0, Top-K 1-200, Max chars 32-512.',
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
        rate: normalizedRate ?? 185,
        engine: ttsEngine,
      }
      if (ttsEngine === 'vieneu') {
        const cloneRefAudio = toSingleLine(vieneuRefAudio)
        const cloneRefText = toSingleLine(vieneuRefText)
        const vieneuModeForRequest = toSingleLine(
          getFieldValue(envFields, 'TTS_VIENEU_MODE', 'turbo'),
        ).toLowerCase()
        const vieneuModelForRequest = toSingleLine(vieneuModelPath).toLowerCase()
        const turboRuntimeConfigured =
          vieneuModeForRequest === 'turbo' ||
          vieneuModeForRequest === 'turbo_gpu' ||
          vieneuModelForRequest.includes('vieneu-tts-v2-turbo-gguf')
        const useCloneVoice =
          !turboRuntimeConfigured && cloneRefAudio.length > 0 && cloneRefText.length > 0
        if (!useCloneVoice && normalizedVieneuVoiceId.length > 0 && resolvedVieneuVoice === null) {
          setTtsTestStatus('error')
          setNotice({
            tone: 'warning',
            text: t(
              'Preset voice chua h?p l? cho model/runtime hi?n t?i. B?m "T?i voice VieNeu" r?i ch?n l?i t? danh s?ch.',
              'Preset voice is not valid for the current model/runtime. Click "Load VieNeu voices" and choose from the list.',
            ),
          })
          window.setTimeout(() => setTtsTestStatus('idle'), 2200)
          return
        }
        body.vieneu_voice_id = useCloneVoice ? '' : (resolvedVieneuVoice?.id || '')
        body.vieneu_ref_audio = useCloneVoice ? cloneRefAudio : ''
        body.vieneu_ref_text = useCloneVoice ? cloneRefText : ''
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
    envFields,
    vieneuMaxChars,
    vieneuModelPath,
    vieneuRefAudio,
    vieneuRefText,
    vieneuTemperature,
    vieneuTopK,
    resolvedVieneuVoice,
    normalizedVieneuVoiceId,
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
          'Kh?ng th? ?p d?ng TTS: Rate ph?i n?m trong kho?ng 100-300.',
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
          'Kh?ng th? ?p d?ng VieNeu: Temperature 0.1-2.0, Top-K 1-200, Max chars 32-512.',
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
      let effectiveVieneuVoiceId = ''
      let effectiveVieneuRefAudio = ''
      let effectiveVieneuRefText = ''
      const requestPayload: Record<string, unknown> = {
        engine: ttsEngine,
        tts_engine: ttsEngine,
        voice: ttsVoice,
        rate: normalizedRate ?? 185,
        tts_voice: ttsVoice,
        tts_rate: normalizedRate ?? 185,
      }
      if (ttsEngine === 'vieneu') {
        const vieneuMode = toSingleLine(getFieldValue(envFields, 'TTS_VIENEU_MODE', 'turbo')).toLowerCase()
        const normalizedModelPath = toSingleLine(vieneuModelPath)
        const turboRuntimeConfigured =
          vieneuMode === 'turbo' ||
          vieneuMode === 'turbo_gpu' ||
          normalizedModelPath.toLowerCase().includes('vieneu-tts-v2-turbo-gguf')
        const useCloneVoiceMode =
          !turboRuntimeConfigured && cloneRefAudioValue.length > 0 && cloneRefTextValue.length > 0
        if (!useCloneVoiceMode && normalizedVieneuVoiceId.length > 0 && resolvedVieneuVoice === null) {
          setTtsApplyStatus('error')
          setNotice({
            tone: 'warning',
            text: t(
              'Voice ID chua n?m trong preset hi?n c?. H?y b?m "T?i voice VieNeu" v? ch?n voice h?p l?.',
              'Voice ID is not in the current preset list. Click "Load VieNeu voices" and pick a valid preset.',
            ),
          })
          window.setTimeout(() => setTtsApplyStatus('idle'), 2200)
          return
        }
        effectiveVieneuVoiceId = useCloneVoiceMode ? '' : (resolvedVieneuVoice?.id || '')
        effectiveVieneuRefAudio = useCloneVoiceMode ? cloneRefAudioValue : ''
        effectiveVieneuRefText = useCloneVoiceMode ? cloneRefTextValue : ''
        const vieneuBackboneDevice = toSingleLine(
          getFieldValue(envFields, 'TTS_VIENEU_BACKBONE_DEVICE', 'cpu'),
        ).toLowerCase()
        const vieneuCodecRepo = toSingleLine(
          getFieldValue(envFields, 'TTS_VIENEU_CODEC_REPO', VIENEU_CODEC_REPO_AUTO),
        )
        const vieneuCodecDevice = toSingleLine(
          getFieldValue(envFields, 'TTS_VIENEU_CODEC_DEVICE', 'cpu'),
        ).toLowerCase()
        const vieneuRemoteApiBase = toSingleLine(
          getFieldValue(envFields, 'TTS_VIENEU_REMOTE_API_BASE', 'http://localhost:23333/v1'),
        )
        const streamFramesPerChunk = Number.parseInt(
          getFieldValue(envFields, 'TTS_VIENEU_STREAM_FRAMES_PER_CHUNK', '25'),
          10,
        )
        const streamLookforward = Number.parseInt(
          getFieldValue(envFields, 'TTS_VIENEU_STREAM_LOOKFORWARD', '10'),
          10,
        )
        const streamLookback = Number.parseInt(
          getFieldValue(envFields, 'TTS_VIENEU_STREAM_LOOKBACK', '100'),
          10,
        )
        const streamOverlapFrames = Number.parseInt(
          getFieldValue(envFields, 'TTS_VIENEU_STREAM_OVERLAP_FRAMES', '1'),
          10,
        )
        requestPayload.vieneu_model_path = toSingleLine(vieneuModelPath)
        requestPayload.tts_vieneu_model_path = toSingleLine(vieneuModelPath)
        requestPayload.vieneu_mode = vieneuMode
        requestPayload.tts_vieneu_mode = vieneuMode
        requestPayload.vieneu_backbone_device = vieneuBackboneDevice
        requestPayload.tts_vieneu_backbone_device = vieneuBackboneDevice
        requestPayload.vieneu_codec_repo = vieneuCodecRepo
        requestPayload.tts_vieneu_codec_repo = vieneuCodecRepo
        requestPayload.vieneu_codec_device = vieneuCodecDevice
        requestPayload.tts_vieneu_codec_device = vieneuCodecDevice
        requestPayload.vieneu_remote_api_base = vieneuRemoteApiBase
        requestPayload.tts_vieneu_remote_api_base = vieneuRemoteApiBase
        requestPayload.vieneu_voice_id = effectiveVieneuVoiceId
        requestPayload.tts_vieneu_voice_id = effectiveVieneuVoiceId
        requestPayload.vieneu_ref_audio = effectiveVieneuRefAudio
        requestPayload.tts_vieneu_ref_audio = effectiveVieneuRefAudio
        requestPayload.vieneu_ref_text = effectiveVieneuRefText
        requestPayload.tts_vieneu_ref_text = effectiveVieneuRefText
        requestPayload.vieneu_temperature = normalizedVieneuTemperature
        requestPayload.tts_vieneu_temperature = normalizedVieneuTemperature
        requestPayload.vieneu_top_k = normalizedVieneuTopK
        requestPayload.tts_vieneu_top_k = normalizedVieneuTopK
        requestPayload.vieneu_max_chars = normalizedVieneuMaxChars
        requestPayload.tts_vieneu_max_chars = normalizedVieneuMaxChars
        requestPayload.vieneu_stream_frames_per_chunk =
          Number.isFinite(streamFramesPerChunk) && streamFramesPerChunk > 0 ? streamFramesPerChunk : 25
        requestPayload.tts_vieneu_stream_frames_per_chunk =
          Number.isFinite(streamFramesPerChunk) && streamFramesPerChunk > 0 ? streamFramesPerChunk : 25
        requestPayload.vieneu_stream_lookforward =
          Number.isFinite(streamLookforward) && streamLookforward >= 0 ? streamLookforward : 10
        requestPayload.tts_vieneu_stream_lookforward =
          Number.isFinite(streamLookforward) && streamLookforward >= 0 ? streamLookforward : 10
        requestPayload.vieneu_stream_lookback =
          Number.isFinite(streamLookback) && streamLookback > 0 ? streamLookback : 100
        requestPayload.tts_vieneu_stream_lookback =
          Number.isFinite(streamLookback) && streamLookback > 0 ? streamLookback : 100
        requestPayload.vieneu_stream_overlap_frames =
          Number.isFinite(streamOverlapFrames) && streamOverlapFrames > 0 ? streamOverlapFrames : 1
        requestPayload.tts_vieneu_stream_overlap_frames =
          Number.isFinite(streamOverlapFrames) && streamOverlapFrames > 0 ? streamOverlapFrames : 1
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
        throw (lastError || new Error('Kh?ng ?p d?ng du?c TTS cho backend n?o.'))
      }

      const nextValues: Record<string, string> = {
        TTS_ENGINE: ttsEngine,
        TTS_VOICE: ttsVoice,
        TTS_RATE: String(normalizedRate ?? 185),
        TTS_VIENEU_MODEL_PATH: toSingleLine(vieneuModelPath),
        TTS_VIENEU_MODE: getFieldValue(envFields, 'TTS_VIENEU_MODE', 'turbo'),
        TTS_VIENEU_BACKBONE_DEVICE: getFieldValue(envFields, 'TTS_VIENEU_BACKBONE_DEVICE', 'cpu'),
        TTS_VIENEU_CODEC_REPO: getFieldValue(
          envFields,
          'TTS_VIENEU_CODEC_REPO',
          VIENEU_CODEC_REPO_AUTO,
        ),
        TTS_VIENEU_CODEC_DEVICE: getFieldValue(envFields, 'TTS_VIENEU_CODEC_DEVICE', 'cpu'),
        TTS_VIENEU_REMOTE_API_BASE: getFieldValue(
          envFields,
          'TTS_VIENEU_REMOTE_API_BASE',
          'http://localhost:23333/v1',
        ),
        VIENEU_REALTIME_PROFILE: vieneuRealtimeProfile,
        TTS_VIENEU_VOICE_ID: effectiveVieneuVoiceId,
        TTS_VIENEU_REF_AUDIO: effectiveVieneuRefAudio,
        TTS_VIENEU_REF_TEXT: effectiveVieneuRefText,
        TTS_VIENEU_TEMPERATURE: String(normalizedVieneuTemperature ?? 0.7),
        TTS_VIENEU_TOP_K: String(normalizedVieneuTopK ?? 50),
        TTS_VIENEU_MAX_CHARS: String(normalizedVieneuMaxChars ?? 256),
        TTS_VIENEU_STREAM_FRAMES_PER_CHUNK: getFieldValue(envFields, 'TTS_VIENEU_STREAM_FRAMES_PER_CHUNK', '25'),
        TTS_VIENEU_STREAM_LOOKFORWARD: getFieldValue(
          envFields,
          'TTS_VIENEU_STREAM_LOOKFORWARD',
          '10',
        ),
        TTS_VIENEU_STREAM_LOOKBACK: getFieldValue(
          envFields,
          'TTS_VIENEU_STREAM_LOOKBACK',
          '100',
        ),
        TTS_VIENEU_STREAM_OVERLAP_FRAMES: getFieldValue(envFields, 'TTS_VIENEU_STREAM_OVERLAP_FRAMES', '1'),
        VOICE_LISTEN_MODE: getFieldValue(envFields, 'VOICE_LISTEN_MODE', 'always'),
        VOICE_ALWAYS_LISTEN:
          getFieldValue(envFields, 'VOICE_LISTEN_MODE', 'always') === 'sequential' ? 'false' : 'true',
      }
      const nextFields = envFields.map((field) =>
        field.key in nextValues ? { ...field, value: nextValues[field.key] } : field,
      )
      setEnvFields(nextFields)
      await saveAndSyncConfig(
        nextFields,
        t(
          `?? ?p d?ng TTS v?o ${successCount} backend v? d?ng b? v?o kiosk.`,
          `TTS applied to ${successCount} backend endpoints and synced to kiosk.`,
        ),
      )
      if (ttsEngine === 'vieneu') {
        void loadVieneuVoices(false)
        void loadVieneuDiagnostics(false)
      }
      setTtsApplyStatus('success')
    } catch (error) {
      setTtsApplyStatus('error')
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('Kh?ng th? ?p d?ng TTS config', 'Cannot apply TTS config'),
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
    loadVieneuDiagnostics,
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
    resolvedVieneuVoice,
    normalizedVieneuVoiceId,
  ])

  return (
    <main className="admin-page">
      <div className="admin-page__backdrop admin-page__backdrop--one" />
      <div className="admin-page__backdrop admin-page__backdrop--two" />
      <div className="admin-shell">
        <aside className="admin-sidebar" aria-label={t('Menu qu?n tr? b?n tr?i', 'Left admin menu')}>
          <div className="admin-sidebar__brand">
            <p className="admin-kicker">Order Robot / Admin</p>
            <h1>{t('Trung t?m qu?n tr?', 'Admin Control Center')}</h1>
            <p>
              {t(
                'B? c?c s?ng, r? t?ng nh?m ch?c nang d? v?n h?nh nhanh v? ?t nh?m thao t?c.',
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
              {uiLanguage === 'vi' ? 'English / Ti?ng Vi?t' : 'Ti?ng Vi?t / English'}
            </button>
            <a className="admin-link" href="/debug">
              {t('Debug Bridge', 'Bridge Debug')}
            </a>
            <a className="admin-link admin-link--primary" href="/">
              {t('V? Kiosk', 'Back To Kiosk')}
            </a>
          </div>

          <nav className="admin-sidebar__nav" aria-label={t('?i?u hu?ng theo nh?m', 'Grouped navigation')}>
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
            <p>{t('??ng b? g?n nh?t', 'Last synced')}</p>
            <strong>{formatSyncTime(lastSyncAt, uiLanguage)}</strong>
            <span>
              {t(
                'M?i thay d?i trong c?u h?nh s? d?y sang kiosk ngay sau khi luu.',
                'Every saved configuration is synced to kiosk immediately.',
              )}
            </span>
          </div>
        </aside>

        <section className="admin-main">
          <header className="admin-header">
            <div className="admin-header__title">
              <p className="admin-kicker">{t('B?ng di?u khi?n v?n h?nh', 'Operations Console')}</p>
              <h2>{activeTabMeta ? activeTabMeta.label[uiLanguage] : t('T?ng quan', 'Overview')}</h2>
              <p className="admin-subtitle">
                {activeTabMeta
                  ? activeTabMeta.hint[uiLanguage]
                  : t('Qu?n l? h? th?ng g?i m?n t?i m?t noi.', 'Manage ordering system in one place.')}
              </p>
            </div>
            <div className="admin-header__actions">
              <p className="admin-chip admin-chip--ok">
                {t('D?ch v? online', 'Services online')}: {healthyServiceCount}/{services.length}
              </p>
              <p className="admin-chip admin-chip--ok">
                {t('Mic', 'Mic')}: {micState}
              </p>
              <p className="admin-chip admin-chip--ok">
                Caption: {liveCaption.status}
              </p>
              {onLogout ? (
                <button className="admin-btn admin-btn--ghost admin-logout-btn" type="button" onClick={onLogout}>
                  {t('Dang xuat', 'Sign Out')}
                </button>
              ) : null}
            </div>
          </header>

          {notice ? (
            <section className={`admin-notice admin-notice--${notice.tone}`} role="status">
              {notice.text}
            </section>
          ) : null}

          <section className="admin-metrics-grid">
            <article className="admin-metric-card">
              <p className="admin-metric-card__label">{t('S?c kh?e h? th?ng', 'System Health')}</p>
              <p className="admin-metric-card__value">
                {healthyServiceCount}/{services.length}
              </p>
              <p className="admin-metric-card__hint">{t('d?ch v? dang ho?t d?ng', 'services online')}</p>
            </article>
            <article className="admin-metric-card">
              <p className="admin-metric-card__label">{t('L?n d?ng b?', 'Latest Sync')}</p>
              <p className="admin-metric-card__value">{formatSyncTime(lastSyncAt, uiLanguage)}</p>
              <p className="admin-metric-card__hint">{t('thay d?i du?c d?y ngay sang kiosk', 'changes are synced instantly')}</p>
            </article>
            <article className="admin-metric-card">
              <p className="admin-metric-card__label">{t('Tr?ng th?i h?i tho?i', 'Speech Status')}</p>
              <p className="admin-metric-card__value">{listening ? t('?ang nghe', 'Listening') : t('?ang ngh?', 'Idle')}</p>
              <p className="admin-metric-card__hint">
                Mic: {micState} | Caption: {liveCaption.status}
              </p>
            </article>
          </section>

          {activeTab !== 'robotStudio' ? (
            <section className="admin-panel admin-panel--robot-first">
              <header className="admin-panel__head">
                <div>
                  <h2>{t('T?i uu robot nhanh', 'Quick Robot Tuning')}</h2>
                  <p>
                    {t(
                      '?i?u ch?nh nhanh t? l? robot v? khung camera d? kh?p m?n kiosk t?i qu?y.',
                      'Quickly tune robot scale and camera tile for kiosk display fit.',
                    )}
                  </p>
                </div>
                <p className="admin-chip admin-chip--ok">Scale: {robotScalePercent}%</p>
              </header>
              <div className="admin-fields-grid">
                <label className="admin-field admin-field--full">
                  <span>{t('?? to robot (60-170%)', 'Robot scale (60-170%)')}</span>
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
                  <span>{t('Khung camera mini (g?c ph?i tr?n)', 'Mini camera tile (top-right)')}</span>
                  <select
                    value={cameraPreviewVisible ? 'show' : 'hide'}
                    onChange={(event) => handleCameraPreviewVisibleChange(event.target.value === 'show')}
                  >
                    <option value="show">{t('Hi?n', 'Show')}</option>
                    <option value="hide">{t('?n', 'Hide')}</option>
                  </select>
                </label>
              </div>
            </section>
          ) : null}

      {activeTab === 'overview' ? (
        <section className="admin-panel">
          <header className="admin-panel__head">
            <div>
              <h2>{t('S?c kh?e backend', 'Backend Health')}</h2>
              <p>{t('Ki?m tra c?c endpoint quan tr?ng d? bi?t di?m n?o dang ch?m ho?c l?i.', 'Check critical endpoints to see what is slow or failing.')}</p>
            </div>
            <button className="admin-btn" type="button" onClick={() => void runHealthChecks()}>
              {isHealthChecking ? t('?ang ki?m tra...', 'Checking...') : t('Ki?m tra ngay', 'Run Check')}
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
                <p>{t('K?o slider d? ch?nh m?c l?c ?n v? xem d? ?n realtime t? mic.', 'Drag slider to tune noise filter and view live mic level.')}</p>
              </div>
              <div className="admin-inline-actions admin-inline-actions--voice">
                {noiseMonitorActive ? (
                  <button className="admin-btn admin-btn--ghost" type="button" onClick={stopNoiseMonitor}>
                    {t('D?ng do ?n', 'Stop Meter')}
                  </button>
                ) : (
                  <button className="admin-btn" type="button" onClick={() => void startNoiseMonitor()}>
                    {t('B?t do ?n tr?c ti?p', 'Start Live Meter')}
                  </button>
                )}
              </div>
            </header>
            <div className="admin-fields-grid">
              <label className="admin-field">
                <span>
                  {t('M?c l?c ?n', 'Noise filter level')}: {micNoiseFilterStrength}% ({getMicNoiseFilterLabel(micNoiseFilterStrength, uiLanguage)})
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
              {t('?? ?n hi?n t?i', 'Current noise')}: <strong>{noiseLevelDb.toFixed(1)} dB</strong>
            </p>
            <div className="admin-noise-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={noiseLevelPercent}>
              <div className="admin-noise-meter__bar" style={{ width: `${noiseLevelPercent}%` }} />
            </div>
          </article>

          <article className="admin-subcard">
            <header className="admin-subcard__head">
              <div>
                <h3>{t('C?i d?t gi?ng n?i', 'Voice Settings')}</h3>
                <p>
                  {t('Ch?n voice v? t?c d? d?c. Ki?m th? r?i ?p d?ng ngay t?i d?y.', 'Select voice and speaking rate. Test and apply right here.')}
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
                    ? t('?ang d?c...', 'Speaking...')
                    : ttsTestStatus === 'error'
                      ? t('??c th? b? l?i', 'Preview failed')
                      : t('??c th?', 'Preview')}
                </button>
                <button
                  className="admin-btn admin-btn--ghost"
                  type="button"
                  onClick={() => void applyTtsConfig()}
                  disabled={ttsApplyStatus === 'saving'}
                >
                  {ttsApplyStatus === 'saving'
                    ? t('?ang ?p d?ng...', 'Applying...')
                    : ttsApplyStatus === 'success'
                      ? t('?p d?ng xong', 'Applied')
                      : ttsApplyStatus === 'error'
                        ? t('?p d?ng l?i', 'Apply failed')
                        : t('?p d?ng v?o backend', 'Apply To Backend')}
                </button>
                {ttsEngine === 'vieneu' ? (
                  <button
                    className="admin-btn admin-btn--minimal"
                    type="button"
                    onClick={() => void installVieneuRuntime()}
                    disabled={vieneuInstallState === 'installing' || !canInstallDeps}
                  >
                    {vieneuInstallState === 'installing'
                      ? t('?ang c?i VieNeu...', 'Installing VieNeu...')
                      : vieneuInstallState === 'success'
                        ? t('?? c?i VieNeu', 'VieNeu Installed')
                        : vieneuInstallState === 'error'
                          ? t('C?i VieNeu l?i', 'VieNeu Install Failed')
                          : t('C?i VieNeu', 'Install VieNeu')}
                  </button>
                ) : null}
                {ttsEngine === 'vieneu' ? (
                  <button
                    className="admin-btn admin-btn--minimal"
                    type="button"
                    onClick={() => void loadVieneuVoices()}
                    disabled={vieneuVoicesState === 'loading' || !canLoadVoices}
                  >
                    {vieneuVoicesState === 'loading'
                      ? t('?ang t?i voice...', 'Loading voices...')
                      : t('T?i voice VieNeu', 'Load VieNeu Voices')}
                  </button>
                ) : null}
                {ttsEngine === 'vieneu' ? (
                  <button
                    className="admin-btn admin-btn--minimal"
                    type="button"
                    onClick={() => void prewarmVieneuModel()}
                    disabled={vieneuPrewarmState === 'loading' || !canPrewarm}
                  >
                    {vieneuPrewarmState === 'loading'
                      ? t('?ang t?i model...', 'Downloading model...')
                      : vieneuPrewarmState === 'success'
                        ? t('Model d? s?n s?ng', 'Model Ready')
                        : vieneuPrewarmState === 'error'
                          ? t('T?i model l?i', 'Model Download Failed')
                          : t('T?i model VieNeu', 'Download VieNeu Model')}
                  </button>
                ) : null}
                {ttsEngine === 'vieneu' ? (
                  <button
                    className="admin-btn admin-btn--minimal"
                    type="button"
                    onClick={() => void loadVieneuDiagnostics()}
                    disabled={vieneuDiagState === 'loading' || !canCheckDiag}
                  >
                    {vieneuDiagState === 'loading'
                      ? t('?ang ki?m tra...', 'Checking...')
                      : t('Ki?m tra runtime', 'Check Runtime')}
                  </button>
                ) : null}
                <button
                  className="admin-btn admin-btn--minimal"
                  type="button"
                  onClick={() => setShowAdvancedVoiceTools((current) => !current)}
                >
                  {showAdvancedVoiceTools ? t('?n test k? thu?t', 'Hide Advanced Tests') : t('Hi?n test k? thu?t', 'Show Advanced Tests')}
                </button>
              </div>
            </header>
            {ttsEngine === 'vieneu' ? (
              <p className="admin-service-card__detail">
                {voiceActionStatus}
              </p>
            ) : null}
            {ttsEngine === 'vieneu' ? (
              <div className="admin-vieneu-backend-bar">
                <p className={`admin-chip admin-chip--${vieneuBackendState.status === 'connected' ? 'ok' : vieneuBackendState.status === 'checking' ? 'checking' : 'error'}`}>
                  {vieneuBackendState.status === 'connected'
                    ? t('Backend d? k?t n?i', 'Backend connected')
                    : vieneuBackendState.status === 'checking'
                      ? t('?ang d? backend', 'Probing backends')
                      : t('Backend chua k?t n?i', 'Backend offline')}
                </p>
                <p className="admin-service-card__detail">
                  {t('Backend dang d?ng', 'Active backend')}: <strong>{vieneuBackendState.activeApiBase || 'n/a'}</strong>
                </p>
                <div className="admin-chip-list">
                  <p className={`admin-chip admin-chip--${vieneuBackendState.capabilities.voices ? 'ok' : 'warning'}`}>voices</p>
                  <p className={`admin-chip admin-chip--${vieneuBackendState.capabilities.diag ? 'ok' : 'warning'}`}>diag</p>
                  <p className={`admin-chip admin-chip--${vieneuBackendState.capabilities.prewarm ? 'ok' : 'warning'}`}>prewarm</p>
                  <p className={`admin-chip admin-chip--${vieneuBackendState.capabilities.install ? 'ok' : 'warning'}`}>install</p>
                </div>
                {vieneuBackendState.detail ? (
                  <p className="admin-service-card__detail">{vieneuBackendState.detail}</p>
                ) : null}
                <button
                  className="admin-btn admin-btn--ghost"
                  type="button"
                  onClick={() => void refreshVieneuBackendState()}
                  disabled={vieneuBackendState.status === 'checking'}
                >
                  {vieneuBackendState.status === 'checking' ? t('?ang d?...', 'Probing...') : t('D? l?i backend', 'Probe Backends')}
                </button>
              </div>
            ) : null}
            {ttsEngine === 'vieneu' ? (
              <div className="admin-voice-status-strip">
                <p className={`admin-chip admin-chip--${vieneuDiagnostics?.instance_ready ? 'ok' : 'idle'}`}>
                  {vieneuDiagnostics?.instance_ready ? t('Runtime s?n s?ng', 'Runtime ready') : t('Runtime chua s?n s?ng', 'Runtime not ready')}
                </p>
                <p className="admin-chip admin-chip--checking">
                  {t('Voice presets', 'Voice presets')}: {vieneuVoices.length}
                </p>
                <p className="admin-chip admin-chip--idle">
                  {t('Model', 'Model')}: {toSingleLine(vieneuModelPath || '-')}
                </p>
              </div>
            ) : null}

            <div className="admin-voice-form">
              <section className="admin-voice-section">
                <header className="admin-voice-section__head">
                  <h4>{t('1. C?u h?nh co b?n', '1. Basic Configuration')}</h4>
                  <p>{t('Ch?n engine, voice fallback v? t?c d? d?c.', 'Set engine, fallback voice, and speaking speed.')}</p>
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
                  <label className="admin-field">
                    <span>{t('Ch? d? nghe', 'Listen Mode')}</span>
                    <select
                      value={getFieldValue(envFields, 'VOICE_LISTEN_MODE', 'always') === 'sequential' ? 'sequential' : 'always'}
                      onChange={(event) => {
                        const nextMode = event.target.value === 'sequential' ? 'sequential' : 'always'
                        applyVoiceListenModeInstant(nextMode)
                      }}
                    >
                      {VOICE_LISTEN_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label[uiLanguage]}
                        </option>
                      ))}
                    </select>
                    <small className="admin-service-card__detail">
                      {VOICE_LISTEN_MODE_OPTIONS.find(
                        (option) =>
                          option.value ===
                          (getFieldValue(envFields, 'VOICE_LISTEN_MODE', 'always') === 'sequential'
                            ? 'sequential'
                            : 'always'),
                      )?.hint[uiLanguage] ?? ''}
                    </small>
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
                            text: t(`?? ch?n preset ${preset.label.vi}.`, `Preset selected: ${preset.label.en}.`),
                          })
                        }}
                      >
                        {preset.label[uiLanguage]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>

              {ttsEngine === 'vieneu' ? (
                <section className="admin-voice-section">
                  <header className="admin-voice-section__head">
                    <h4>{t('2. C?u h?nh VieNeu', '2. VieNeu Configuration')}</h4>
                    <p>{t('Ch?n profile realtime, model, voice v? tham s? sinh gi?ng.', 'Set realtime profile, model, voice and generation parameters.')}</p>
                  </header>
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
                  <div className="admin-fields-grid">
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
                        <option value="custom">{t('T?y ch?nh th? c?ng', 'Manual custom')}</option>
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
                          'Vi du: pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF',
                          'Example: pnnbao-ump/VieNeu-TTS-v2-Turbo-GGUF',
                        )}
                      />
                    </label>
                    <div className="admin-field admin-field--full admin-onnx-status-block">
                      <span>{t('Tr?ng th?i model & ONNX', 'Model & ONNX Status')}</span>
                      <div className="admin-chip-list">
                        <p className={`admin-chip admin-chip--${runtimeModelLoaded ? (runtimeModelMatchesConfigured ? 'ok' : 'warning') : 'idle'}`}>
                          {runtimeModelLoaded
                            ? runtimeModelMatchesConfigured
                              ? t('Model d? t?i d?ng', 'Model loaded (matched)')
                              : t('Model runtime kh?c c?u h?nh', 'Runtime model differs')
                            : t('Model chua t?i runtime', 'Model not loaded in runtime')}
                        </p>
                        <p className={`admin-chip admin-chip--${onnxPackageReady ? 'ok' : 'warning'}`}>
                          {onnxPackageReady ? t('G?i ONNX d?', 'ONNX packages ready') : t('Thi?u g?i ONNX', 'ONNX packages missing')}
                        </p>
                        <p className={`admin-chip admin-chip--${onnxProfileSelected ? 'ok' : 'warning'}`}>
                          {onnxProfileSelected ? t('Profile ONNX CPU d?ng', 'ONNX CPU profile selected') : t('Profile ONNX CPU chua d?ng', 'ONNX CPU profile not selected')}
                        </p>
                        <p className={`admin-chip admin-chip--${onnxRecommendedModel ? 'ok' : 'warning'}`}>
                          {onnxRecommendedModel
                            ? t('Model GGUF CPU d? ch?n', 'CPU GGUF model selected')
                            : t('Chua ch?n model GGUF CPU', 'CPU GGUF model not selected')}
                        </p>
                        <p className={`admin-chip admin-chip--${onnxReadyForRun ? 'ok' : 'warning'}`}>
                          {onnxReadyForRun ? t('S?n s?ng ch?y ONNX', 'Ready for ONNX run') : t('Chua s?n s?ng ch?y ONNX', 'Not ready for ONNX run')}
                        </p>
                      </div>
                      <p className="admin-service-card__detail">
                        {t('Runtime model hi?n t?i', 'Current runtime model')}: <strong>{normalizedRuntimeModelPath || 'n/a'}</strong>
                      </p>
                      {toSingleLine(String(vieneuDiagnostics?.compat_warning || '')).length > 0 ? (
                        <p className="admin-service-card__detail admin-service-card__detail--warning">
                          {toSingleLine(String(vieneuDiagnostics?.compat_warning || ''))}
                        </p>
                      ) : null}
                      {runtimeModelLoaded && !runtimeModelMatchesConfigured ? (
                        <p className="admin-service-card__detail">
                          {t('B?m "T?i model VieNeu" d? n?p d?ng model dang c?u h?nh.', 'Click "Download VieNeu Model" to load the configured model.')}
                        </p>
                      ) : null}
                    </div>
                    <label className="admin-field">
                      <span>{t('VieNeu Preset voice', 'VieNeu Preset voice')}</span>
                      <select value={vieneuVoiceId} onChange={(event) => setVieneuVoiceId(event.target.value)}>
                        <option value="">{t('M?c d?nh theo model', 'Model default voice')}</option>
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
                      {normalizedVieneuVoiceId.length === 0 ? (
                        <small className="admin-service-card__detail">
                          {t('?ang d?ng voice m?c d?nh theo model/runtime.', 'Using model/runtime default voice.')}
                        </small>
                      ) : resolvedVieneuVoice ? (
                        <small className="admin-service-card__detail">
                          {resolvedVieneuVoice.source === 'id'
                            ? t(`Voice h?p l?: ${resolvedVieneuVoice.id}`, `Valid voice ID: ${resolvedVieneuVoice.id}`)
                            : t(
                                `?? chu?n h?a v? ID h? tr?: ${resolvedVieneuVoice.id}`,
                                `Normalized to supported ID: ${resolvedVieneuVoice.id}`,
                              )}
                        </small>
                      ) : (
                        <small className="admin-service-card__detail admin-service-card__detail--warning">
                          {t(
                            'Voice hi?n t?i kh?ng n?m trong preset SDK dang h? tr?. H?y t?i l?i voices v? ch?n t? danh s?ch.',
                            'Current voice is not in SDK-supported presets. Reload voices and select from the list.',
                          )}
                        </small>
                      )}
                      {vieneuVoicesState === 'ready' &&
                      normalizedConfiguredModelPath.toLowerCase().includes('vieneu-tts-v2-turbo') ? (
                        <small className="admin-service-card__detail">
                          {t(
                            `Model Turbo hi?n tr? v? ${vieneuVoices.length} preset voice t? repo.`,
                            `Turbo model currently exposes ${vieneuVoices.length} preset voices from its repo.`,
                          )}
                        </small>
                      ) : null}
                    </label>
                    <label className="admin-field">
                      <span>{t('Ho?c nh?p voice id th? c?ng', 'Or enter voice id manually')}</span>
                      <input
                        value={vieneuVoiceId}
                        onChange={(event) => setVieneuVoiceId(event.target.value)}
                        placeholder={t('V? d?: Tuyen', 'Example: Tuyen')}
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
                  </div>
                </section>
              ) : null}

              {ttsEngine === 'vieneu' ? (
                <section className="admin-voice-section">
                  <header className="admin-voice-section__head">
                    <h4>{t('3. Clone gi?ng (tu? ch?n)', '3. Voice Cloning (Optional)')}</h4>
                    <p>{t('N?u d?ng clone, c?n c? file wav v? ref text kh?p n?i dung.', 'For cloning, provide both wav path and matching reference text.')}</p>
                  </header>
                  <div className="admin-fields-grid">
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
                          'Nh?p c?u text d?ng v?i file m?u d? clone gi?ng ?n d?nh.',
                          'Enter transcript matching the reference audio for stable cloning.',
                        )}
                      />
                    </label>
                  </div>
                </section>
              ) : null}

              <section className="admin-voice-section">
                <header className="admin-voice-section__head">
                  <h4>{t('4. Ki?m th? c?u d?c', '4. Test Speech Text')}</h4>
                  <p>{t('Nh?p c?u m?u d? d?c th? tru?c khi ?p d?ng backend.', 'Write test text and preview before applying backend config.')}</p>
                </header>
                <div className="admin-fields-grid">
                  <label className="admin-field admin-field--full">
                    <span>{t('Text test', 'Test text')}</span>
                    <textarea
                      value={ttsTestText}
                      onChange={(event) => setTtsTestText(event.target.value)}
                      placeholder={t('Nh?p n?i dung c?n d?c th?...', 'Enter text to synthesize...')}
                    />
                  </label>
                </div>
              </section>
            </div>
            <p className="admin-service-card__detail">
              {ttsEngine === 'vieneu'
                  ? t(
                    'VieNeu: c? th? ch?n preset voice ho?c clone gi?ng b?ng ref audio + ref text, sau d? b?m Apply.',
                    'VieNeu: choose a preset voice or clone from ref audio + ref text, then press Apply.',
                  )
                : t(
                    'Goi y de nghe giong nguoi that hon: dung Neural voice, rate trong khoang 145-180.',
                    'For more natural voice quality, use Neural voice with rate around 145-180.',
                  )}
            </p>
            {ttsEngine === 'vieneu' ? (
              <div className="admin-service-grid admin-service-grid--runtime">
                <article className="admin-service-card">
                  <h3>{t('VieNeu Runtime', 'VieNeu Runtime')}</h3>
                  <p className={`admin-chip admin-chip--${vieneuDiagnostics?.instance_ready ? 'ok' : 'idle'}`}>
                    {vieneuDiagnostics?.instance_ready ? t('S?n s?ng', 'Ready') : t('Chua s?n s?ng', 'Not Ready')}
                  </p>
                  <p className="admin-service-card__detail">
                    {t('Model', 'Model')}: {vieneuDiagnostics?.model_path || 'n/a'}
                  </p>
                  <p className="admin-service-card__detail">
                    {t('Mode/Device', 'Mode/Device')}: {vieneuDiagnostics?.mode || 'n/a'} / {vieneuDiagnostics?.backbone_device || 'n/a'}
                  </p>
                  <p className="admin-service-card__detail">
                    {t('Init ms', 'Init ms')}: {vieneuDiagnostics?.last_init_ms ?? 'n/a'} | {t('Prewarm ms', 'Prewarm ms')}: {vieneuDiagnostics?.prewarm_ms ?? 'n/a'}
                  </p>
                  <p className="admin-service-card__detail">
                    Realtime factor: {typeof vieneuDiagnostics?.stream_realtime_factor === 'number'
                      ? vieneuDiagnostics.stream_realtime_factor.toFixed(3)
                      : 'n/a'}
                  </p>
                  {vieneuDiagnostics?.last_error ? (
                    <p className="admin-chip admin-chip--error">{vieneuDiagnostics.last_error}</p>
                  ) : null}
                </article>
                <article className="admin-service-card">
                  <h3>{t('CPU Processing', 'CPU Processing')}</h3>
                  {cpuDependencies.length > 0 ? (
                    <div className="admin-cpu-dependency-list">
                      {cpuDependencies.map((item) => (
                        <div key={item.name} className="admin-cpu-dependency-item">
                          <p className="admin-service-card__detail">{item.label}</p>
                          <p className={`admin-chip admin-chip--${item.ready ? 'ok' : 'warning'}`}>
                            {item.version}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="admin-service-card__detail">
                      {t('Chua c? d? li?u. B?m "Ki?m tra runtime".', 'No data yet. Click "Check Runtime".')}
                    </p>
                  )}
                  <p className="admin-cpu-hint">
                    {t('Y?u c?u: ~1.5GB dung lu?ng tr?ng', 'Required: ~1.5GB free disk space')}
                  </p>
                  <div className="admin-inline-actions">
                    <button
                      className="admin-btn"
                      type="button"
                      onClick={() => void installVieneuRuntime()}
                      disabled={vieneuInstallState === 'installing' || !canInstallDeps}
                    >
                      {vieneuInstallState === 'installing'
                        ? t('?ang c?i CPU dependencies...', 'Installing CPU dependencies...')
                        : t('Install All CPU Dependencies', 'Install All CPU Dependencies')}
                    </button>
                    <button className="admin-btn admin-btn--ghost" type="button" onClick={applyCpuOnnxPreset}>
                      {t('D?ng c?u h?nh ONNX CPU', 'Use ONNX CPU Preset')}
                    </button>
                  </div>
                  <div className="admin-onnx-guide">
                    <p className="admin-service-card__detail"><strong>{t('ONNX setup nhanh', 'Quick ONNX setup')}</strong></p>
                    <p className="admin-service-card__detail">1. {t('B?m "Install All CPU Dependencies".', 'Click "Install All CPU Dependencies".')}</p>
                    <p className="admin-service-card__detail">2. {t('B?m "D?ng c?u h?nh ONNX CPU".', 'Click "Use ONNX CPU Preset".')}</p>
                    <p className="admin-service-card__detail">3. {t('B?m "T?i model VieNeu" r?i "?p d?ng v?o backend".', 'Click "Download VieNeu Model" then "Apply To Backend".')}</p>
                  </div>
                  {missingCpuDependencies.length > 0 ? (
                    <p className="admin-service-card__detail">
                      {t(
                        `Thi?u ${missingCpuDependencies.length} dependency CPU. B?m "Install All CPU Dependencies".`,
                        `${missingCpuDependencies.length} CPU dependencies are missing. Click "Install All CPU Dependencies".`,
                      )}
                    </p>
                  ) : null}
                </article>
              </div>
            ) : null}
          </article>

          {showAdvancedVoiceTools ? (
            <>
              <article className="admin-subcard">
                <header className="admin-subcard__head">
                  <div>
                    <h3>{t('Test mic nhanh (1 n?t)', 'Quick Mic Test (one button)')}</h3>
                    <p>
                      {t(
                        'B?m m?t l?n d? xin quy?n mic v? b?t STT ngay. B?m l?i d? d?ng test.',
                        'Click once to request mic permission and start STT. Click again to stop.',
                      )}
                    </p>
                  </div>
                  <div className="admin-inline-actions">
                    <button className="admin-btn" type="button" onClick={() => void runQuickMicTest()}>
                      {listening ? t('D?ng test mic', 'Stop Mic Test') : t('Ki?m tra mic ngay', 'Start Mic Test')}
                    </button>
                  </div>
                </header>
                <p className={`admin-chip admin-chip--${micState}`}>{micState}</p>
                <p className="admin-service-card__detail">{micDetail}</p>
                <div className="admin-fields-grid admin-fields-grid--voice">
                  <label className="admin-field">
                    <span>{t('Realtime transcript', 'Realtime transcript')}</span>
                    <textarea value={sttPartialText} readOnly placeholder={t('Text t?m th?i s? hi?n ? d?y...', 'Interim text appears here...')} />
                  </label>
                  <label className="admin-field">
                    <span>{t('Final transcript', 'Final transcript')}</span>
                    <textarea value={sttFinalText} readOnly placeholder={t('Text final s? hi?n ? d?y...', 'Final text appears here...')} />
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
                    <p>{t('Ch? d? caption d? theo d?i text li?n t?c, h?u ?ch khi test ? m?i tru?ng ?n ?o.', 'Caption mode helps track continuous text, useful in noisy environments.')}</p>
                  </div>
                  <div className="admin-inline-actions">
                    <button className="admin-btn admin-btn--ghost" type="button" onClick={liveCaption.clear}>
                      {t('X?a caption', 'Clear Caption')}
                    </button>
                    {liveCaption.isListening ? (
                      <button className="admin-btn" type="button" onClick={liveCaption.stop}>
                        {t('D?ng Caption', 'Stop Caption')}
                      </button>
                    ) : (
                      <button className="admin-btn" type="button" onClick={() => void liveCaption.start()}>
                        {t('B?t Caption', 'Start Caption')}
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
                  {liveCaption.backendSupported ? t('c?', 'yes') : t('kh?ng', 'no')}
                </p>
                <div className="admin-fields-grid admin-fields-grid--voice">
                  <label className="admin-field">
                    <span>{t('Caption final', 'Caption final')}</span>
                    <textarea
                      value={liveCaption.finalTranscript}
                      readOnly
                      placeholder={t('Caption final s? t?ch luy ? d?y...', 'Final caption accumulates here...')}
                    />
                  </label>
                  <label className="admin-field">
                    <span>{t('Caption interim', 'Caption interim')}</span>
                    <textarea
                      value={liveCaption.interimTranscript}
                      readOnly
                      placeholder={t('Caption t?m th?i s? c?p nh?t ? d?y...', 'Interim caption updates here...')}
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
                <h3>{t('C?u h?nh thi?t y?u', 'Essential Configuration')}</h3>
                <p>
                  {t(
                    'Nh?m n?y l? d? d? v?n h?nh. Nh?n luu d? d?ng b? ngay v?o index, kh?ng c?n refresh tay.',
                    'This set is enough for daily operation. Save to sync immediately without manual refresh.',
                  )}
                </p>
              </div>
              <div className="admin-inline-actions">
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void handleSaveConfig()}>
                  {t('Luu v? d?ng b?', 'Save And Sync')}
                </button>
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void runHealthChecks()}>
                  {t('Ki?m tra contract Live POS', 'Check Live POS Contract')}
                </button>
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void loadEnvFromFile()}>
                  {t('Nap lai .env', 'Reload .env')}
                </button>
                <button className="admin-btn" type="button" onClick={() => void handleCopyEnv()}>
                  {copied ? t('?? copy', 'Copied') : 'Copy .env'}
                </button>
              </div>
            </header>

            <p className="admin-service-card__detail">
              {t('L?n d?ng b? g?n nh?t', 'Last synced')}:{' '}
              {formatSyncTime(lastSyncAt, uiLanguage)}
            </p>
            <div className="admin-chip-list">
              <p className={`admin-chip admin-chip--${livePosEnabled ? 'warning' : 'ok'}`}>
                {livePosEnabled ? t('Live POS: Remote Strict', 'Live POS: Remote Strict') : t('Menu mode: Local', 'Menu mode: Local')}
              </p>
              <p className={`admin-chip admin-chip--${livePosAuthConfigured ? 'ok' : 'warning'}`}>
                {livePosAuthConfigured ? t('Auth s?n s?ng', 'Auth ready') : t('Auth chua d? c?u h?nh', 'Auth not configured')}
              </p>
              <p className={`admin-chip admin-chip--${envSyncState.status === 'ok' ? 'ok' : envSyncState.status === 'error' ? 'error' : 'warning'}`}>
                {envSyncState.status === 'ok'
                  ? t('ENV d? ghi', 'ENV persisted')
                  : envSyncState.status === 'error'
                    ? t('ENV ghi l?i', 'ENV persist failed')
                    : envSyncState.status === 'saving'
                      ? t('Dang ghi ENV', 'Persisting ENV')
                      : t('ENV chua d?ng b?', 'ENV not synced yet')}
              </p>
            </div>
            {envSyncState.detail ? (
              <p className="admin-service-card__detail">
                {envSyncState.apiBase
                  ? `${envSyncState.detail} (${envSyncState.apiBase})`
                  : envSyncState.detail}
              </p>
            ) : null}
            {livePosValidationError ? (
              <p className="admin-chip admin-chip--error">{livePosValidationError}</p>
            ) : null}
            <p className="admin-service-card__detail">
              {t(
                'Luu y: VITE Core/AI URL co the la local khi chay dev. Menu/gia/dat don van la live POS neu POS Menu Source Mode = Remote Strict.',
                'Note: VITE Core/AI URLs can be local in dev mode. Menu/price/order are still live POS when POS Menu Source Mode = Remote Strict.',
              )}
            </p>

            <div className="admin-fields-grid">
              {essentialFields.map((field) => (
                <label key={field.key} className="admin-field">
                  <span>{field.label}</span>
                  {renderEnvFieldInput(field, handleSaveConfig)}
                </label>
              ))}
            </div>

            <button
              className="admin-btn admin-btn--minimal"
              type="button"
              onClick={() => setShowAdvancedConfig((current) => !current)}
            >
              {showAdvancedConfig
                ? t('?n c?u h?nh n?ng cao', 'Hide Advanced Config')
                : t('M? c?u h?nh n?ng cao', 'Show Advanced Config')}
            </button>

            {showAdvancedConfig ? (
              <div className="admin-fields-grid">
                {advancedFields.map((field) => (
                  <label key={field.key} className="admin-field">
                    <span>{field.label}</span>
                    {renderEnvFieldInput(field, handleSaveConfig)}
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
                    ? t('?ang hi?n th? full c?u h?nh', 'Showing full config')
                    : t('?ang hi?n th? nh?m thi?t y?u', 'Showing essential config')}
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



