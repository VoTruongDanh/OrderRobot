import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ROBOT_STUDIO_ACTION_LIBRARY,
  ROBOT_STUDIO_SKIN_LIBRARY,
  createDefaultRobotStudioConfig,
  getRobotStudioConfig,
  getRobotStudioTriggerEventOptions,
  listRobotStudioAssets,
  parseRobotStudioConfigFromJson,
  readRobotStudioAssetDataUrl,
  removeRobotStudioAsset,
  saveRobotStudioAsset,
  sendRobotStudioCommand,
  setRobotStudioConfig,
  type RobotAvatarPartsV1,
  type RobotGraphConditionOperator,
  type RobotGraphConditionSource,
  type RobotGraphNode,
  type RobotStudioConfigV1,
  type RobotStudioGraphDefinition,
  type RobotSkinPack,
  type RobotTriggerBinding,
} from './config'

type NoticeTone = 'info' | 'success' | 'warning' | 'error'
type UiLanguage = 'vi' | 'en'

type RobotStudioPanelProps = {
  onNotice?: (notice: { tone: NoticeTone; text: string }) => void
  uiLanguage?: UiLanguage
}

type PackFilter = 'all' | RobotSkinPack

type DragState = {
  graphId: string
  nodeId: string
  offsetX: number
  offsetY: number
}

type RobotModelManifestEntry = {
  id: string
  name: string
  path: string
  format?: string
}

type LocalModelAnimationsMessage = {
  type: 'orderrobot:local-model-animations'
  modelPath: string
  animations: string[]
  activeAnimation: string
}

const PACK_OPTIONS: Array<{ id: PackFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'maid', label: 'Maid' },
  { id: 'waiter', label: 'Waiter' },
  { id: 'cute', label: 'Cute' },
  { id: 'anime', label: 'Anime/Fantasy' },
]

const CONDITION_SOURCE_OPTIONS: RobotGraphConditionSource[] = [
  'scene',
  'intent',
  'menu',
  'presence',
  'emotion',
  'action',
]

const CONDITION_OPERATOR_OPTIONS: RobotGraphConditionOperator[] = [
  'equals',
  'notEquals',
  'contains',
]

const KIOSK_HEARTBEAT_KEY = 'orderrobot.kiosk.heartbeat'
const KIOSK_HEARTBEAT_STALE_MS = 90000
const ADMIN_LIVE_PREVIEW_SRC = '/stitch_robot_3d_control_center.html?adminPreview=1'
const ROBOT_MODEL_MANIFEST_URL = '/robot-models/manifest.json'

const OUTFIT_STYLE_OPTIONS: Array<{ id: RobotAvatarPartsV1['outfitStyle']; label: string }> = [
  { id: 'service', label: 'Service' },
  { id: 'street', label: 'Street' },
  { id: 'formal', label: 'Formal' },
  { id: 'battle', label: 'Battle' },
]

function randomId(prefix: string): string {
  const tail = Math.random().toString(16).slice(2, 8)
  return `${prefix}-${Date.now()}-${tail}`
}

function createEmptyGraph(): RobotStudioGraphDefinition {
  const startNodeId = randomId('node')
  return {
    id: randomId('graph'),
    name: 'New Graph',
    startNodeId,
    nodes: [
      {
        id: startNodeId,
        name: 'Start Action',
        type: 'action',
        actionId: ROBOT_STUDIO_ACTION_LIBRARY[0]?.id,
        nextNodeId: undefined,
        position: { x: 24, y: 24 },
      },
    ],
  }
}

function createNode(type: RobotGraphNode['type']): RobotGraphNode {
  const id = randomId('node')
  const base: RobotGraphNode = {
    id,
    name: `${type} node`,
    type,
    position: { x: 60, y: 60 },
  }
  if (type === 'action') {
    base.actionId = ROBOT_STUDIO_ACTION_LIBRARY[0]?.id
  }
  if (type === 'wait') {
    base.delayMs = 500
  }
  if (type === 'condition') {
    base.condition = { source: 'scene', operator: 'equals', value: 'greeting' }
  }
  return base
}

function isLikelyPoseAnimation(name: string): boolean {
  const safe = String(name || '').toLowerCase()
  return /(^|[_\-\s|])(t[_\-\s]?pose|a[_\-\s]?pose|pose)($|[_\-\s|])/.test(safe)
}

export function RobotStudioPanel({ onNotice, uiLanguage = 'vi' }: RobotStudioPanelProps) {
  const [config, setConfig] = useState<RobotStudioConfigV1>(() => getRobotStudioConfig())
  const [packFilter, setPackFilter] = useState<PackFilter>('all')
  const [selectedGraphId, setSelectedGraphId] = useState<string>(() => getRobotStudioConfig().graphBindings[0]?.id ?? '')
  const [selectedNodeId, setSelectedNodeId] = useState<string>('')
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState(() => JSON.stringify(getRobotStudioConfig(), null, 2))
  const [draftDirty, setDraftDirty] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [quickActionId, setQuickActionId] = useState<string>('waveHello')
  const [quickGraphId, setQuickGraphId] = useState<string>(() => getRobotStudioConfig().graphBindings[0]?.id ?? '')
  const [kioskConnected, setKioskConnected] = useState(false)
  const [assetLoading, setAssetLoading] = useState(false)
  const [assetPreviewById, setAssetPreviewById] = useState<Record<string, string>>({})
  const [robotModelCatalog, setRobotModelCatalog] = useState<RobotModelManifestEntry[]>([])
  const [robotModelCatalogLoading, setRobotModelCatalogLoading] = useState(false)
  const [localModelAnimations, setLocalModelAnimations] = useState<string[]>([])
  const dragRef = useRef<DragState | null>(null)
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null)
  const t = useCallback(
    (vi: string, en: string) => (uiLanguage === 'vi' ? vi : en),
    [uiLanguage],
  )

  const currentGraph = useMemo(
    () => config.graphBindings.find((graph) => graph.id === selectedGraphId) ?? null,
    [config.graphBindings, selectedGraphId],
  )

  const currentNode = useMemo(
    () => currentGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [currentGraph, selectedNodeId],
  )

  const triggerEvents = useMemo(() => getRobotStudioTriggerEventOptions(), [])

  const filteredSkins = useMemo(() => {
    if (packFilter === 'all') {
      return ROBOT_STUDIO_SKIN_LIBRARY
    }
    return ROBOT_STUDIO_SKIN_LIBRARY.filter((skin) => skin.pack === packFilter)
  }, [packFilter])

  const avatarParts = useMemo<RobotAvatarPartsV1>(
    () =>
      config.avatarParts ?? {
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
      },
    [config.avatarParts],
  )
  const outfitProfiles = useMemo(
    () => config.outfitManager?.profiles ?? [],
    [config.outfitManager],
  )
  const activeOutfitProfileId = config.outfitManager?.activeProfileId ?? outfitProfiles[0]?.id ?? ''
  const activeOutfitProfile = useMemo(
    () => outfitProfiles.find((profile) => profile.id === activeOutfitProfileId) ?? outfitProfiles[0] ?? null,
    [activeOutfitProfileId, outfitProfiles],
  )
  const sortedLocalModelAnimations = useMemo(() => {
    const unique = Array.from(new Set(localModelAnimations.map((item) => String(item || '').trim()).filter(Boolean)))
    const actionLike = unique.filter((name) => !isLikelyPoseAnimation(name))
    const poseLike = unique.filter((name) => isLikelyPoseAnimation(name))
    return [...actionLike, ...poseLike]
  }, [localModelAnimations])

  useEffect(() => {
    const readHeartbeat = () => {
      const raw = localStorage.getItem(KIOSK_HEARTBEAT_KEY)
      const parsed = Number(raw ?? 0)
      const safeTs = Number.isFinite(parsed) ? parsed : 0
      setKioskConnected(Date.now() - safeTs <= KIOSK_HEARTBEAT_STALE_MS)
    }

    readHeartbeat()
    const intervalId = window.setInterval(readHeartbeat, 1200)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === KIOSK_HEARTBEAT_KEY) {
        readHeartbeat()
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  useEffect(() => {
    if (!config.enabledActions.includes(quickActionId)) {
      setQuickActionId(config.enabledActions[0] ?? ROBOT_STUDIO_ACTION_LIBRARY[0]?.id ?? 'waveHello')
    }
  }, [config.enabledActions, quickActionId])

  useEffect(() => {
    if (!config.graphBindings.some((graph) => graph.id === quickGraphId)) {
      setQuickGraphId(config.graphBindings[0]?.id ?? '')
    }
  }, [config.graphBindings, quickGraphId])

  const syncLivePreviewFrame = useCallback(() => {
    const target = previewIframeRef.current?.contentWindow
    if (!target) return
    target.postMessage(
      { type: 'orderrobot:robot-studio-config', config },
      window.location.origin,
    )
  }, [config])

  useEffect(() => {
    syncLivePreviewFrame()
  }, [syncLivePreviewFrame])

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      if (!event.data || typeof event.data !== 'object') return
      const payload = event.data as Partial<LocalModelAnimationsMessage>
      if (payload.type !== 'orderrobot:local-model-animations') return
      const animations = Array.isArray(payload.animations)
        ? payload.animations
            .map((item) => String(item || '').trim())
            .filter(Boolean)
        : []
      setLocalModelAnimations(Array.from(new Set(animations)))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const refreshRobotModelCatalog = useCallback(async () => {
    setRobotModelCatalogLoading(true)
    try {
      const response = await fetch(ROBOT_MODEL_MANIFEST_URL, { cache: 'no-store' })
      if (!response.ok) {
        setRobotModelCatalog([])
        return
      }
      const payload = (await response.json()) as { models?: RobotModelManifestEntry[] }
      const models = Array.isArray(payload?.models)
        ? payload.models
            .map((item) => ({
              id: String(item?.id || '').trim(),
              name: String(item?.name || '').trim(),
              path: String(item?.path || '').trim(),
              format: String(item?.format || '').trim().toLowerCase(),
            }))
            .filter((item) => item.id && item.name && item.path)
        : []
      setRobotModelCatalog(models)
    } catch {
      setRobotModelCatalog([])
    } finally {
      setRobotModelCatalogLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshRobotModelCatalog()
  }, [refreshRobotModelCatalog])

  const notify = useCallback(
    (tone: NoticeTone, text: string) => {
      onNotice?.({ tone, text })
    },
    [onNotice],
  )

  const persistConfig = useCallback(
    (nextConfig: RobotStudioConfigV1, noticeText?: string) => {
      setConfig(nextConfig)
      setExportText(JSON.stringify(nextConfig, null, 2))
      setDraftDirty(true)
      // Save to localStorage immediately to prevent stale config from being read
      setRobotStudioConfig(nextConfig)
      if (noticeText) {
        notify('info', noticeText)
      }
    },
    [notify],
  )

  const refreshAssetCatalog = useCallback(async () => {
    setAssetLoading(true)
    try {
      const assets = await listRobotStudioAssets()
      setConfig((current) => {
        const next: RobotStudioConfigV1 = {
          ...current,
          uploadedAssets: assets,
        }
        setExportText(JSON.stringify(next, null, 2))
        return next
      })
    } catch (error) {
      notify(
        'error',
        error instanceof Error ? error.message : 'Cannot load asset list',
      )
    } finally {
      setAssetLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void refreshAssetCatalog()
  }, [refreshAssetCatalog])

  useEffect(() => {
    if (!config.graphBindings.some((graph) => graph.id === selectedGraphId)) {
      setSelectedGraphId(config.graphBindings[0]?.id ?? '')
    }
  }, [config.graphBindings, selectedGraphId])

  useEffect(() => {
    if (!currentGraph || !currentGraph.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(currentGraph?.nodes[0]?.id ?? '')
    }
  }, [currentGraph, selectedNodeId])

  useEffect(() => {
    const assetsToPreview = config.uploadedAssets.slice(0, 6)
    void Promise.all(
      assetsToPreview.map(async (asset) => {
        const dataUrl = await readRobotStudioAssetDataUrl(asset.id)
        return { id: asset.id, dataUrl }
      }),
    ).then((items) => {
      setAssetPreviewById((current) => {
        const next = { ...current }
        for (const item of items) {
          if (item.dataUrl) {
            next[item.id] = item.dataUrl
          }
        }
        return next
      })
    }).catch(() => {
      // ignore preview errors
    })
  }, [config.uploadedAssets])

  const setSkinEnabled = useCallback(
    (skinId: string, enabled: boolean) => {
      const nextEnabled = enabled
        ? Array.from(new Set([...config.enabledSkinIds, skinId]))
        : config.enabledSkinIds.filter((id) => id !== skinId)
      const safeEnabled = nextEnabled.length > 0 ? nextEnabled : [config.activeSkinId]
      const nextConfig: RobotStudioConfigV1 = {
        ...config,
        enabledSkinIds: safeEnabled,
        activeSkinId: safeEnabled.includes(config.activeSkinId) ? config.activeSkinId : safeEnabled[0],
      }
      persistConfig(nextConfig)
    },
    [config, persistConfig],
  )

  const bindSkinAsset = useCallback(
    (skinId: string, assetId: string) => {
      const nextBindings = { ...config.skinAssetBindings }
      if (!assetId) {
        delete nextBindings[skinId]
      } else {
        nextBindings[skinId] = assetId
      }
      persistConfig({ ...config, skinAssetBindings: nextBindings })
    },
    [config, persistConfig],
  )

  const updateRobotVisual = useCallback(
    (
      patch: Partial<{
        localModelPath: string
        localModelAnimationName: string
        localModelAutoRotate: boolean
        localModelCameraControls: boolean
        localModelYawDeg: number
        localModelFaceMaterialFix: boolean
      }>,
    ) => {
      const latest = getRobotStudioConfig()
      const current = latest.robotVisual ?? createDefaultRobotStudioConfig().robotVisual
      persistConfig({
        ...latest,
        robotVisual: {
          ...current,
          ...patch,
        },
      })
    },
    [persistConfig],
  )

  useEffect(() => {
    if ((config.robotVisual?.mode ?? 'local_glb') !== 'local_glb') return
    if (config.robotVisual?.localModelAutoRotate !== true) return
    updateRobotVisual({ localModelAutoRotate: false })
  }, [config.robotVisual?.localModelAutoRotate, config.robotVisual?.mode, updateRobotVisual])

  const updateOutfitManager = useCallback(
    (next: RobotStudioConfigV1['outfitManager']) => {
      persistConfig({ ...config, outfitManager: next })
    },
    [config, persistConfig],
  )

  const setActiveOutfitProfile = useCallback(
    (profileId: string) => {
      const safeProfileId = String(profileId || '').trim()
      if (!safeProfileId) return
      updateOutfitManager({
        activeProfileId: safeProfileId,
        profiles: outfitProfiles,
      })
    },
    [outfitProfiles, updateOutfitManager],
  )

  const patchActiveOutfitProfile = useCallback(
    (
      patch: Partial<{
        name: string
        enabled: boolean
        skinId: string
        outfitStyle: RobotAvatarPartsV1['outfitStyle']
        textureAssetId: string
      }>,
    ) => {
      const targetId = activeOutfitProfile?.id
      if (!targetId) return
      const nextProfiles = outfitProfiles.map((profile) =>
        profile.id === targetId
          ? {
              ...profile,
              ...patch,
            }
          : profile,
      )
      updateOutfitManager({
        activeProfileId: targetId,
        profiles: nextProfiles,
      })
    },
    [activeOutfitProfile?.id, outfitProfiles, updateOutfitManager],
  )

  const addOutfitProfile = useCallback(() => {
    const id = randomId('outfit')
    const baseSkinId = config.activeSkinId || ROBOT_STUDIO_SKIN_LIBRARY[0]?.id || 'maid-classic'
    const nextProfile: RobotStudioConfigV1['outfitManager']['profiles'][number] = {
      id,
      name: `Outfit ${outfitProfiles.length + 1}`,
      enabled: true,
      skinId: baseSkinId,
      outfitStyle: avatarParts.outfitStyle,
      textureAssetId: '',
    }
    updateOutfitManager({
      activeProfileId: id,
      profiles: [...outfitProfiles, nextProfile],
    })
  }, [avatarParts.outfitStyle, config.activeSkinId, outfitProfiles, updateOutfitManager])

  const removeActiveOutfitProfile = useCallback(() => {
    if (!activeOutfitProfile?.id) return
    if (outfitProfiles.length <= 1) return
    const nextProfiles = outfitProfiles.filter((profile) => profile.id !== activeOutfitProfile.id)
    updateOutfitManager({
      activeProfileId: nextProfiles[0]?.id ?? '',
      profiles: nextProfiles,
    })
  }, [activeOutfitProfile?.id, outfitProfiles, updateOutfitManager])

  const handleAssetUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setAssetLoading(true)
      try {
        for (const file of Array.from(files)) {
          await saveRobotStudioAsset(file)
        }
        await refreshAssetCatalog()
        notify(
          'success',
          'Assets uploaded and saved to IndexedDB.',
        )
      } catch (error) {
        notify('error', error instanceof Error ? error.message : 'Asset upload failed.')
      } finally {
        setAssetLoading(false)
      }
    },
    [notify, refreshAssetCatalog],
  )

  const handleRemoveAsset = useCallback(
    async (assetId: string) => {
      await removeRobotStudioAsset(assetId)
      await refreshAssetCatalog()
      const nextBindings = { ...config.skinAssetBindings }
      for (const [skinId, mappedAssetId] of Object.entries(nextBindings)) {
        if (mappedAssetId === assetId) {
          delete nextBindings[skinId]
        }
      }
      persistConfig({ ...config, skinAssetBindings: nextBindings })
    },
    [config, persistConfig, refreshAssetCatalog],
  )

  const setActionEnabled = useCallback(
    (actionId: string, enabled: boolean) => {
      const nextEnabled = enabled
        ? Array.from(new Set([...config.enabledActions, actionId]))
        : config.enabledActions.filter((id) => id !== actionId)
      const fallback = nextEnabled.length > 0 ? nextEnabled : [actionId]
      persistConfig({ ...config, enabledActions: fallback })
    },
    [config, persistConfig],
  )

  const setActionSetting = useCallback(
    (actionId: string, patch: Partial<RobotStudioConfigV1['actionSettings'][string]>) => {
      const currentSetting = config.actionSettings[actionId] ?? {
        enabled: true,
        intensity: 82,
        speed: 1,
        cooldownMs: 350,
      }
      const nextSetting = {
        ...currentSetting,
        ...patch,
      }
      const nextConfig: RobotStudioConfigV1 = {
        ...config,
        actionSettings: {
          ...config.actionSettings,
          [actionId]: nextSetting,
        },
      }
      persistConfig(nextConfig)
    },
    [config, persistConfig],
  )

  const updateGraph = useCallback(
    (graphId: string, updater: (graph: RobotStudioGraphDefinition) => RobotStudioGraphDefinition) => {
      const nextGraphs = config.graphBindings.map((graph) => (graph.id === graphId ? updater(graph) : graph))
      persistConfig({ ...config, graphBindings: nextGraphs })
    },
    [config, persistConfig],
  )

  const addGraph = useCallback(() => {
    const graph = createEmptyGraph()
    const nextConfig: RobotStudioConfigV1 = {
      ...config,
      graphBindings: [...config.graphBindings, graph],
    }
    persistConfig(nextConfig, 'New graph created.')
    setSelectedGraphId(graph.id)
    setSelectedNodeId(graph.startNodeId)
  }, [config, persistConfig])

  const removeGraph = useCallback(() => {
    if (!currentGraph) return
    if (config.graphBindings.length <= 1) {
      notify(
        'warning',
        'At least one graph is required for runtime.',
      )
      return
    }
    const nextGraphs = config.graphBindings.filter((graph) => graph.id !== currentGraph.id)
    const nextBindings = config.triggerBindings.map((binding) =>
      binding.targetType === 'graph' && binding.targetId === currentGraph.id
        ? { ...binding, targetId: nextGraphs[0]?.id ?? binding.targetId }
        : binding,
    )
    const nextConfig = { ...config, graphBindings: nextGraphs, triggerBindings: nextBindings }
    persistConfig(nextConfig, 'Graph deleted.')
  }, [config, currentGraph, notify, persistConfig])

  const addNode = useCallback(
    (type: RobotGraphNode['type']) => {
      if (!currentGraph) return
      const node = createNode(type)
      updateGraph(currentGraph.id, (graph) => ({
        ...graph,
        nodes: [...graph.nodes, node],
      }))
      setSelectedNodeId(node.id)
    },
    [currentGraph, updateGraph],
  )

  const removeNode = useCallback(() => {
    if (!currentGraph || !currentNode) return
    if (currentGraph.nodes.length <= 1) {
      notify('warning', 'A graph must contain at least one node.')
      return
    }

    updateGraph(currentGraph.id, (graph) => {
      const nextNodes = graph.nodes.filter((node) => node.id !== currentNode.id)
      const safeStart = graph.startNodeId === currentNode.id ? nextNodes[0]?.id ?? graph.startNodeId : graph.startNodeId
      return {
        ...graph,
        startNodeId: safeStart,
        nodes: nextNodes.map((node) => ({
          ...node,
          nextNodeId: node.nextNodeId === currentNode.id ? undefined : node.nextNodeId,
          trueNodeId: node.trueNodeId === currentNode.id ? undefined : node.trueNodeId,
          falseNodeId: node.falseNodeId === currentNode.id ? undefined : node.falseNodeId,
        })),
      }
    })
  }, [currentGraph, currentNode, notify, updateGraph])

  const updateNode = useCallback(
    (nodeId: string, updater: (node: RobotGraphNode) => RobotGraphNode) => {
      if (!currentGraph) return
      updateGraph(currentGraph.id, (graph) => ({
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
      }))
    },
    [currentGraph, updateGraph],
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, node: RobotGraphNode) => {
      if (!currentGraph) return
      const canvasRect = event.currentTarget.parentElement?.getBoundingClientRect()
      if (!canvasRect) return
      dragRef.current = {
        graphId: currentGraph.id,
        nodeId: node.id,
        offsetX: event.clientX - canvasRect.left - node.position.x,
        offsetY: event.clientY - canvasRect.top - node.position.y,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [currentGraph],
  )

  const addTrigger = useCallback(() => {
    const firstGraphId = config.graphBindings[0]?.id ?? ''
    const newBinding: RobotTriggerBinding = {
      id: randomId('trigger'),
      event: triggerEvents[0] ?? 'button.heroLanding',
      targetType: 'graph',
      targetId: firstGraphId,
      enabled: true,
      conditions: [],
    }
    persistConfig({ ...config, triggerBindings: [...config.triggerBindings, newBinding] })
  }, [config, persistConfig, triggerEvents])

  const removeTrigger = useCallback(
    (bindingId: string) => {
      const next = config.triggerBindings.filter((binding) => binding.id !== bindingId)
      persistConfig({ ...config, triggerBindings: next })
    },
    [config, persistConfig],
  )

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const dragState = dragRef.current
      if (!dragState || !currentGraph || dragState.graphId !== currentGraph.id) return
      const canvas = document.getElementById(`graph-canvas-${currentGraph.id}`)
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = Math.max(4, Math.min(rect.width - 140, event.clientX - rect.left - dragState.offsetX))
      const y = Math.max(4, Math.min(rect.height - 52, event.clientY - rect.top - dragState.offsetY))
      updateNode(dragState.nodeId, (node) => ({ ...node, position: { x, y } }))
    }

    const handleUp = () => {
      dragRef.current = null
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [currentGraph, updateNode])

  const handleImportJson = useCallback(() => {
    const parsed = parseRobotStudioConfigFromJson(importText)
    if (!parsed) {
      notify('warning', 'Invalid JSON, please check and try again.')
      return
    }
    persistConfig(parsed, 'Robot Studio preset imported.')
  }, [importText, notify, persistConfig])

  const resetConfig = useCallback(() => {
    const defaults = createDefaultRobotStudioConfig()
    persistConfig(defaults, 'Robot Studio reset to default.')
  }, [persistConfig])

  const applyNow = useCallback(() => {
    const saved = setRobotStudioConfig(config)
    setConfig(saved)
    setExportText(JSON.stringify(saved, null, 2))
    setDraftDirty(false)
    notify(
      'success',
      'Changes have been applied to kiosk/index.',
    )

    if (!kioskConnected) {
      notify(
        'warning',
        'No active kiosk detected. Click "Open kiosk for live preview" to see updates.',
      )
      return
    }

    if (quickActionId) {
      sendRobotStudioCommand({ type: 'preview-action', actionId: quickActionId })
    }
  }, [config, kioskConnected, notify, quickActionId])

  const previewQuickAction = useCallback(() => {
    if (!quickActionId) {
      notify('warning', 'No action available for preview.')
      return
    }
    if (draftDirty) {
      notify(
        'warning',
        'You have unapplied changes. Click "Apply Now" before testing action on kiosk.',
      )
      return
    }
    sendRobotStudioCommand({ type: 'preview-action', actionId: quickActionId })
    notify(
      kioskConnected ? 'success' : 'warning',
      kioskConnected
        ? `Preview action command sent: ${quickActionId}.`
        : `Preview action command queued: ${quickActionId}. Open kiosk if it is currently inactive.`,
    )
  }, [draftDirty, kioskConnected, notify, quickActionId])

  const runQuickGraph = useCallback(() => {
    if (!quickGraphId) {
      notify('warning', 'No graph available to run.')
      return
    }
    if (draftDirty) {
      notify(
        'warning',
        'You have unapplied changes. Click "Apply Now" before running graph on kiosk.',
      )
      return
    }
    sendRobotStudioCommand({ type: 'run-graph', graphId: quickGraphId })
    notify(
      kioskConnected ? 'success' : 'warning',
      kioskConnected
        ? `Run graph command sent: ${quickGraphId}.`
        : `Run graph command queued: ${quickGraphId}. Open kiosk if it is currently inactive.`,
    )
  }, [draftDirty, kioskConnected, notify, quickGraphId])

  const stopQuickGraph = useCallback(() => {
    sendRobotStudioCommand({ type: 'stop-graph' })
    notify(
      kioskConnected ? 'info' : 'warning',
      kioskConnected
        ? 'Stop graph command sent.'
        : 'Stop graph command queued. If kiosk is inactive, it will apply on next sync.',
    )
  }, [kioskConnected, notify])

  return (
    <section className="admin-panel admin-panel--stacked robot-studio-panel">
      <article className="admin-subcard robot-studio-subcard robot-studio-subcard--quick">
        <header className="admin-subcard__head">
          <div>
            <h3>Quick Studio</h3>
            <p>Quick GLB mode: pick model, animation, heading, and test actions/graphs.</p>
            <div className="admin-chip-list">
              <p className={`admin-chip ${kioskConnected ? 'admin-chip--ok' : 'admin-chip--warning'}`}>
                {kioskConnected
                  ? 'Kiosk live connection active'
                  : 'No live kiosk detected'}
              </p>
              <p className={`admin-chip ${draftDirty ? 'admin-chip--warning' : 'admin-chip--ok'}`}>
                {draftDirty
                  ? 'Draft not applied'
                  : 'Index synced'}
              </p>
            </div>
          </div>
          <div className="admin-inline-actions">
            <button className="admin-btn" type="button" onClick={applyNow} disabled={!draftDirty}>
              {draftDirty ? 'Apply Now' : 'Already Applied'}
            </button>
            <button
              className="admin-btn admin-btn--ghost"
              type="button"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              {showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
            </button>
            <a className="admin-link" href="/" target="_blank" rel="noreferrer">
              Open kiosk for live preview
            </a>
          </div>
        </header>

        <div className="admin-fields-grid robot-studio-quick-grid">
          <label className="admin-field">
            <span>Quality profile</span>
            <select
              value={config.qualityProfile}
              onChange={(event) =>
                persistConfig({
                  ...config,
                  qualityProfile: event.target.value as RobotStudioConfigV1['qualityProfile'],
                })
              }
            >
              <option value="cinema">cinema</option>
              <option value="standard">standard</option>
              <option value="lite">lite</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Expressive mode</span>
            <select
              value={config.expressiveMode}
              onChange={(event) =>
                persistConfig({
                  ...config,
                  expressiveMode: event.target.value as RobotStudioConfigV1['expressiveMode'],
                })
              }
            >
              <option value="full">full</option>
              <option value="family">family</option>
              <option value="conservative">conservative</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Effect intensity {config.effectIntensity}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={config.effectIntensity}
              onChange={(event) =>
                persistConfig({ ...config, effectIntensity: Number(event.target.value) })
              }
            />
          </label>
        </div>

        <article className="robot-studio-mini-preview" aria-label="Robot preview in admin">
          <div className="robot-studio-mini-preview__meta">
            <strong>GLB Robot preview (Admin)</strong>
            <span>GLB-only mode is active for the whole kiosk web flow.</span>
          </div>
          <div className="robot-studio-mini-preview__stage robot-studio-mini-preview__stage--live">
            <iframe
              ref={previewIframeRef}
              className="robot-studio-mini-preview__iframe"
              title="Index-synced preview"
              src={ADMIN_LIVE_PREVIEW_SRC}
              loading="lazy"
            />
          </div>
        </article>

        <div className="admin-fields-grid robot-studio-quick-grid">
          <label className="admin-field admin-field--full">
            <span>🎬 Robot render mode</span>
            <input value="Local GLB (fixed)" disabled />
          </label>
          <>
              <label className="admin-field">
                <span>GLB model from folder</span>
                <select
                  value={config.robotVisual?.localModelPath ?? ''}
                  onChange={(event) =>
                    updateRobotVisual({
                      localModelPath: event.target.value,
                      localModelAnimationName: '',
                    })}
                >
                  <option value="">Select model from /public/robot-models</option>
                  {robotModelCatalog.map((item) => (
                    <option key={item.id} value={item.path}>
                      {item.name} ({item.format || 'glb'})
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>Animation name (optional)</span>
                <select
                  value={config.robotVisual?.localModelAnimationName ?? ''}
                  onChange={(event) => updateRobotVisual({ localModelAnimationName: event.target.value })}
                >
                  <option value="">Default to first animation in file</option>
                  {sortedLocalModelAnimations.map((animationName) => (
                    <option key={animationName} value={animationName}>
                      {animationName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field admin-field--full">
                <span>Model path (override dropdown)</span>
                <input
                  type="text"
                  value={config.robotVisual?.localModelPath ?? ''}
                  onChange={(event) =>
                    updateRobotVisual({
                      localModelPath: event.target.value,
                      localModelAnimationName: '',
                    })}
                  placeholder="/robot-models/your-model.glb"
                />
              </label>
              <label className="robot-inline-check">
                <input
                  type="checkbox"
                  checked={config.robotVisual?.localModelAutoRotate !== false}
                  onChange={(event) => updateRobotVisual({ localModelAutoRotate: event.target.checked })}
                />
                <span>Auto rotate</span>
              </label>
              <label className="robot-inline-check">
                <input
                  type="checkbox"
                  checked={config.robotVisual?.localModelCameraControls === true}
                  onChange={(event) => updateRobotVisual({ localModelCameraControls: event.target.checked })}
                />
                <span>Camera controls</span>
              </label>
              <label className="robot-inline-check">
                <input
                  type="checkbox"
                  checked={config.robotVisual?.localModelFaceMaterialFix !== false}
                  onChange={(event) => updateRobotVisual({ localModelFaceMaterialFix: event.target.checked })}
                />
                <span>Fix black face/missing eyes</span>
              </label>
              <label className="admin-field admin-field--full">
                <span>
                  Model heading (Yaw) {Number(config.robotVisual?.localModelYawDeg ?? 0)}°
                </span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  value={Number(config.robotVisual?.localModelYawDeg ?? 0)}
                  onChange={(event) => updateRobotVisual({ localModelYawDeg: Number(event.target.value) })}
                />
              </label>
              <label className="admin-field">
                <span>Yaw numeric</span>
                <input
                  type="number"
                  min={-180}
                  max={180}
                  step={1}
                  value={Number(config.robotVisual?.localModelYawDeg ?? 0)}
                  onChange={(event) => updateRobotVisual({ localModelYawDeg: Number(event.target.value) })}
                />
              </label>
              <div className="admin-inline-actions robot-studio-quick-actions">
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void refreshRobotModelCatalog()}>
                  {robotModelCatalogLoading
                    ? 'Scanning folder...'
                    : 'Refresh model catalog'}
                </button>
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => updateRobotVisual({ localModelYawDeg: 0 })}>
                  Reset to 0°
                </button>
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => updateRobotVisual({ localModelYawDeg: 180 })}>
                  Flip 180°
                </button>
              </div>
              {sortedLocalModelAnimations.length > 0 && sortedLocalModelAnimations.every((name) => isLikelyPoseAnimation(name)) ? (
                <p className="admin-service-card__detail">
                  This model currently exposes pose clips only (T-Pose/A-Pose). For real actions, use a model that includes dynamic clips (idle/walk/talk...).
                </p>
              ) : null}
            </>
          <label className="admin-field">
            <span>Quick action test</span>
            <select value={quickActionId} onChange={(event) => setQuickActionId(event.target.value)}>
              {config.enabledActions.map((actionId) => (
                <option key={actionId} value={actionId}>
                  {actionId}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>Quick graph test</span>
            <select value={quickGraphId} onChange={(event) => setQuickGraphId(event.target.value)}>
              {config.graphBindings.map((graph) => (
                <option key={graph.id} value={graph.id}>
                  {graph.name}
                </option>
              ))}
            </select>
          </label>
          <div className="admin-inline-actions robot-studio-quick-actions">
            <button className="admin-btn admin-btn--ghost" type="button" onClick={previewQuickAction}>
              Test action
            </button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={runQuickGraph}>
              Run graph
            </button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={stopQuickGraph}>
              Stop graph
            </button>
          </div>
        </div>

        <article className="admin-subcard robot-studio-subcard">
          <header className="admin-subcard__head">
            <div>
              <h3>Outfit Manager</h3>
              <p>
                Create dedicated outfit profiles (skin + texture + model), then activate one for live robot.
              </p>
            </div>
            <div className="admin-inline-actions">
              <button className="admin-btn admin-btn--ghost" type="button" onClick={addOutfitProfile}>
                Add profile
              </button>
              <button
                className="admin-btn admin-btn--ghost"
                type="button"
                disabled={outfitProfiles.length <= 1}
                onClick={removeActiveOutfitProfile}
              >
                Delete profile
              </button>
            </div>
          </header>
          <div className="admin-fields-grid robot-studio-quick-grid">
            <label className="admin-field">
              <span>Active profile</span>
              <select value={activeOutfitProfileId} onChange={(event) => setActiveOutfitProfile(event.target.value)}>
                {outfitProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Profile name</span>
              <input
                type="text"
                value={activeOutfitProfile?.name ?? ''}
                onChange={(event) => patchActiveOutfitProfile({ name: event.target.value })}
                placeholder="e.g. Maid Pink"
              />
            </label>
            <label className="admin-field">
              <span>Skin</span>
              <select
                value={activeOutfitProfile?.skinId ?? config.activeSkinId}
                onChange={(event) => patchActiveOutfitProfile({ skinId: event.target.value })}
              >
                {ROBOT_STUDIO_SKIN_LIBRARY.map((skin) => (
                  <option key={skin.id} value={skin.id}>
                    {skin.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Outfit style</span>
              <select
                value={activeOutfitProfile?.outfitStyle ?? avatarParts.outfitStyle}
                onChange={(event) =>
                  patchActiveOutfitProfile({ outfitStyle: event.target.value as RobotAvatarPartsV1['outfitStyle'] })
                }
              >
                {OUTFIT_STYLE_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Texture asset</span>
              <select
                value={activeOutfitProfile?.textureAssetId ?? ''}
                onChange={(event) => patchActiveOutfitProfile({ textureAssetId: event.target.value })}
              >
                <option value="">No texture</option>
                {config.uploadedAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="robot-inline-check">
              <input
                type="checkbox"
                checked={activeOutfitProfile?.enabled !== false}
                onChange={(event) => patchActiveOutfitProfile({ enabled: event.target.checked })}
              />
              <span>Enable this profile</span>
            </label>
          </div>
        </article>

        <p className="admin-service-card__detail">
          Note: changes here are draft only. They sync to kiosk/index only after clicking "Apply Now".
        </p>
      </article>

      {showAdvanced ? (
        <>
      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>Legacy palette + assets</h3>
            <p>Legacy skins as color base + PNG/WEBP/SVG body texture upload.</p>
          </div>
          <div className="admin-inline-actions">
            <label className="admin-btn admin-btn--ghost robot-upload-btn">
              {assetLoading ? 'Processing assets...' : 'Upload Asset'}
              <input type="file" accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml" multiple onChange={(event) => void handleAssetUpload(event.target.files)} />
            </label>
            <button className="admin-btn" type="button" onClick={() => void refreshAssetCatalog()}>
              Refresh assets
            </button>
          </div>
        </header>

        <div className="robot-studio-toolbar">
          <label className="admin-field">
            <span>Filter pack</span>
            <select value={packFilter} onChange={(event) => setPackFilter(event.target.value as PackFilter)}>
              {PACK_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="admin-chip admin-chip--ok">Skin active: {config.activeSkinId}</p>
        </div>

        <div className="robot-skin-grid">
          {filteredSkins.map((skin) => (
            <article key={skin.id} className={`robot-skin-card ${config.activeSkinId === skin.id ? 'is-active' : ''}`}>
              <h4>{skin.label}</h4>
              <p>{skin.pack}</p>
              <div className="robot-skin-card__actions">
                <button className="admin-btn admin-btn--ghost" type="button" onClick={() => persistConfig({ ...config, activeSkinId: skin.id })}>
                  Select skin
                </button>
                <label className="robot-inline-check">
                  <input type="checkbox" checked={config.enabledSkinIds.includes(skin.id)} onChange={(event) => setSkinEnabled(skin.id, event.target.checked)} />
                  Enable skin
                </label>
              </div>
              <label className="admin-field">
                <span>Texture bind</span>
                <select value={config.skinAssetBindings[skin.id] ?? ''} onChange={(event) => bindSkinAsset(skin.id, event.target.value)}>
                  <option value="">None</option>
                  {config.uploadedAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.name}</option>
                  ))}
                </select>
              </label>
            </article>
          ))}
        </div>

        <div className="robot-asset-list">
          {config.uploadedAssets.length === 0 ? <p className="robot-empty">No uploaded assets yet.</p> : null}
          {config.uploadedAssets.map((asset) => (
            <article key={asset.id} className="robot-asset-item">
              {assetPreviewById[asset.id] ? <img src={assetPreviewById[asset.id]} alt={asset.name} /> : <div className="robot-asset-placeholder">IMG</div>}
              <div>
                <strong>{asset.name}</strong>
                <p>{asset.kind.toUpperCase()} · {Math.round(asset.size / 1024)} KB</p>
              </div>
              <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void handleRemoveAsset(asset.id)}>
                Delete
              </button>
            </article>
          ))}
        </div>
      </article>

      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>Action Library</h3>
            <p>Enable/disable 25 actions and tune intensity, speed, and cooldown.</p>
          </div>
        </header>
        <div className="robot-action-grid">
          {ROBOT_STUDIO_ACTION_LIBRARY.map((action) => {
            const setting = config.actionSettings[action.id]
            const isEnabled = config.enabledActions.includes(action.id)
            return (
              <article key={action.id} className="robot-action-card">
                <h4>{action.label}</h4>
                <p>{action.category}</p>
                <label className="robot-inline-check">
                  <input type="checkbox" checked={isEnabled} onChange={(event) => setActionEnabled(action.id, event.target.checked)} />
                  Enable
                </label>
                <label className="admin-field">
                  <span>Intensity {setting?.intensity ?? 82}%</span>
                  <input type="range" min={0} max={100} step={1} value={setting?.intensity ?? 82} onChange={(event) => setActionSetting(action.id, { intensity: Number(event.target.value) })} />
                </label>
                <label className="admin-field">
                  <span>Speed {setting?.speed ?? 1}x</span>
                  <input type="range" min={0.25} max={3} step={0.05} value={setting?.speed ?? 1} onChange={(event) => setActionSetting(action.id, { speed: Number(event.target.value) })} />
                </label>
                <label className="admin-field">
                  <span>Cooldown {setting?.cooldownMs ?? 350}ms</span>
                  <input type="range" min={0} max={5000} step={50} value={setting?.cooldownMs ?? 350} onChange={(event) => setActionSetting(action.id, { cooldownMs: Number(event.target.value) })} />
                </label>
              </article>
            )
          })}
        </div>
      </article>

      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>Graph Timeline Editor</h3>
            <p>Node-graph canvas with condition branches by scene/intent/menu/presence.</p>
          </div>
          <div className="admin-inline-actions">
            <button className="admin-btn" type="button" onClick={addGraph}>Add graph</button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={removeGraph}>Delete graph</button>
          </div>
        </header>
        <div className="robot-studio-toolbar">
          <label className="admin-field">
            <span>Current graph</span>
            <select value={selectedGraphId} onChange={(event) => setSelectedGraphId(event.target.value)}>
              {config.graphBindings.map((graph) => (
                <option key={graph.id} value={graph.id}>{graph.name}</option>
              ))}
            </select>
          </label>
          {currentGraph ? (
            <label className="admin-field">
              <span>Graph name</span>
              <input
                value={currentGraph.name}
                onChange={(event) => {
                  const nextName = event.target.value
                  updateGraph(currentGraph.id, (graph) => ({ ...graph, name: nextName || graph.name }))
                }}
              />
            </label>
          ) : null}
          {currentGraph ? (
            <label className="admin-field">
              <span>Start node</span>
              <select
                value={currentGraph.startNodeId}
                onChange={(event) =>
                  updateGraph(currentGraph.id, (graph) => ({
                    ...graph,
                    startNodeId: event.target.value || graph.startNodeId,
                  }))
                }
              >
                {currentGraph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="admin-inline-actions">
            <button className="admin-btn admin-btn--ghost" type="button" onClick={() => addNode('action')}>+ Action node</button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={() => addNode('wait')}>+ Wait node</button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={() => addNode('condition')}>+ Condition node</button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={removeNode}>Delete node</button>
          </div>
        </div>

        {currentGraph ? (
          <>
            <div id={`graph-canvas-${currentGraph.id}`} className="robot-graph-canvas">
              <svg className="robot-graph-edges" aria-hidden="true">
                {currentGraph.nodes.flatMap((node) => {
                  const sourceX = node.position.x + 66
                  const sourceY = node.position.y + 22
                  const edges = [
                    { to: node.nextNodeId, label: '' },
                    { to: node.trueNodeId, label: 'T' },
                    { to: node.falseNodeId, label: 'F' },
                  ]
                  return edges.flatMap((edge, edgeIndex) => {
                    const target = currentGraph.nodes.find((candidate) => candidate.id === edge.to)
                    if (!target) return []
                    const targetX = target.position.x + 66
                    const targetY = target.position.y + 22
                    const midX = Math.round((sourceX + targetX) / 2)
                    const midY = Math.round((sourceY + targetY) / 2) - (edge.label ? 8 : 0)
                    const key = `${node.id}-${target.id}-${edge.label || edgeIndex}`
                    return [
                      <g key={key}>
                        <path
                          d={`M ${sourceX} ${sourceY} Q ${midX} ${midY} ${targetX} ${targetY}`}
                          className={`robot-graph-edge ${edge.label ? 'is-branch' : ''}`}
                        />
                        {edge.label ? (
                          <text x={midX} y={midY - 4} className="robot-graph-edge-label">
                            {edge.label}
                          </text>
                        ) : null}
                      </g>,
                    ]
                  })
                })}
              </svg>
              {currentGraph.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`robot-graph-node ${selectedNodeId === node.id ? 'is-selected' : ''}`}
                  style={{ left: `${node.position.x}px`, top: `${node.position.y}px` }}
                  onPointerDown={(event) => handlePointerDown(event, node)}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <strong>{node.name}</strong>
                  <small>{node.type}</small>
                </button>
              ))}
            </div>

            {currentNode ? (
              <div className="robot-node-editor">
                <h4>Node Editor: {currentNode.name}</h4>
                <div className="admin-fields-grid">
                  <label className="admin-field">
                    <span>Ten node</span>
                    <input value={currentNode.name} onChange={(event) => updateNode(currentNode.id, (node) => ({ ...node, name: event.target.value }))} />
                  </label>
                  <label className="admin-field">
                    <span>Type</span>
                    <select
                      value={currentNode.type}
                      onChange={(event) =>
                        updateNode(currentNode.id, (node) => {
                          const nextType = event.target.value as RobotGraphNode['type']
                          if (nextType === node.type) return node
                          if (nextType === 'action') {
                            return {
                              ...node,
                              type: nextType,
                              actionId: node.actionId || ROBOT_STUDIO_ACTION_LIBRARY[0]?.id,
                              delayMs: undefined,
                              condition: undefined,
                              trueNodeId: undefined,
                              falseNodeId: undefined,
                            }
                          }
                          if (nextType === 'wait') {
                            return {
                              ...node,
                              type: nextType,
                              actionId: undefined,
                              delayMs: node.delayMs ?? 500,
                              condition: undefined,
                              trueNodeId: undefined,
                              falseNodeId: undefined,
                            }
                          }
                          return {
                            ...node,
                            type: nextType,
                            actionId: undefined,
                            delayMs: undefined,
                            condition: node.condition || { source: 'scene', operator: 'equals', value: 'greeting' },
                          }
                        })
                      }
                    >
                      <option value="action">action</option>
                      <option value="wait">wait</option>
                      <option value="condition">condition</option>
                    </select>
                  </label>
                  {currentNode.type === 'action' ? (
                    <label className="admin-field">
                      <span>Action</span>
                      <select
                        value={currentNode.actionId ?? ROBOT_STUDIO_ACTION_LIBRARY[0]?.id}
                        onChange={(event) =>
                          updateNode(currentNode.id, (node) => ({
                            ...node,
                            actionId: event.target.value,
                          }))
                        }
                      >
                        {ROBOT_STUDIO_ACTION_LIBRARY.map((action) => (
                          <option key={action.id} value={action.id}>
                            {action.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {currentNode.type === 'wait' ? (
                    <label className="admin-field">
                      <span>Delay (ms)</span>
                      <input
                        type="number"
                        min={0}
                        step={50}
                        value={currentNode.delayMs ?? 500}
                        onChange={(event) =>
                          updateNode(currentNode.id, (node) => ({
                            ...node,
                            delayMs: Number(event.target.value || 0),
                          }))
                        }
                      />
                    </label>
                  ) : null}
                  {currentNode.type !== 'condition' ? (
                    <label className="admin-field">
                      <span>Next node</span>
                      <select
                        value={currentNode.nextNodeId ?? ''}
                        onChange={(event) =>
                          updateNode(currentNode.id, (node) => ({
                            ...node,
                            nextNodeId: event.target.value || undefined,
                          }))
                        }
                      >
                        <option value="">END</option>
                        {currentGraph.nodes
                          .filter((node) => node.id !== currentNode.id)
                          .map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : null}
                  {currentNode.type === 'condition' ? (
                    <>
                      <label className="admin-field">
                        <span>Condition source</span>
                        <select
                          value={currentNode.condition?.source ?? 'scene'}
                          onChange={(event) =>
                            updateNode(currentNode.id, (node) => ({
                              ...node,
                              condition: {
                                source: event.target.value as RobotGraphConditionSource,
                                operator: node.condition?.operator ?? 'equals',
                                value: node.condition?.value ?? '',
                              },
                            }))
                          }
                        >
                          {CONDITION_SOURCE_OPTIONS.map((source) => (
                            <option key={source} value={source}>
                              {source}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="admin-field">
                        <span>Condition operator</span>
                        <select
                          value={currentNode.condition?.operator ?? 'equals'}
                          onChange={(event) =>
                            updateNode(currentNode.id, (node) => ({
                              ...node,
                              condition: {
                                source: node.condition?.source ?? 'scene',
                                operator: event.target.value as RobotGraphConditionOperator,
                                value: node.condition?.value ?? '',
                              },
                            }))
                          }
                        >
                          {CONDITION_OPERATOR_OPTIONS.map((operator) => (
                            <option key={operator} value={operator}>
                              {operator}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="admin-field">
                        <span>Condition value</span>
                        <input
                          value={currentNode.condition?.value ?? ''}
                          onChange={(event) =>
                            updateNode(currentNode.id, (node) => ({
                              ...node,
                              condition: {
                                source: node.condition?.source ?? 'scene',
                                operator: node.condition?.operator ?? 'equals',
                                value: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="admin-field">
                        <span>True node</span>
                        <select
                          value={currentNode.trueNodeId ?? ''}
                          onChange={(event) =>
                            updateNode(currentNode.id, (node) => ({
                              ...node,
                              trueNodeId: event.target.value || undefined,
                            }))
                          }
                        >
                          <option value="">END</option>
                          {currentGraph.nodes
                            .filter((node) => node.id !== currentNode.id)
                            .map((node) => (
                              <option key={node.id} value={node.id}>
                                {node.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="admin-field">
                        <span>False node</span>
                        <select
                          value={currentNode.falseNodeId ?? ''}
                          onChange={(event) =>
                            updateNode(currentNode.id, (node) => ({
                              ...node,
                              falseNodeId: event.target.value || undefined,
                            }))
                          }
                        >
                          <option value="">END</option>
                          {currentGraph.nodes
                            .filter((node) => node.id !== currentNode.id)
                            .map((node) => (
                              <option key={node.id} value={node.id}>
                                {node.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </article>

      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>Trigger Binding</h3>
            <p>{t('Map su kien tu button, voice, presence vao action/graph.', 'Map button, voice, and presence events to actions/graphs.')}</p>
          </div>
          <button className="admin-btn" type="button" onClick={addTrigger}>{t('Them trigger', 'Add trigger')}</button>
        </header>
        <div className="robot-trigger-list">
          {config.triggerBindings.map((binding) => (
            <article key={binding.id} className="robot-trigger-item">
              <label className="admin-field">
                <span>Event</span>
                <select value={binding.event} onChange={(event) => persistConfig({ ...config, triggerBindings: config.triggerBindings.map((item) => item.id === binding.id ? { ...item, event: event.target.value } : item) })}>
                  {triggerEvents.map((eventName) => <option key={eventName} value={eventName}>{eventName}</option>)}
                </select>
              </label>
              <label className="admin-field">
                <span>Target type</span>
                <select value={binding.targetType} onChange={(event) => persistConfig({ ...config, triggerBindings: config.triggerBindings.map((item) => item.id === binding.id ? { ...item, targetType: event.target.value as RobotTriggerBinding['targetType'] } : item) })}>
                  <option value="action">action</option>
                  <option value="graph">graph</option>
                </select>
              </label>
              <label className="admin-field">
                <span>Target</span>
                <select value={binding.targetId} onChange={(event) => persistConfig({ ...config, triggerBindings: config.triggerBindings.map((item) => item.id === binding.id ? { ...item, targetId: event.target.value } : item) })}>
                  {(binding.targetType === 'action' ? ROBOT_STUDIO_ACTION_LIBRARY.map((item) => item.id) : config.graphBindings.map((item) => item.id)).map((targetId) => (
                    <option key={targetId} value={targetId}>{targetId}</option>
                  ))}
                </select>
              </label>
              <label className="robot-inline-check">
                <input type="checkbox" checked={binding.enabled} onChange={(event) => persistConfig({ ...config, triggerBindings: config.triggerBindings.map((item) => item.id === binding.id ? { ...item, enabled: event.target.checked } : item) })} />
                Enabled
              </label>
              <button className="admin-btn admin-btn--ghost" type="button" onClick={() => removeTrigger(binding.id)}>
                {t('Xoa', 'Delete')}
              </button>
            </article>
          ))}
        </div>
      </article>

      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>Runtime Profile</h3>
            <p>{t('Manual quality profile, expressive mode, export/import preset JSON.', 'Tune quality profile, expressive mode, and export/import JSON presets.')}</p>
          </div>
          <div className="admin-inline-actions">
            <button className="admin-btn admin-btn--ghost" type="button" onClick={resetConfig}>{t('Reset default', 'Reset default')}</button>
            <button className="admin-btn" type="button" onClick={handleImportJson}>{t('Import JSON', 'Import JSON')}</button>
          </div>
        </header>
        <div className="admin-fields-grid">
          <label className="admin-field">
            <span>Quality profile</span>
            <select value={config.qualityProfile} onChange={(event) => persistConfig({ ...config, qualityProfile: event.target.value as RobotStudioConfigV1['qualityProfile'] })}>
              <option value="cinema">cinema</option>
              <option value="standard">standard</option>
              <option value="lite">lite</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Expressive mode</span>
            <select value={config.expressiveMode} onChange={(event) => persistConfig({ ...config, expressiveMode: event.target.value as RobotStudioConfigV1['expressiveMode'] })}>
              <option value="full">full</option>
              <option value="family">family</option>
              <option value="conservative">conservative</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Effect intensity {config.effectIntensity}%</span>
            <input type="range" min={0} max={100} step={1} value={config.effectIntensity} onChange={(event) => persistConfig({ ...config, effectIntensity: Number(event.target.value) })} />
          </label>
        </div>

        <label className="admin-field admin-field--full">
          <span>Import JSON</span>
          <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={t('Paste robotStudio.v1 JSON vao day...', 'Paste robotStudio.v1 JSON here...')} rows={6} />
        </label>

        <label className="admin-field admin-field--full">
          <span>Export JSON</span>
          <textarea value={exportText} readOnly rows={10} />
        </label>
      </article>
        </>
      ) : (
        <article className="admin-subcard robot-studio-subcard">
          <p className="admin-service-card__detail">
            {t(
              'Ban dang o che do nhanh. Bat "Hien nang cao" neu can Graph Editor, Trigger Binding va Import/Export JSON.',
              'You are in quick mode. Turn on "Show Advanced" for Graph Editor, Trigger Binding, and Import/Export JSON.',
            )}
          </p>
        </article>
      )}
    </section>
  )
}

export default RobotStudioPanel
