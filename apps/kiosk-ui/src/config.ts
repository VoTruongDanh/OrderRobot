const LEGACY_ENV_VALUE_MIGRATIONS: Record<string, Record<string, string>> = {
  VITE_CORE_API_URL: { 'http://127.0.0.1:8001': 'http://127.0.0.1:8011' },
  VITE_AI_API_URL: { 'http://127.0.0.1:8002': 'http://127.0.0.1:8012' },
  VITE_MENU_API_URL: { 'http://127.0.0.1:8001/menu': 'http://127.0.0.1:8011/menu' },
  VITE_ORDERS_API_URL: { 'http://127.0.0.1:8001/orders': 'http://127.0.0.1:8011/orders' },
  VITE_PRODUCT_SIZE_API_URL: { 'http://127.0.0.1:8001/product-size/filter': 'http://127.0.0.1:8011/product-size/filter' },
}

function isLocalDevPort(port: string): boolean {
  return port === '5173' || port === '4173' || port === '3000'
}

function isLocalLikeHost(hostname: string): boolean {
  const host = String(hostname || '').trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isLocalDevBrowserContext(): boolean {
  if (typeof window === 'undefined') return false
  return isLocalDevPort(String(window.location.port || '')) && isLocalLikeHost(window.location.hostname)
}

function parsePositiveStoreId(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!/^\d+$/.test(normalized)) return ''
  const parsed = Number.parseInt(normalized, 10)
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : ''
}

function getDefaultCoreApiFallback(): string {
  if (typeof window !== 'undefined') {
    return isLocalDevBrowserContext() ? 'http://127.0.0.1:8011' : '/api/core'
  }
  return '/api/core'
}

function resolveBrowserSafeCoreApiUrl(coreApiUrl: string): string {
  const rawCoreApi = String(coreApiUrl || '').trim()
  if (!rawCoreApi) {
    return getDefaultCoreApiFallback()
  }
  if (rawCoreApi.startsWith('/')) {
    return rawCoreApi
  }
  try {
    const href = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
    const parsed = new URL(rawCoreApi, href)
    const normalized = parsed.toString().replace(/\/$/, '')
    if (isLocalDevBrowserContext()) {
      return normalized
    }
    const port = String(parsed.port || '')
    if (isLocalLikeHost(parsed.hostname) && (port === '8011' || port === '18011')) {
      return '/api/core'
    }
    return normalized
  } catch {
    return rawCoreApi
  }
}

function getDefaultAiApiFallback(): string {
  return '/api/ai'
}

export const ADMIN_ENV_STORAGE_KEY = 'admin.env.fields'
const ADMIN_ENV_UPDATED_AT_KEY = 'admin.env.updatedAt'
const ADMIN_CONFIG_UPDATED_EVENT = 'orderrobot:admin-config-updated'
const ADMIN_MIC_NOISE_FILTER_KEY = 'admin.mic.noiseFilter'
const ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY = 'admin.mic.noiseFilterStrength'
const ADMIN_ROBOT_SCALE_PERCENT_KEY = 'admin.robot.scalePercent'
const ADMIN_CAMERA_PREVIEW_VISIBLE_KEY = 'admin.camera.previewVisible'
export const ADMIN_ROBOT_STUDIO_CONFIG_KEY = 'admin.robot.studio.v1'
export const ADMIN_ROBOT_STUDIO_COMMAND_KEY = 'admin.robot.studio.command.v1'
const ADMIN_SHARED_STATE_SYNC_DELAY_MS = 250

type SharedAdminStatePayload = {
  robot_scale_percent?: number
  camera_preview_visible?: boolean
  mic_noise_filter_strength?: number
  robot_studio_config?: RobotStudioConfigV1
}

let sharedAdminStateSyncTimer: number | null = null
let adminEnvHydrationInFlight: Promise<boolean> | null = null

const ROBOT_STUDIO_ASSET_DB_NAME = 'orderrobot-robot-studio-assets'
const ROBOT_STUDIO_ASSET_STORE_NAME = 'assets'

export type MicNoiseFilterLevel = 'off' | 'balanced' | 'strong'
export type RobotQualityProfile = 'cinema' | 'standard' | 'lite'
export type RobotExpressiveMode = 'full' | 'family' | 'conservative'
export type RobotSkinPack = 'maid' | 'waiter' | 'cute' | 'anime'
export type RobotGraphNodeType = 'action' | 'wait' | 'condition'
export type RobotGraphConditionSource = 'scene' | 'intent' | 'menu' | 'presence' | 'emotion' | 'action'
export type RobotGraphConditionOperator = 'equals' | 'notEquals' | 'contains'
export type RobotHeadShape = 'soft-square' | 'visor' | 'hex' | 'bubble'
export type RobotHeadAccessory = 'none' | 'antenna' | 'halo' | 'crown'
export type RobotEyeStyle = 'visor' | 'round' | 'anime' | 'mono' | 'happy' | 'wink' | 'surprised' | 'sleepy'
export type RobotMouthStyle = 'line' | 'smile' | 'pixel' | 'none' | 'big-smile' | 'surprised-o' | 'sad' | 'tongue-out'
export type RobotArmStyle = 'sleek' | 'chunky' | 'floating'
export type RobotArmColor = 'aqua' | 'sunset' | 'mint' | 'violet' | 'mono'
export type RobotBodyShape = 'core' | 'shield' | 'orb' | 'compact'
export type RobotOutfitStyle = 'service' | 'street' | 'formal' | 'battle'
export type RobotVisualMode = 'local_glb'

export type RobotStudioSkinMeta = { id: string; label: string; pack: RobotSkinPack }
export type RobotStudioActionMeta = {
  id: string
  label: string
  category: 'core' | 'cinematic' | 'cute' | 'interactive'
}

export type RobotGraphCondition = {
  source: RobotGraphConditionSource
  operator: RobotGraphConditionOperator
  value: string
}

export type RobotGraphNode = {
  id: string
  name: string
  type: RobotGraphNodeType
  actionId?: string
  delayMs?: number
  condition?: RobotGraphCondition
  nextNodeId?: string
  trueNodeId?: string
  falseNodeId?: string
  position: { x: number; y: number }
}

export type RobotStudioGraphDefinition = {
  id: string
  name: string
  startNodeId: string
  nodes: RobotGraphNode[]
}

export type RobotTriggerBinding = {
  id: string
  event: string
  targetType: 'action' | 'graph'
  targetId: string
  enabled: boolean
  conditions: RobotGraphCondition[]
}

export type RobotActionSetting = {
  enabled: boolean
  intensity: number
  speed: number
  cooldownMs: number
}

export type RobotStudioCommand =
  | { type: 'preview-action'; actionId: string }
  | { type: 'run-graph'; graphId: string }
  | { type: 'stop-graph' }

export type RobotStudioAssetMeta = {
  id: string
  name: string
  mimeType: string
  kind: 'png' | 'webp' | 'svg'
  size: number
  updatedAt: number
}

type RobotStudioAssetRecord = RobotStudioAssetMeta & { blob: Blob }

export type RobotAvatarPartsV1 = {
  headShape: RobotHeadShape
  headAccessory: RobotHeadAccessory
  eyeStyle: RobotEyeStyle
  mouthStyle: RobotMouthStyle
  faceFrameScale: number
  faceFrameVisible: boolean
  armStyle: RobotArmStyle
  armColor: RobotArmColor
  bodyShape: RobotBodyShape
  outfitStyle: RobotOutfitStyle
  randomSeed: number
}

export type RobotStudioConfigV1 = {
  schema: 'robotStudio.v1'
  qualityProfile: RobotQualityProfile
  expressiveMode: RobotExpressiveMode
  activeSkinId: string
  enabledSkinIds: string[]
  enabledActions: string[]
  triggerBindings: RobotTriggerBinding[]
  graphBindings: RobotStudioGraphDefinition[]
  effectIntensity: number
  actionSettings: Record<string, RobotActionSetting>
  uploadedAssets: RobotStudioAssetMeta[]
  skinAssetBindings: Record<string, string>
  avatarParts: RobotAvatarPartsV1
  robotVisual: {
    mode: RobotVisualMode
    localModelPath: string
    localModelAnimationName: string
    localModelAutoRotate: boolean
    localModelCameraControls: boolean
    localModelYawDeg: number
    localModelFaceMaterialFix: boolean
  }
  outfitManager: {
    activeProfileId: string
    profiles: Array<{
      id: string
      name: string
      enabled: boolean
      skinId: string
      outfitStyle: RobotOutfitStyle
      textureAssetId: string
    }>
  }
}

const ROBOT_HEAD_SHAPE_OPTIONS = ['soft-square', 'visor', 'hex', 'bubble'] as const
const ROBOT_HEAD_ACCESSORY_OPTIONS = ['none', 'antenna', 'halo', 'crown'] as const
const ROBOT_EYE_STYLE_OPTIONS = ['visor', 'round', 'anime', 'mono', 'happy', 'wink', 'surprised', 'sleepy'] as const
const ROBOT_MOUTH_STYLE_OPTIONS = ['line', 'smile', 'pixel', 'none', 'big-smile', 'surprised-o', 'sad', 'tongue-out'] as const
const ROBOT_ARM_STYLE_OPTIONS = ['sleek', 'chunky', 'floating'] as const
const ROBOT_ARM_COLOR_OPTIONS = ['aqua', 'sunset', 'mint', 'violet', 'mono'] as const
const ROBOT_BODY_SHAPE_OPTIONS = ['core', 'shield', 'orb', 'compact'] as const
const ROBOT_OUTFIT_STYLE_OPTIONS = ['service', 'street', 'formal', 'battle'] as const

export const ROBOT_STUDIO_SKIN_LIBRARY: RobotStudioSkinMeta[] = [
  { id: 'maid-classic', label: 'Maid Classic', pack: 'maid' },
  { id: 'maid-sakura', label: 'Maid Sakura', pack: 'maid' },
  { id: 'maid-midnight', label: 'Maid Midnight', pack: 'maid' },
  { id: 'maid-royal', label: 'Maid Royal', pack: 'maid' },
  { id: 'maid-pastel', label: 'Maid Pastel', pack: 'maid' },
  { id: 'waiter-amber', label: 'Waiter Amber', pack: 'waiter' },
  { id: 'waiter-cobalt', label: 'Waiter Cobalt', pack: 'waiter' },
  { id: 'waiter-olive', label: 'Waiter Olive', pack: 'waiter' },
  { id: 'waiter-charcoal', label: 'Waiter Charcoal', pack: 'waiter' },
  { id: 'waiter-sunrise', label: 'Waiter Sunrise', pack: 'waiter' },
  { id: 'cute-cotton', label: 'Cute Cotton', pack: 'cute' },
  { id: 'cute-berry', label: 'Cute Berry', pack: 'cute' },
  { id: 'cute-mintpop', label: 'Cute Mintpop', pack: 'cute' },
  { id: 'cute-lemon', label: 'Cute Lemon', pack: 'cute' },
  { id: 'cute-cloud', label: 'Cute Cloud', pack: 'cute' },
  { id: 'anime-luna', label: 'Anime Luna', pack: 'anime' },
  { id: 'anime-starlight', label: 'Anime Starlight', pack: 'anime' },
  { id: 'anime-neonfox', label: 'Anime Neonfox', pack: 'anime' },
  { id: 'anime-fantasyrose', label: 'Anime Fantasyrose', pack: 'anime' },
  { id: 'anime-aurora', label: 'Anime Aurora', pack: 'anime' },
]
export const ROBOT_STUDIO_ACTION_LIBRARY: RobotStudioActionMeta[] = [
  { id: 'plasmaSurge', label: 'Plasma Surge', category: 'cinematic' },
  { id: 'heroLanding', label: 'Hero Landing', category: 'cinematic' },
  { id: 'zeroG', label: 'Zero G Orbit', category: 'cinematic' },
  { id: 'dance', label: 'Disco Dance', category: 'cinematic' },
  { id: 'scan', label: 'Scan Pulse', category: 'core' },
  { id: 'glitch', label: 'Glitch Shake', category: 'core' },
  { id: 'overdrive', label: 'Overdrive', category: 'cinematic' },
  { id: 'waveHello', label: 'Wave Hello', category: 'interactive' },
  { id: 'nodYes', label: 'Nod Yes', category: 'interactive' },
  { id: 'bowElegant', label: 'Bow Elegant', category: 'interactive' },
  { id: 'spinTwirl', label: 'Spin Twirl', category: 'cinematic' },
  { id: 'jumpJoy', label: 'Jump Joy', category: 'interactive' },
  { id: 'lightPulse', label: 'Light Pulse', category: 'core' },
  { id: 'laserSweep', label: 'Laser Sweep', category: 'cinematic' },
  { id: 'confettiBurst', label: 'Confetti Burst', category: 'cinematic' },
  { id: 'blowKissHearts', label: 'Blow Kiss Hearts', category: 'cute' },
  { id: 'winkPulse', label: 'Wink Pulse', category: 'cute' },
  { id: 'blushShy', label: 'Blush Shy', category: 'cute' },
  { id: 'heartRain', label: 'Heart Rain', category: 'cute' },
  { id: 'cheerSparkle', label: 'Cheer Sparkle', category: 'cute' },
  { id: 'noseScrunch', label: 'Nose Scrunch', category: 'cute' },
  { id: 'smileBounce', label: 'Smile Bounce', category: 'cute' },
  { id: 'hugGesture', label: 'Hug Gesture', category: 'cute' },
  { id: 'clapHappy', label: 'Clap Happy', category: 'interactive' },
  { id: 'peacePose', label: 'Peace Pose', category: 'interactive' },
  { id: 'maidCurtseyBloom', label: 'Maid Curtsey Bloom', category: 'interactive' },
  { id: 'waiterServingSpin', label: 'Waiter Serving Spin', category: 'interactive' },
  { id: 'animeStarTrail', label: 'Anime Star Trail', category: 'cinematic' },
  { id: 'pixelHeartStorm', label: 'Pixel Heart Storm', category: 'cute' },
  { id: 'auroraOrbit', label: 'Aurora Orbit', category: 'cinematic' },
]

const ROBOT_STUDIO_REQUIRED_ACTIONS_FOR_LEGACY = [
  'maidCurtseyBloom',
  'waiterServingSpin',
  'animeStarTrail',
  'pixelHeartStorm',
  'auroraOrbit',
] as const

const ROBOT_STUDIO_TRIGGER_EVENT_OPTIONS = [
  'button.heroLanding',
  'button.dance',
  'button.plasmaSurge',
  'button.zeroG',
  'presence.enter',
  'presence.leave',
  'voice.intent.menuOpen',
  'voice.intent.menuClose',
  'voice.scene.greeting',
  'voice.scene.recommendation',
  'voice.scene.cart_updated',
  'voice.scene.order_created',
  'voice.scene.fallback',
] as const

const ALLOWED_UPLOAD_MIME_TYPES = new Set(['image/png', 'image/webp', 'image/svg+xml'])

function clampRobotScalePercent(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.max(60, Math.min(170, Math.round(value)))
}

function clampMicStrength(value: number): number {
  if (!Number.isFinite(value)) return 60
  return Math.max(0, Math.min(100, Math.round(value)))
}

function clampEffectIntensity(value: number): number {
  if (!Number.isFinite(value)) return 85
  return Math.max(0, Math.min(100, Math.round(value)))
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 82
  return Math.max(0, Math.min(100, Math.round(value)))
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(0.25, Math.min(3, Number(value.toFixed(2))))
}

function clampCooldown(value: number): number {
  if (!Number.isFinite(value)) return 350
  return Math.max(0, Math.min(15000, Math.round(value)))
}

function clampAvatarSeed(value: number): number {
  if (!Number.isFinite(value)) return 420
  return Math.max(0, Math.min(999999, Math.round(value)))
}

function clampFaceFrameScale(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.max(65, Math.min(145, Math.round(value)))
}

function pickEnumOption<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  const safe = String(value || '') as T
  return options.includes(safe) ? safe : fallback
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function defaultActionSettings(actionIds: string[]): Record<string, RobotActionSetting> {
  return Object.fromEntries(
    actionIds.map((actionId) => [actionId, { enabled: true, intensity: 82, speed: 1, cooldownMs: 350 }]),
  )
}

function defaultGraphs(): RobotStudioGraphDefinition[] {
  return [
    {
      id: 'graph-greeting-welcome',
      name: 'Greeting Welcome',
      startNodeId: 'gw-1',
      nodes: [
        { id: 'gw-1', name: 'Wave', type: 'action', actionId: 'waveHello', nextNodeId: 'gw-2', position: { x: 24, y: 24 } },
        {
          id: 'gw-2',
          name: 'Cute Branch',
          type: 'condition',
          condition: { source: 'emotion', operator: 'contains', value: 'cute' },
          trueNodeId: 'gw-3',
          falseNodeId: 'gw-4',
          position: { x: 260, y: 24 },
        },
        { id: 'gw-3', name: 'Blow Kiss', type: 'action', actionId: 'blowKissHearts', position: { x: 520, y: -6 } },
        { id: 'gw-4', name: 'Smile Bounce', type: 'action', actionId: 'smileBounce', position: { x: 520, y: 86 } },
      ],
    },
    {
      id: 'graph-order-celebration',
      name: 'Order Celebration',
      startNodeId: 'oc-1',
      nodes: [
        { id: 'oc-1', name: 'Sparkle', type: 'action', actionId: 'cheerSparkle', nextNodeId: 'oc-2', position: { x: 24, y: 24 } },
        { id: 'oc-2', name: 'Confetti', type: 'action', actionId: 'confettiBurst', nextNodeId: 'oc-3', position: { x: 260, y: 24 } },
        { id: 'oc-3', name: 'Peace', type: 'action', actionId: 'peacePose', position: { x: 510, y: 24 } },
      ],
    },
  ]
}

function defaultTriggerBindings(): RobotTriggerBinding[] {
  return [
    { id: 'trigger-presence-enter', event: 'presence.enter', targetType: 'graph', targetId: 'graph-greeting-welcome', enabled: true, conditions: [] },
    { id: 'trigger-order-created', event: 'voice.scene.order_created', targetType: 'graph', targetId: 'graph-order-celebration', enabled: true, conditions: [] },
    { id: 'trigger-button-hero', event: 'button.heroLanding', targetType: 'action', targetId: 'heroLanding', enabled: true, conditions: [] },
  ]
}

export function createDefaultRobotAvatarParts(): RobotAvatarPartsV1 {
  return {
    headShape: 'visor',
    headAccessory: 'none',
    eyeStyle: 'visor',
    mouthStyle: 'line',
    faceFrameScale: 100,
    faceFrameVisible: true,
    armStyle: 'sleek',
    armColor: 'aqua',
    bodyShape: 'core',
    outfitStyle: 'service',
    randomSeed: 420,
  }
}

export function createDefaultRobotStudioConfig(): RobotStudioConfigV1 {
  const defaultActionIds = ROBOT_STUDIO_ACTION_LIBRARY.map((item) => item.id)
  const defaultSkinIds = ROBOT_STUDIO_SKIN_LIBRARY.map((item) => item.id)
  return {
    schema: 'robotStudio.v1',
    qualityProfile: 'cinema',
    expressiveMode: 'full',
    activeSkinId: defaultSkinIds[0] ?? 'maid-classic',
    enabledSkinIds: defaultSkinIds,
    enabledActions: [...defaultActionIds],
    triggerBindings: defaultTriggerBindings(),
    graphBindings: defaultGraphs(),
    effectIntensity: 85,
    actionSettings: defaultActionSettings(defaultActionIds),
    uploadedAssets: [],
    skinAssetBindings: {},
    avatarParts: createDefaultRobotAvatarParts(),
    robotVisual: {
      mode: 'local_glb',
      localModelPath: '',
      localModelAnimationName: '',
      localModelAutoRotate: false,
      localModelCameraControls: false,
      localModelYawDeg: 0,
      localModelFaceMaterialFix: true,
    },
    outfitManager: {
      activeProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default Outfit',
          enabled: true,
          skinId: defaultSkinIds[0] ?? 'maid-classic',
          outfitStyle: 'service',
          textureAssetId: '',
        },
      ],
    },
  }
}
function normalizeRobotStudioConfig(raw: unknown): RobotStudioConfigV1 {
  const defaults = createDefaultRobotStudioConfig()
  if (!isObject(raw)) return defaults

  const actionIds = ROBOT_STUDIO_ACTION_LIBRARY.map((item) => item.id)
  const skinIds = new Set(ROBOT_STUDIO_SKIN_LIBRARY.map((item) => item.id))

  const enabledActions = Array.isArray(raw.enabledActions)
    ? raw.enabledActions.map((item) => String(item)).filter((item) => actionIds.includes(item))
    : defaults.enabledActions

  const hasAnyRequiredActionInEnabled = enabledActions.some((actionId) =>
    ROBOT_STUDIO_REQUIRED_ACTIONS_FOR_LEGACY.includes(actionId as (typeof ROBOT_STUDIO_REQUIRED_ACTIONS_FOR_LEGACY)[number]),
  )
  const rawActionSettings = isObject(raw.actionSettings) ? raw.actionSettings : null
  const hasAnyRequiredActionInSettings = rawActionSettings
    ? ROBOT_STUDIO_REQUIRED_ACTIONS_FOR_LEGACY.some((actionId) => Boolean(rawActionSettings[actionId]))
    : false
  const shouldUpgradeLegacyActionCatalog = !hasAnyRequiredActionInEnabled && !hasAnyRequiredActionInSettings
  const upgradedEnabledActions = shouldUpgradeLegacyActionCatalog
    ? Array.from(new Set([...enabledActions, ...ROBOT_STUDIO_REQUIRED_ACTIONS_FOR_LEGACY]))
    : enabledActions

  const actionSettings = defaultActionSettings(actionIds)
  if (rawActionSettings) {
    for (const actionId of actionIds) {
      const next = rawActionSettings[actionId]
      if (!isObject(next)) continue
      actionSettings[actionId] = {
        enabled: next.enabled !== false,
        intensity: clampIntensity(Number(next.intensity ?? actionSettings[actionId].intensity)),
        speed: clampSpeed(Number(next.speed ?? actionSettings[actionId].speed)),
        cooldownMs: clampCooldown(Number(next.cooldownMs ?? actionSettings[actionId].cooldownMs)),
      }
    }
  }

  const graphBindings = Array.isArray(raw.graphBindings)
    ? (raw.graphBindings as RobotStudioGraphDefinition[]).filter((graph) => graph && graph.id && Array.isArray(graph.nodes) && graph.nodes.length > 0)
    : defaults.graphBindings

  const triggerBindings = Array.isArray(raw.triggerBindings)
    ? (raw.triggerBindings as RobotTriggerBinding[]).filter(
        (binding) =>
          Boolean(binding?.id) &&
          Boolean(binding?.targetId) &&
          (binding?.targetType === 'action' || binding?.targetType === 'graph') &&
          ROBOT_STUDIO_TRIGGER_EVENT_OPTIONS.includes(binding?.event as (typeof ROBOT_STUDIO_TRIGGER_EVENT_OPTIONS)[number]),
      )
    : defaults.triggerBindings

  const uploadedAssets = Array.isArray(raw.uploadedAssets)
    ? (raw.uploadedAssets as RobotStudioAssetMeta[]).filter((asset) =>
        Boolean(asset?.id && asset?.name && asset?.mimeType && asset?.kind),
      )
    : []

  const skinAssetBindings: Record<string, string> = {}
  if (isObject(raw.skinAssetBindings)) {
    for (const [skinId, assetId] of Object.entries(raw.skinAssetBindings)) {
      const safeSkin = String(skinId)
      const safeAsset = String(assetId || '').trim()
      if (skinIds.has(safeSkin) && safeAsset) {
        skinAssetBindings[safeSkin] = safeAsset
      }
    }
  }

  const qualityProfile = ['cinema', 'standard', 'lite'].includes(String(raw.qualityProfile))
    ? (raw.qualityProfile as RobotQualityProfile)
    : defaults.qualityProfile

  const expressiveMode = ['full', 'family', 'conservative'].includes(String(raw.expressiveMode))
    ? (raw.expressiveMode as RobotExpressiveMode)
    : defaults.expressiveMode

  const activeSkinCandidate = String(raw.activeSkinId || defaults.activeSkinId)
  const enabledSkinIds = Array.isArray(raw.enabledSkinIds)
    ? raw.enabledSkinIds.map((item) => String(item)).filter((item) => skinIds.has(item))
    : defaults.enabledSkinIds
  const avatarRaw = isObject(raw.avatarParts) ? raw.avatarParts : {}
  const avatarDefaults = defaults.avatarParts
  const robotVisualRaw = isObject(raw.robotVisual) ? raw.robotVisual : {}
  const robotVisualDefaults = defaults.robotVisual
  const outfitManagerRaw = isObject(raw.outfitManager) ? raw.outfitManager : {}
  const outfitManagerDefaults = defaults.outfitManager
  const profilesRaw = Array.isArray(outfitManagerRaw.profiles) ? outfitManagerRaw.profiles : []
  const profiles = profilesRaw
    .filter((item) => isObject(item))
    .map((item) => {
      const profile = item as Record<string, unknown>
      return {
        id: String(profile.id || '').trim(),
        name: String(profile.name || '').trim(),
        enabled: profile.enabled !== false,
        skinId: skinIds.has(String(profile.skinId || '')) ? String(profile.skinId) : defaults.activeSkinId,
        outfitStyle: pickEnumOption(profile.outfitStyle, ROBOT_OUTFIT_STYLE_OPTIONS, avatarDefaults.outfitStyle),
        textureAssetId: String(profile.textureAssetId || '').trim(),
      }
    })
    .filter((item) => item.id.length > 0)
  const activeProfileId = String(outfitManagerRaw.activeProfileId || '').trim()
  const safeProfiles = profiles.length > 0 ? profiles : outfitManagerDefaults.profiles

  return {
    schema: 'robotStudio.v1',
    qualityProfile,
    expressiveMode,
    activeSkinId: skinIds.has(activeSkinCandidate) ? activeSkinCandidate : defaults.activeSkinId,
    enabledSkinIds: enabledSkinIds.length > 0 ? enabledSkinIds : defaults.enabledSkinIds,
    enabledActions: upgradedEnabledActions.length > 0 ? upgradedEnabledActions : defaults.enabledActions,
    triggerBindings,
    graphBindings: graphBindings.length > 0 ? graphBindings : defaults.graphBindings,
    effectIntensity: clampEffectIntensity(Number(raw.effectIntensity ?? defaults.effectIntensity)),
    actionSettings,
    uploadedAssets,
    skinAssetBindings,
    avatarParts: {
      headShape: pickEnumOption(avatarRaw.headShape, ROBOT_HEAD_SHAPE_OPTIONS, avatarDefaults.headShape),
      headAccessory: pickEnumOption(avatarRaw.headAccessory, ROBOT_HEAD_ACCESSORY_OPTIONS, avatarDefaults.headAccessory),
      eyeStyle: pickEnumOption(avatarRaw.eyeStyle, ROBOT_EYE_STYLE_OPTIONS, avatarDefaults.eyeStyle),
      mouthStyle: pickEnumOption(avatarRaw.mouthStyle, ROBOT_MOUTH_STYLE_OPTIONS, avatarDefaults.mouthStyle),
      faceFrameScale: clampFaceFrameScale(Number(avatarRaw.faceFrameScale ?? avatarDefaults.faceFrameScale)),
      faceFrameVisible:
        typeof avatarRaw.faceFrameVisible === 'boolean'
          ? avatarRaw.faceFrameVisible
          : avatarDefaults.faceFrameVisible,
      armStyle: pickEnumOption(avatarRaw.armStyle, ROBOT_ARM_STYLE_OPTIONS, avatarDefaults.armStyle),
      armColor: pickEnumOption(avatarRaw.armColor, ROBOT_ARM_COLOR_OPTIONS, avatarDefaults.armColor),
      bodyShape: pickEnumOption(avatarRaw.bodyShape, ROBOT_BODY_SHAPE_OPTIONS, avatarDefaults.bodyShape),
      outfitStyle: pickEnumOption(avatarRaw.outfitStyle, ROBOT_OUTFIT_STYLE_OPTIONS, avatarDefaults.outfitStyle),
      randomSeed: clampAvatarSeed(Number(avatarRaw.randomSeed ?? avatarDefaults.randomSeed)),
    },
    robotVisual: {
      mode: 'local_glb',
      localModelPath: String(robotVisualRaw.localModelPath ?? robotVisualDefaults.localModelPath).trim(),
      localModelAnimationName: String(
        robotVisualRaw.localModelAnimationName ?? robotVisualDefaults.localModelAnimationName,
      ).trim(),
      localModelAutoRotate:
        typeof robotVisualRaw.localModelAutoRotate === 'boolean'
          ? robotVisualRaw.localModelAutoRotate
          : robotVisualDefaults.localModelAutoRotate,
      localModelCameraControls:
        typeof robotVisualRaw.localModelCameraControls === 'boolean'
          ? robotVisualRaw.localModelCameraControls
          : robotVisualDefaults.localModelCameraControls,
      localModelYawDeg: Number.isFinite(Number(robotVisualRaw.localModelYawDeg))
        ? Math.max(-180, Math.min(180, Math.round(Number(robotVisualRaw.localModelYawDeg))))
        : robotVisualDefaults.localModelYawDeg,
      localModelFaceMaterialFix:
        typeof robotVisualRaw.localModelFaceMaterialFix === 'boolean'
          ? robotVisualRaw.localModelFaceMaterialFix
          : robotVisualDefaults.localModelFaceMaterialFix,
    },
    outfitManager: {
      activeProfileId: safeProfiles.some((profile) => profile.id === activeProfileId)
        ? activeProfileId
        : safeProfiles[0]?.id || outfitManagerDefaults.activeProfileId,
      profiles: safeProfiles,
    },
  }
}

function readSavedAdminEnv(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(ADMIN_ENV_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}

function emitAdminConfigUpdated(detail: Record<string, unknown>): void {
  const updatedAt = Date.now()
  localStorage.setItem(ADMIN_ENV_UPDATED_AT_KEY, String(updatedAt))
  window.dispatchEvent(new CustomEvent(ADMIN_CONFIG_UPDATED_EVENT, { detail: { updatedAt, ...detail } }))
}

export function normalizeEnvValue(key: string, value: string): string {
  return LEGACY_ENV_VALUE_MIGRATIONS[key]?.[value] ?? value
}

export function saveAdminEnvConfig(nextConfig: Record<string, string>): void {
  const normalized = Object.fromEntries(
    Object.entries(nextConfig).map(([key, value]) => [key, normalizeEnvValue(key, String(value ?? ''))]),
  )
  localStorage.setItem(ADMIN_ENV_STORAGE_KEY, JSON.stringify(normalized))
  emitAdminConfigUpdated({ config: normalized })
}

export async function hydrateAdminEnvConfigFromServer(): Promise<boolean> {
  if (adminEnvHydrationInFlight) {
    return adminEnvHydrationInFlight
  }
  adminEnvHydrationInFlight = (async () => {
    try {
      const response = await fetch(`${getAdminSharedStateApiBase()}/config/env/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [] }),
      })
      if (!response.ok) return false
      const payload = (await response.json()) as { fields?: Record<string, string> }
      const fields = payload?.fields
      if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
        return false
      }
      saveAdminEnvConfig(fields)
      return true
    } catch {
      return false
    } finally {
      adminEnvHydrationInFlight = null
    }
  })()
  return adminEnvHydrationInFlight
}

export function subscribeAdminConfigChanges(onChange: () => void): () => void {
  const handleCustomEvent = () => onChange()
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === ADMIN_ENV_STORAGE_KEY ||
      event.key === ADMIN_ENV_UPDATED_AT_KEY ||
      event.key === ADMIN_ROBOT_STUDIO_CONFIG_KEY ||
      event.key === ADMIN_ROBOT_STUDIO_COMMAND_KEY
    ) {
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
    if (saved?.[key]) return normalizeEnvValue(key, saved[key])
  } catch {
    // ignore
  }
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
    return normalizeEnvValue(key, import.meta.env[key] as string)
  }
  return defaultValue
}

export function getAllAdminEnvConfig(): Record<string, string> {
  const saved = readSavedAdminEnv()
  if (!saved) return {}
  return Object.fromEntries(
    Object.entries(saved).map(([key, value]) => [key, normalizeEnvValue(key, value)]),
  )
}

export function getAdminConfigUpdatedAt(): number | null {
  const raw = localStorage.getItem(ADMIN_ENV_UPDATED_AT_KEY)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function getCoreApiUrl(): string {
  return resolveBrowserSafeCoreApiUrl(getEnvConfig('VITE_CORE_API_URL', getDefaultCoreApiFallback()))
}

export function getAiApiUrl(): string {
  const configured = getEnvConfig('VITE_AI_API_URL', getDefaultAiApiFallback())
  return resolveBrowserSafeAiApiUrl(configured)
}

function getAdminSharedStateApiBase(): string {
  return String(getAiApiUrl() || '/api/ai').replace(/\/+$/, '')
}

function buildSharedAdminStatePayload(): SharedAdminStatePayload {
  return {
    robot_scale_percent: getRobotScalePercent(),
    camera_preview_visible: getCameraPreviewVisible(),
    mic_noise_filter_strength: getMicNoiseFilterStrength(),
    robot_studio_config: getRobotStudioConfig(),
  }
}

async function persistSharedAdminStateNow(): Promise<void> {
  const apiBase = getAdminSharedStateApiBase()
  await fetch(`${apiBase}/config/admin-state/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSharedAdminStatePayload()),
  })
}

function scheduleSharedAdminStateSync(): void {
  if (typeof window === 'undefined') return
  if (sharedAdminStateSyncTimer !== null) {
    window.clearTimeout(sharedAdminStateSyncTimer)
  }
  sharedAdminStateSyncTimer = window.setTimeout(() => {
    sharedAdminStateSyncTimer = null
    void persistSharedAdminStateNow().catch(() => {
      // Shared sync is best-effort; local storage remains the immediate source on the current device.
    })
  }, ADMIN_SHARED_STATE_SYNC_DELAY_MS)
}

export async function hydrateSharedAdminStateFromServer(): Promise<boolean> {
  const apiBase = getAdminSharedStateApiBase()
  let payload: { fields?: SharedAdminStatePayload } | null = null
  try {
    const response = await fetch(`${apiBase}/config/admin-state/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) {
      return false
    }
    payload = (await response.json()) as { fields?: SharedAdminStatePayload }
  } catch {
    return false
  }

  const fields = payload?.fields
  if (!fields || typeof fields !== 'object') {
    return false
  }

  if (Object.keys(fields).length === 0) {
    const hasExplicitLocalSharedState =
      localStorage.getItem(ADMIN_ROBOT_SCALE_PERCENT_KEY) !== null ||
      localStorage.getItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY) !== null ||
      localStorage.getItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY) !== null ||
      localStorage.getItem(ADMIN_ROBOT_STUDIO_CONFIG_KEY) !== null
    if (hasExplicitLocalSharedState) {
      try {
        await persistSharedAdminStateNow()
        return true
      } catch {
        return false
      }
    }
    return false
  }

  let changed = false

  if (typeof fields.robot_scale_percent === 'number') {
    const nextScale = clampRobotScalePercent(fields.robot_scale_percent)
    if (String(nextScale) !== String(localStorage.getItem(ADMIN_ROBOT_SCALE_PERCENT_KEY) ?? '')) {
      localStorage.setItem(ADMIN_ROBOT_SCALE_PERCENT_KEY, String(nextScale))
      changed = true
    }
  }

  if (typeof fields.camera_preview_visible === 'boolean') {
    const nextVisible = String(Boolean(fields.camera_preview_visible))
    if (nextVisible !== String(localStorage.getItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY) ?? '')) {
      localStorage.setItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY, nextVisible)
      changed = true
    }
  }

  if (typeof fields.mic_noise_filter_strength === 'number') {
    const nextStrength = clampMicStrength(fields.mic_noise_filter_strength)
    if (String(nextStrength) !== String(localStorage.getItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY) ?? '')) {
      localStorage.setItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY, String(nextStrength))
      localStorage.setItem(ADMIN_MIC_NOISE_FILTER_KEY, getMicNoiseFilterLevelFromStrength(nextStrength))
      changed = true
    }
  }

  if (fields.robot_studio_config && typeof fields.robot_studio_config === 'object') {
    const nextConfig = normalizeRobotStudioConfig(fields.robot_studio_config)
    const nextRaw = JSON.stringify(nextConfig)
    if (nextRaw !== String(localStorage.getItem(ADMIN_ROBOT_STUDIO_CONFIG_KEY) || '')) {
      localStorage.setItem(ADMIN_ROBOT_STUDIO_CONFIG_KEY, nextRaw)
      changed = true
    }
  }

  if (changed) {
    emitAdminConfigUpdated({ source: 'shared-admin-state' })
  }
  return changed
}

export function getCurrentStoreId(): string {
  if (typeof window === 'undefined') return ''
  const searchParams = new URLSearchParams(window.location.search || '')
  const path = String(window.location.pathname || '')
  const candidates = [
    searchParams.get('storeid'),
    searchParams.get('storeId'),
    searchParams.get('store_id'),
  ]
  const pathMatch =
    path.match(/(?:^|\/)storeid=(\d+)(?:\/)?$/i) ||
    path.match(/(?:^|\/)store[_-]?id[=/](\d+)(?:\/|$)/i)
  if (pathMatch?.[1]) {
    candidates.push(pathMatch[1])
  }
  for (const candidate of candidates) {
    const safeStoreId = parsePositiveStoreId(candidate)
    if (safeStoreId) return safeStoreId
  }
  return ''
}

export function getCurrentTableId(): string {
  if (typeof window === 'undefined') return ''
  const searchParams = new URLSearchParams(window.location.search || '')
  const path = String(window.location.pathname || '')
  const candidates = [
    searchParams.get('tableid'),
    searchParams.get('tableId'),
    searchParams.get('table_id'),
  ]
  const pathMatch =
    path.match(/(?:^|\/)tableid=(\d+)(?:\/)?$/i) ||
    path.match(/(?:^|\/)table[_-]?id[=/](\d+)(?:\/|$)/i)
  if (pathMatch?.[1]) {
    candidates.push(pathMatch[1])
  }
  for (const candidate of candidates) {
    const safeTableId = parsePositiveStoreId(candidate)
    if (safeTableId) return safeTableId
  }
  return ''
}

export function appendStoreContextToUrl(rawUrl: string): string {
  const safeUrl = String(rawUrl || '').trim()
  const currentStoreId = getCurrentStoreId()
  if (!safeUrl || !currentStoreId) return safeUrl
  try {
    const href = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
    const parsed = new URL(safeUrl, href)
    const pathname = String(parsed.pathname || '')
    if (
      pathname.endsWith('/menu') ||
      pathname.includes('/menu/') ||
      pathname.includes('/menu/proxy') ||
      pathname.endsWith('/orders')
    ) {
      parsed.searchParams.set('store_id', currentStoreId)
      return parsed.toString()
    }
    if (pathname.includes('product-availability/filter')) {
      parsed.searchParams.set('storeId', currentStoreId)
      return parsed.toString()
    }
    return parsed.toString()
  } catch {
    return safeUrl
  }
}

export function resolveBrowserSafeAiApiUrl(aiApiUrl: string): string {
  const rawAiApi = String(aiApiUrl || '').trim()
  if (!rawAiApi) {
    return getDefaultAiApiFallback()
  }
  if (rawAiApi.startsWith('/')) {
    return rawAiApi
  }
  try {
    const href = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const currentProtocol = typeof window !== 'undefined' ? window.location.protocol : 'http:'
    const parsed = new URL(rawAiApi, href)
    const sameOrigin = parsed.origin === origin
    if (sameOrigin) {
      return parsed.toString()
    }
    // In local/dev-like browser contexts (including docker-exposed localhost ports),
    // keep explicit localhost AI URLs instead of forcing /api/ai reverse proxy paths.
    if (isLocalDevBrowserContext()) {
      return parsed.toString()
    }
    if (currentProtocol === 'https:' && parsed.protocol === 'http:') {
      return '/api/ai'
    }
    if (isLocalLikeHost(parsed.hostname)) {
      return '/api/ai'
    }
    return parsed.toString()
  } catch {
    return rawAiApi
  }
}

export function resolveBrowserSafeMenuApiUrl(menuApiUrl: string, coreApiUrl: string): string {
  const rawMenuApi = String(menuApiUrl || '').trim()
  if (!rawMenuApi) {
    return `${String(coreApiUrl || '').replace(/\/$/, '')}/menu`
  }
  if (rawMenuApi.startsWith('/')) {
    return rawMenuApi
  }
  try {
    const href = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const parsed = new URL(rawMenuApi, href)
    const sameOrigin = parsed.origin === origin
    if (sameOrigin || isLocalLikeHost(parsed.hostname)) {
      return parsed.toString()
    }
    const safeCore = String(coreApiUrl || '').trim().replace(/\/$/, '')
    if (!safeCore) return parsed.toString()
    return `${safeCore}/menu/proxy?source=${encodeURIComponent(parsed.toString())}`
  } catch {
    return rawMenuApi
  }
}

export function getMenuApiUrl(): string {
  const coreApiUrl = getCoreApiUrl()
  const configured = getEnvConfig('VITE_MENU_API_URL', `${coreApiUrl}/menu`)
  return appendStoreContextToUrl(resolveBrowserSafeMenuApiUrl(configured, coreApiUrl))
}

export function getOrdersApiUrl(): string {
  return appendStoreContextToUrl(getEnvConfig('VITE_ORDERS_API_URL', `${getCoreApiUrl()}/orders`))
}
export function getProductSizeApiUrl(): string {
  return getEnvConfig(
    'VITE_PRODUCT_SIZE_API_URL',
    'http://cnxvn.ddns.net:8080/api/v1/product-size/filter?productId={productId}&page=0&size=10&sort=',
  )
}

export function getProductDefaultSizeName(): string {
  return getEnvConfig('VITE_PRODUCT_DEFAULT_SIZE_NAME', 'M').trim()
}

export function getMicNoiseFilterLevel(): MicNoiseFilterLevel {
  const strength = getMicNoiseFilterStrength()
  return getMicNoiseFilterLevelFromStrength(strength)
}

export function getMicNoiseFilterStrength(): number {
  const rawStrength = localStorage.getItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY)
  if (rawStrength !== null) {
    return clampMicStrength(Number(rawStrength))
  }
  const saved = localStorage.getItem(ADMIN_MIC_NOISE_FILTER_KEY)
  if (saved === 'off') return 0
  if (saved === 'strong') return 100
  return 60
}

export function getMicNoiseFilterLevelFromStrength(strength: number): MicNoiseFilterLevel {
  if (strength <= 20) return 'off'
  if (strength >= 75) return 'strong'
  return 'balanced'
}

export function setMicNoiseFilterLevel(level: MicNoiseFilterLevel): void {
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_KEY, level)
  const mappedStrength = level === 'off' ? 0 : level === 'strong' ? 100 : 60
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY, String(mappedStrength))
  emitAdminConfigUpdated({ micNoiseFilterStrength: mappedStrength })
  scheduleSharedAdminStateSync()
}

export function setMicNoiseFilterStrength(strength: number): void {
  const safeStrength = clampMicStrength(strength)
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_STRENGTH_KEY, String(safeStrength))
  localStorage.setItem(ADMIN_MIC_NOISE_FILTER_KEY, getMicNoiseFilterLevelFromStrength(safeStrength))
  emitAdminConfigUpdated({ micNoiseFilterStrength: safeStrength })
  scheduleSharedAdminStateSync()
}

export function getRobotScalePercent(): number {
  const raw = localStorage.getItem(ADMIN_ROBOT_SCALE_PERCENT_KEY)
  if (raw === null) return 100
  return clampRobotScalePercent(Number(raw))
}

export function setRobotScalePercent(scalePercent: number): void {
  const safeValue = clampRobotScalePercent(scalePercent)
  localStorage.setItem(ADMIN_ROBOT_SCALE_PERCENT_KEY, String(safeValue))
  emitAdminConfigUpdated({ robotScalePercent: safeValue })
  scheduleSharedAdminStateSync()
}

export function getCameraPreviewVisible(): boolean {
  const raw = localStorage.getItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY)
  if (raw === null) return true
  return raw !== 'false'
}

export function setCameraPreviewVisible(visible: boolean): void {
  localStorage.setItem(ADMIN_CAMERA_PREVIEW_VISIBLE_KEY, String(Boolean(visible)))
  emitAdminConfigUpdated({ cameraPreviewVisible: Boolean(visible) })
  scheduleSharedAdminStateSync()
}

export function getRobotStudioConfig(): RobotStudioConfigV1 {
  const raw = localStorage.getItem(ADMIN_ROBOT_STUDIO_CONFIG_KEY)
  if (!raw) return createDefaultRobotStudioConfig()
  try {
    return normalizeRobotStudioConfig(JSON.parse(raw) as unknown)
  } catch {
    return createDefaultRobotStudioConfig()
  }
}

export function setRobotStudioConfig(nextConfig: RobotStudioConfigV1): RobotStudioConfigV1 {
  const normalized = normalizeRobotStudioConfig(nextConfig)
  localStorage.setItem(ADMIN_ROBOT_STUDIO_CONFIG_KEY, JSON.stringify(normalized))
  emitAdminConfigUpdated({ robotStudioConfig: normalized })
  scheduleSharedAdminStateSync()
  return normalized
}

export function sendRobotStudioCommand(command: RobotStudioCommand): void {
  const safe =
    command.type === 'preview-action'
      ? { type: 'preview-action' as const, actionId: String(command.actionId || '').trim() }
      : command.type === 'run-graph'
        ? { type: 'run-graph' as const, graphId: String(command.graphId || '').trim() }
        : { type: 'stop-graph' as const }

  if (safe.type === 'preview-action' && !safe.actionId) return
  if (safe.type === 'run-graph' && !safe.graphId) return

  const payload = { ...safe, issuedAt: Date.now() }
  localStorage.setItem(ADMIN_ROBOT_STUDIO_COMMAND_KEY, JSON.stringify(payload))
  emitAdminConfigUpdated({ robotStudioCommand: payload })
}

export function updateRobotStudioConfig(
  updater: (current: RobotStudioConfigV1) => RobotStudioConfigV1,
): RobotStudioConfigV1 {
  const current = getRobotStudioConfig()
  return setRobotStudioConfig(updater(current))
}

function openRobotStudioAssetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(ROBOT_STUDIO_ASSET_DB_NAME, 1)
    request.onerror = () => reject(request.error ?? new Error('Cannot open robot studio asset DB'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ROBOT_STUDIO_ASSET_STORE_NAME)) {
        db.createObjectStore(ROBOT_STUDIO_ASSET_STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function readIdbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function withAssetStore<T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return openRobotStudioAssetDb().then(async (db) => {
    try {
      const transaction = db.transaction(ROBOT_STUDIO_ASSET_STORE_NAME, mode)
      const store = transaction.objectStore(ROBOT_STUDIO_ASSET_STORE_NAME)
      const result = await task(store)
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      return result
    } finally {
      db.close()
    }
  })
}

function inferUploadMimeType(file: File): string {
  const directType = String(file.type || '').trim().toLowerCase()
  if (directType) return directType
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.png')) return 'image/png'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  if (lowerName.endsWith('.svg')) return 'image/svg+xml'
  return ''
}

function getAssetKindFromMimeType(mimeType: string): RobotStudioAssetMeta['kind'] {
  if (mimeType === 'image/svg+xml') return 'svg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}
export function sanitizeSvgPayload(input: string): string {
  const withoutScript = input.replace(/<script[\s\S]*?<\/script>/gi, '')
  const withoutForeignObject = withoutScript.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
  const withoutInlineHandlers = withoutForeignObject.replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
  const withoutJavascriptHref = withoutInlineHandlers.replace(/(href|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '')
  return withoutJavascriptHref
}

export async function saveRobotStudioAsset(file: File): Promise<RobotStudioAssetMeta> {
  if (typeof window.indexedDB === 'undefined') {
    throw new Error('Trinh duyet khong ho tro IndexedDB de luu asset.')
  }

  const mimeType = inferUploadMimeType(file)
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    throw new Error('Chi ho tro upload PNG, WEBP, SVG.')
  }

  const now = Date.now()
  const id =
    typeof crypto.randomUUID === 'function'
      ? `asset-${crypto.randomUUID()}`
      : `asset-${now}-${Math.random().toString(16).slice(2, 10)}`

  const blob =
    mimeType === 'image/svg+xml'
      ? new Blob([sanitizeSvgPayload(await file.text())], { type: 'image/svg+xml' })
      : file.slice(0, file.size, mimeType)

  const record: RobotStudioAssetRecord = {
    id,
    name: file.name,
    mimeType,
    kind: getAssetKindFromMimeType(mimeType),
    size: blob.size,
    updatedAt: now,
    blob,
  }

  await withAssetStore('readwrite', async (store) => {
    await readIdbRequest(store.put(record))
    return undefined
  })

  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    kind: record.kind,
    size: record.size,
    updatedAt: record.updatedAt,
  }
}

export async function listRobotStudioAssets(): Promise<RobotStudioAssetMeta[]> {
  if (typeof window.indexedDB === 'undefined') return []

  const records = await withAssetStore('readonly', async (store) => {
    const rows = await readIdbRequest(store.getAll() as IDBRequest<RobotStudioAssetRecord[]>)
    return rows
  })

  return records
    .map((record) => ({
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      kind: record.kind,
      size: record.size,
      updatedAt: record.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function removeRobotStudioAsset(assetId: string): Promise<void> {
  if (typeof window.indexedDB === 'undefined') return
  await withAssetStore('readwrite', async (store) => {
    await readIdbRequest(store.delete(assetId))
    return undefined
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Khong doc duoc data URL tu asset'))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function readRobotStudioAssetDataUrl(assetId: string): Promise<string | null> {
  if (typeof window.indexedDB === 'undefined') return null
  const record = await withAssetStore('readonly', async (store) => {
    const row = await readIdbRequest(store.get(assetId) as IDBRequest<RobotStudioAssetRecord | undefined>)
    return row ?? null
  })
  if (!record) return null
  return blobToDataUrl(record.blob)
}

export function parseRobotStudioConfigFromJson(payload: string): RobotStudioConfigV1 | null {
  const rawText = String(payload || '').trim()
  if (!rawText) return null
  try {
    return normalizeRobotStudioConfig(JSON.parse(rawText) as unknown)
  } catch {
    return null
  }
}

export function getRobotStudioTriggerEventOptions(): string[] {
  return [...ROBOT_STUDIO_TRIGGER_EVENT_OPTIONS]
}

export function getMicAudioConstraints(
  levelOrStrength: MicNoiseFilterLevel | number = getMicNoiseFilterStrength(),
): MediaTrackConstraints {
  const level = typeof levelOrStrength === 'number' ? getMicNoiseFilterLevelFromStrength(levelOrStrength) : levelOrStrength

  if (level === 'off') {
    return { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  }

  if (level === 'strong') {
    return { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }

  return { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
}


