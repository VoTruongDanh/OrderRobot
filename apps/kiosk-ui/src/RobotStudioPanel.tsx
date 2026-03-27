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

const PACK_OPTIONS: Array<{ id: PackFilter; label: string }> = [
  { id: 'all', label: 'Tat ca' },
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

const HEAD_SHAPE_OPTIONS: Array<{ id: RobotAvatarPartsV1['headShape']; label: string }> = [
  { id: 'soft-square', label: 'Soft Square' },
  { id: 'visor', label: 'Visor' },
  { id: 'hex', label: 'Hex' },
  { id: 'bubble', label: 'Bubble' },
]

const HEAD_ACCESSORY_OPTIONS: Array<{ id: RobotAvatarPartsV1['headAccessory']; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'antenna', label: 'Antenna' },
  { id: 'halo', label: 'Halo' },
  { id: 'crown', label: 'Crown' },
]

const EYE_STYLE_OPTIONS: Array<{ id: RobotAvatarPartsV1['eyeStyle']; label: string }> = [
  { id: 'visor', label: 'Visor' },
  { id: 'round', label: 'Round' },
  { id: 'anime', label: 'Anime' },
  { id: 'mono', label: 'Mono' },
  { id: 'happy', label: 'Happy ^_^' },
  { id: 'wink', label: 'Wink >_<' },
  { id: 'surprised', label: 'Surprised O_O' },
  { id: 'sleepy', label: 'Sleepy -_-' },
]

const MOUTH_STYLE_OPTIONS: Array<{ id: RobotAvatarPartsV1['mouthStyle']; label: string }> = [
  { id: 'line', label: 'Line' },
  { id: 'smile', label: 'Smile' },
  { id: 'pixel', label: 'Pixel' },
  { id: 'none', label: 'None' },
  { id: 'big-smile', label: 'Big Smile :D' },
  { id: 'surprised-o', label: 'Surprised :O' },
  { id: 'sad', label: 'Sad :(' },
  { id: 'tongue-out', label: 'Tongue :P' },
]

const ARM_STYLE_OPTIONS: Array<{ id: RobotAvatarPartsV1['armStyle']; label: string }> = [
  { id: 'sleek', label: 'Sleek' },
  { id: 'chunky', label: 'Chunky' },
  { id: 'floating', label: 'Floating' },
]

const ARM_COLOR_OPTIONS: Array<{ id: RobotAvatarPartsV1['armColor']; label: string }> = [
  { id: 'aqua', label: 'Aqua' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'mint', label: 'Mint' },
  { id: 'violet', label: 'Violet' },
  { id: 'mono', label: 'Mono' },
]

const BODY_SHAPE_OPTIONS: Array<{ id: RobotAvatarPartsV1['bodyShape']; label: string }> = [
  { id: 'core', label: 'Core' },
  { id: 'shield', label: 'Shield' },
  { id: 'orb', label: 'Orb' },
  { id: 'compact', label: 'Compact' },
]

const OUTFIT_STYLE_OPTIONS: Array<{ id: RobotAvatarPartsV1['outfitStyle']; label: string }> = [
  { id: 'service', label: 'Service' },
  { id: 'street', label: 'Street' },
  { id: 'formal', label: 'Formal' },
  { id: 'battle', label: 'Battle' },
]

const AVATAR_PRESETS: Array<{ id: string; label: string; parts: Partial<RobotAvatarPartsV1> }> = [
  {
    id: 'preset-aether',
    label: 'Aether Hero',
      parts: {
        headShape: 'visor',
        headAccessory: 'halo',
        eyeStyle: 'visor',
        mouthStyle: 'line',
        faceFrameScale: 102,
        faceFrameVisible: true,
        armStyle: 'sleek',
        armColor: 'aqua',
        bodyShape: 'shield',
        outfitStyle: 'formal',
      },
  },
  {
    id: 'preset-kawaii',
    label: 'Kawaii Pop',
      parts: {
        headShape: 'bubble',
        headAccessory: 'crown',
        eyeStyle: 'anime',
        mouthStyle: 'smile',
        faceFrameScale: 108,
        faceFrameVisible: true,
        armStyle: 'chunky',
        armColor: 'violet',
        bodyShape: 'orb',
        outfitStyle: 'street',
      },
  },
  {
    id: 'preset-combat',
    label: 'Neo Combat',
      parts: {
        headShape: 'hex',
        headAccessory: 'antenna',
        eyeStyle: 'mono',
        mouthStyle: 'pixel',
        faceFrameScale: 96,
        faceFrameVisible: true,
        armStyle: 'floating',
        armColor: 'sunset',
        bodyShape: 'compact',
        outfitStyle: 'battle',
      },
  },
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

function randomPick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T
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
        error instanceof Error ? error.message : t('Khong tai duoc danh sach asset', 'Cannot load asset list'),
      )
    } finally {
      setAssetLoading(false)
    }
  }, [notify, t])

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

  const updateAvatarParts = useCallback(
    (patch: Partial<RobotAvatarPartsV1>) => {
      const nextConfig: RobotStudioConfigV1 = {
        ...config,
        avatarParts: {
          ...avatarParts,
          ...patch,
        },
      }
      persistConfig(nextConfig)
    },
    [avatarParts, config, persistConfig],
  )

  const applyAvatarPreset = useCallback(
    (presetId: string) => {
      const preset = AVATAR_PRESETS.find((item) => item.id === presetId)
      if (!preset) return
      updateAvatarParts({
        ...preset.parts,
        randomSeed: Date.now() % 1000000,
      })
      notify('info', t(`Da ap dung preset: ${preset.label}.`, `Preset applied: ${preset.label}.`))
    },
    [notify, t, updateAvatarParts],
  )

  const randomizeAvatarParts = useCallback(() => {
    updateAvatarParts({
      headShape: randomPick(HEAD_SHAPE_OPTIONS).id,
      headAccessory: randomPick(HEAD_ACCESSORY_OPTIONS).id,
      eyeStyle: randomPick(EYE_STYLE_OPTIONS).id,
      mouthStyle: randomPick(MOUTH_STYLE_OPTIONS).id,
      faceFrameScale: Math.max(72, Math.min(136, Math.round(88 + Math.random() * 44))),
      faceFrameVisible: true,
      armStyle: randomPick(ARM_STYLE_OPTIONS).id,
      armColor: randomPick(ARM_COLOR_OPTIONS).id,
      bodyShape: randomPick(BODY_SHAPE_OPTIONS).id,
      outfitStyle: randomPick(OUTFIT_STYLE_OPTIONS).id,
      randomSeed: Date.now() % 1000000,
    })
    notify('info', t('Da random bo phan robot.', 'Robot parts randomized.'))
  }, [notify, t, updateAvatarParts])

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
          t('Da upload va luu asset vao IndexedDB.', 'Assets uploaded and saved to IndexedDB.'),
        )
      } catch (error) {
        notify('error', error instanceof Error ? error.message : t('Upload asset that bai.', 'Asset upload failed.'))
      } finally {
        setAssetLoading(false)
      }
    },
    [notify, refreshAssetCatalog, t],
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
    persistConfig(nextConfig, t('Da tao graph moi.', 'New graph created.'))
    setSelectedGraphId(graph.id)
    setSelectedNodeId(graph.startNodeId)
  }, [config, persistConfig, t])

  const removeGraph = useCallback(() => {
    if (!currentGraph) return
    if (config.graphBindings.length <= 1) {
      notify(
        'warning',
        t('Can it nhat 1 graph de runtime hoat dong.', 'At least one graph is required for runtime.'),
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
    persistConfig(nextConfig, t('Da xoa graph.', 'Graph deleted.'))
  }, [config, currentGraph, notify, persistConfig, t])

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
      notify('warning', t('Graph can it nhat 1 node.', 'A graph must contain at least one node.'))
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
  }, [currentGraph, currentNode, notify, t, updateGraph])

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
      notify('warning', t('JSON khong hop le, vui long kiem tra lai.', 'Invalid JSON, please check and try again.'))
      return
    }
    persistConfig(parsed, t('Da import preset Robot Studio.', 'Robot Studio preset imported.'))
  }, [importText, notify, persistConfig, t])

  const resetConfig = useCallback(() => {
    const defaults = createDefaultRobotStudioConfig()
    persistConfig(defaults, t('Da reset Robot Studio ve mac dinh.', 'Robot Studio reset to default.'))
  }, [persistConfig, t])

  const applyNow = useCallback(() => {
    const saved = setRobotStudioConfig(config)
    setConfig(saved)
    setExportText(JSON.stringify(saved, null, 2))
    setDraftDirty(false)
    notify(
      'success',
      t(
        'Da ap dung thay doi vao kiosk/index.',
        'Changes have been applied to kiosk/index.',
      ),
    )

    if (!kioskConnected) {
      notify(
        'warning',
        t(
          'Chua thay kiosk dang mo. Bam "Mo kiosk de xem live" de xem thay doi.',
          'No active kiosk detected. Click "Open kiosk for live preview" to see updates.',
        ),
      )
      return
    }

    if (quickActionId) {
      sendRobotStudioCommand({ type: 'preview-action', actionId: quickActionId })
    }
  }, [config, kioskConnected, notify, quickActionId, t])

  const previewQuickAction = useCallback(() => {
    if (!quickActionId) {
      notify('warning', t('Chua co action de preview.', 'No action available for preview.'))
      return
    }
    if (draftDirty) {
      notify(
        'warning',
        t(
          'Ban co thay doi chua ap dung. Bam "Ap dung ngay" truoc khi test action tren kiosk.',
          'You have unapplied changes. Click "Apply Now" before testing action on kiosk.',
        ),
      )
      return
    }
    sendRobotStudioCommand({ type: 'preview-action', actionId: quickActionId })
    notify(
      kioskConnected ? 'success' : 'warning',
      kioskConnected
        ? t(`Da gui lenh test action: ${quickActionId}.`, `Preview action command sent: ${quickActionId}.`)
        : t(
          `Da gui lenh test action: ${quickActionId}. Neu kiosk dang ngu, hay mo kiosk de nhan lenh moi nhat.`,
          `Preview action command queued: ${quickActionId}. Open kiosk if it is currently inactive.`,
        ),
    )
  }, [draftDirty, kioskConnected, notify, quickActionId, t])

  const runQuickGraph = useCallback(() => {
    if (!quickGraphId) {
      notify('warning', t('Chua co graph de chay.', 'No graph available to run.'))
      return
    }
    if (draftDirty) {
      notify(
        'warning',
        t(
          'Ban co thay doi chua ap dung. Bam "Ap dung ngay" truoc khi chay graph tren kiosk.',
          'You have unapplied changes. Click "Apply Now" before running graph on kiosk.',
        ),
      )
      return
    }
    sendRobotStudioCommand({ type: 'run-graph', graphId: quickGraphId })
    notify(
      kioskConnected ? 'success' : 'warning',
      kioskConnected
        ? t(`Da gui lenh chay graph: ${quickGraphId}.`, `Run graph command sent: ${quickGraphId}.`)
        : t(
          `Da gui lenh chay graph: ${quickGraphId}. Neu kiosk dang ngu, hay mo kiosk de nhan lenh moi nhat.`,
          `Run graph command queued: ${quickGraphId}. Open kiosk if it is currently inactive.`,
        ),
    )
  }, [draftDirty, kioskConnected, notify, quickGraphId, t])

  const stopQuickGraph = useCallback(() => {
    sendRobotStudioCommand({ type: 'stop-graph' })
    notify(
      kioskConnected ? 'info' : 'warning',
      kioskConnected
        ? t('Da gui lenh dung graph.', 'Stop graph command sent.')
        : t(
          'Da gui lenh dung graph. Neu kiosk chua mo, lenh se duoc ap dung khi kiosk nhan cap nhat.',
          'Stop graph command queued. If kiosk is inactive, it will apply on next sync.',
        ),
    )
  }, [kioskConnected, notify, t])

  return (
    <section className="admin-panel admin-panel--stacked robot-studio-panel">
      <article className="admin-subcard robot-studio-subcard robot-studio-subcard--quick">
        <header className="admin-subcard__head">
          <div>
            <h3>Quick Studio</h3>
            <p>{t('Che do de chinh nhanh: builder 3 phan (dau, tay, than), random mau dep va test robot trong vai click.', 'Fast mode: 3-part builder (head, arms, body), random nice presets, and robot testing in a few clicks.')}</p>
            <div className="admin-chip-list">
              <p className={`admin-chip ${kioskConnected ? 'admin-chip--ok' : 'admin-chip--warning'}`}>
                {kioskConnected
                  ? t('Kiosk dang ket noi live', 'Kiosk live connection active')
                  : t('Chua thay kiosk live', 'No live kiosk detected')}
              </p>
              <p className={`admin-chip ${draftDirty ? 'admin-chip--warning' : 'admin-chip--ok'}`}>
                {draftDirty
                  ? t('Ban nhap chua ap dung', 'Draft not applied')
                  : t('Da dong bo index', 'Index synced')}
              </p>
            </div>
          </div>
          <div className="admin-inline-actions">
            <button className="admin-btn" type="button" onClick={applyNow} disabled={!draftDirty}>
              {draftDirty ? t('Ap dung ngay', 'Apply Now') : t('Da ap dung', 'Already Applied')}
            </button>
            <button
              className="admin-btn admin-btn--ghost"
              type="button"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              {showAdvanced ? t('An nang cao', 'Hide Advanced') : t('Hien nang cao', 'Show Advanced')}
            </button>
            <a className="admin-link" href="/" target="_blank" rel="noreferrer">
              {t('Mo kiosk de xem live', 'Open kiosk for live preview')}
            </a>
          </div>
        </header>

        <div className="robot-studio-section">
          <h4 className="robot-studio-section__title">{t('🎨 Bảng Màu Theme', '🎨 Color Theme Palette')}</h4>
          <div className="robot-color-theme-gallery">
            {ROBOT_STUDIO_SKIN_LIBRARY.map((skin) => (
              <button
                key={skin.id}
                type="button"
                className={`robot-color-swatch ${config.activeSkinId === skin.id ? 'is-active' : ''}`}
                onClick={() => persistConfig({ ...config, activeSkinId: skin.id })}
                title={skin.label}
                aria-label={`${t('Chọn theme', 'Select theme')} ${skin.label}`}
              >
                <span className="robot-color-swatch__circle" data-skin-id={skin.id} />
                <span className="robot-color-swatch__label">{skin.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="admin-fields-grid robot-studio-quick-grid">
          <label className="admin-field" style={{ display: 'none' }}>
            <span>{t('Theme mau nen', 'Base color theme')}</span>
            <select
              value={config.activeSkinId}
              onChange={(event) => persistConfig({ ...config, activeSkinId: event.target.value })}
            >
              {ROBOT_STUDIO_SKIN_LIBRARY.map((skin) => (
                <option key={skin.id} value={skin.id}>
                  {skin.label}
                </option>
              ))}
            </select>
          </label>
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
            <span>{t('Do manh hieu ung', 'Effect intensity')} {config.effectIntensity}%</span>
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

        <div className="robot-studio-section">
          <h4 className="robot-studio-section__title">{t('🎭 Chọn Preset Nhanh', '🎭 Quick Presets')}</h4>
          <div className="robot-preset-showcase">
            {AVATAR_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="robot-preset-card"
                onClick={() => applyAvatarPreset(preset.id)}
              >
                <span className="robot-preset-card__icon">
                  {preset.id === 'preset-aether' && '🦸'}
                  {preset.id === 'preset-kawaii' && '🎀'}
                  {preset.id === 'preset-combat' && '⚔️'}
                </span>
                <span className="robot-preset-card__label">{preset.label}</span>
              </button>
            ))}
            <button
              type="button"
              className="robot-preset-card robot-preset-card--random"
              onClick={randomizeAvatarParts}
            >
              <span className="robot-preset-card__icon">🎲</span>
              <span className="robot-preset-card__label">{t('Random Đẹp', 'Random Nice')}</span>
            </button>
          </div>
        </div>

        <article className="robot-studio-builder-grid">
          <header className="robot-studio-builder-grid__head">
            <strong>{t('🤖 Tùy Chỉnh Chi Tiết', '🤖 Detailed Customization')}</strong>
          </header>
          <div className="robot-parts-grid">
            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('🗿 Đầu', '🗿 Head')}</span>
              <div className="robot-icon-buttons">
                {HEAD_SHAPE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn ${avatarParts.headShape === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ headShape: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__symbol">
                      {item.id === 'soft-square' && '○'}
                      {item.id === 'visor' && '□'}
                      {item.id === 'hex' && '⬡'}
                      {item.id === 'bubble' && '◯'}
                    </span>
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('✨ Phụ kiện', '✨ Accessory')}</span>
              <div className="robot-icon-buttons">
                {HEAD_ACCESSORY_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn ${avatarParts.headAccessory === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ headAccessory: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__symbol">
                      {item.id === 'none' && '∅'}
                      {item.id === 'antenna' && '⚡'}
                      {item.id === 'halo' && '◉'}
                      {item.id === 'crown' && '♔'}
                    </span>
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('👁️ Mắt', '👁️ Eyes')}</span>
              <div className="robot-icon-buttons">
                {EYE_STYLE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn ${avatarParts.eyeStyle === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ eyeStyle: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__symbol">
                      {item.id === 'visor' && '▬'}
                      {item.id === 'round' && '●'}
                      {item.id === 'anime' && '◉'}
                      {item.id === 'mono' && '■'}
                      {item.id === 'happy' && '^_^'}
                      {item.id === 'wink' && '>_<'}
                      {item.id === 'surprised' && 'O_O'}
                      {item.id === 'sleepy' && '-_-'}
                    </span>
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('👄 Miệng', '👄 Mouth')}</span>
              <div className="robot-icon-buttons">
                {MOUTH_STYLE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn ${avatarParts.mouthStyle === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ mouthStyle: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__symbol">
                      {item.id === 'line' && '▬'}
                      {item.id === 'smile' && '⌣'}
                      {item.id === 'pixel' && '▪'}
                      {item.id === 'none' && '∅'}
                      {item.id === 'big-smile' && ':D'}
                      {item.id === 'surprised-o' && ':O'}
                      {item.id === 'sad' && ':('}
                      {item.id === 'tongue-out' && ':P'}
                    </span>
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('💪 Tay', '💪 Arms')}</span>
              <div className="robot-icon-buttons">
                {ARM_STYLE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn ${avatarParts.armStyle === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ armStyle: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__symbol">
                      {item.id === 'sleek' && '│'}
                      {item.id === 'chunky' && '▌'}
                      {item.id === 'floating' && '○'}
                    </span>
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('🎨 Màu tay', '🎨 Arm Color')}</span>
              <div className="robot-icon-buttons robot-icon-buttons--colors">
                {ARM_COLOR_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn robot-icon-btn--color ${avatarParts.armColor === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ armColor: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__color-circle" data-arm-color={item.id} />
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group">
              <span className="robot-part-group__label">{t('🤖 Thân', '🤖 Body')}</span>
              <div className="robot-icon-buttons">
                {BODY_SHAPE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-icon-btn ${avatarParts.bodyShape === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ bodyShape: item.id })}
                    title={item.label}
                  >
                    <span className="robot-icon-btn__symbol">
                      {item.id === 'core' && '■'}
                      {item.id === 'shield' && '◆'}
                      {item.id === 'orb' && '●'}
                      {item.id === 'compact' && '▪'}
                    </span>
                    <span className="robot-icon-btn__label">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="robot-part-group robot-part-group--full">
              <span className="robot-part-group__label">{t('🖼️ Khung mặt', '🖼️ Face Frame')} {avatarParts.faceFrameScale}%</span>
              <div className="robot-slider-group">
                <input
                  type="range"
                  min={65}
                  max={145}
                  step={1}
                  value={avatarParts.faceFrameScale}
                  onChange={(event) => updateAvatarParts({ faceFrameScale: Number(event.target.value) })}
                />
                <label className="robot-inline-check">
                  <input
                    type="checkbox"
                    checked={avatarParts.faceFrameVisible}
                    onChange={(event) => updateAvatarParts({ faceFrameVisible: event.target.checked })}
                  />
                  <span>{avatarParts.faceFrameVisible ? t('Hiển thị', 'Visible') : t('Ẩn', 'Hidden')}</span>
                </label>
              </div>
            </div>
            <div className="admin-field admin-field--full">
              <span>{t('🎨 Trang phục (Outfit Style)', '🎨 Outfit Style')}</span>
              <div className="robot-outfit-selector">
                {OUTFIT_STYLE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`robot-outfit-card ${avatarParts.outfitStyle === item.id ? 'is-active' : ''}`}
                    onClick={() => updateAvatarParts({ outfitStyle: item.id })}
                  >
                    <span className="robot-outfit-card__icon">
                      {item.id === 'service' && '👔'}
                      {item.id === 'street' && '👕'}
                      {item.id === 'formal' && '🎩'}
                      {item.id === 'battle' && '⚔️'}
                    </span>
                    <span className="robot-outfit-card__label">{item.label}</span>
                    <span className="robot-outfit-card__gradient" data-outfit={item.id} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </article>

        <article className="robot-studio-mini-preview" aria-label={t('Xem truoc robot trong admin', 'Robot preview in admin')}>
          <div className="robot-studio-mini-preview__meta">
            <strong>{t('Preview Modular Robot (Admin)', 'Modular robot preview (Admin)')}</strong>
            <span>
              {t('Dau', 'Head')}: {avatarParts.headShape}
            </span>
            <span>
              {t('Mat/Mieng', 'Eyes/Mouth')}: {avatarParts.eyeStyle}/{avatarParts.mouthStyle}
            </span>
            <span>
              {t('Tay/Than', 'Arms/Body')}: {avatarParts.armStyle}/{avatarParts.bodyShape}
            </span>
            <span>
              {t('Khung', 'Frame')}: {avatarParts.faceFrameVisible ? t('Hien', 'On') : t('An', 'Off')} · {avatarParts.faceFrameScale}%
            </span>
          </div>
          <div className="robot-studio-mini-preview__stage robot-studio-mini-preview__stage--live">
            <iframe
              ref={previewIframeRef}
              className="robot-studio-mini-preview__iframe"
              title={t('Xem truoc dong bo index', 'Index-synced preview')}
              src={ADMIN_LIVE_PREVIEW_SRC}
              onLoad={syncLivePreviewFrame}
              loading="lazy"
            />
          </div>
        </article>

        <div className="admin-fields-grid robot-studio-quick-grid">
          <label className="admin-field">
            <span>{t('Test nhanh action', 'Quick action test')}</span>
            <select value={quickActionId} onChange={(event) => setQuickActionId(event.target.value)}>
              {config.enabledActions.map((actionId) => (
                <option key={actionId} value={actionId}>
                  {actionId}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>{t('Test nhanh graph', 'Quick graph test')}</span>
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
              {t('Test action', 'Test action')}
            </button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={runQuickGraph}>
              {t('Chay graph', 'Run graph')}
            </button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={stopQuickGraph}>
              {t('Dung graph', 'Stop graph')}
            </button>
          </div>
        </div>

        <p className="admin-service-card__detail">
          {t(
            'Luu y: thay doi o day la ban nhap. Chi khi bam "Ap dung ngay" moi dong bo sang kiosk/index.',
            'Note: changes here are draft only. They sync to kiosk/index only after clicking "Apply Now".',
          )}
        </p>
      </article>

      {showAdvanced ? (
        <>
      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>{t('Legacy Palette + Asset', 'Legacy palette + assets')}</h3>
            <p>{t('Skin cu de lam nen mau + upload texture PNG/WEBP/SVG cho body.', 'Legacy skins as color base + PNG/WEBP/SVG body texture upload.')}</p>
          </div>
          <div className="admin-inline-actions">
            <label className="admin-btn admin-btn--ghost robot-upload-btn">
              {assetLoading ? t('Dang xu ly asset...', 'Processing assets...') : t('Upload Asset', 'Upload Asset')}
              <input type="file" accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml" multiple onChange={(event) => void handleAssetUpload(event.target.files)} />
            </label>
            <button className="admin-btn" type="button" onClick={() => void refreshAssetCatalog()}>
              {t('Lam moi asset', 'Refresh assets')}
            </button>
          </div>
        </header>

        <div className="robot-studio-toolbar">
          <label className="admin-field">
            <span>{t('Loc pack', 'Filter pack')}</span>
            <select value={packFilter} onChange={(event) => setPackFilter(event.target.value as PackFilter)}>
              {PACK_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id === 'all' ? t('Tat ca', 'All') : item.label}
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
                  {t('Chon skin', 'Select skin')}
                </button>
                <label className="robot-inline-check">
                  <input type="checkbox" checked={config.enabledSkinIds.includes(skin.id)} onChange={(event) => setSkinEnabled(skin.id, event.target.checked)} />
                  {t('Bat skin', 'Enable skin')}
                </label>
              </div>
              <label className="admin-field">
                <span>Texture bind</span>
                <select value={config.skinAssetBindings[skin.id] ?? ''} onChange={(event) => bindSkinAsset(skin.id, event.target.value)}>
                  <option value="">{t('Khong', 'None')}</option>
                  {config.uploadedAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.name}</option>
                  ))}
                </select>
              </label>
            </article>
          ))}
        </div>

        <div className="robot-asset-list">
          {config.uploadedAssets.length === 0 ? <p className="robot-empty">{t('Chua co asset upload.', 'No uploaded assets yet.')}</p> : null}
          {config.uploadedAssets.map((asset) => (
            <article key={asset.id} className="robot-asset-item">
              {assetPreviewById[asset.id] ? <img src={assetPreviewById[asset.id]} alt={asset.name} /> : <div className="robot-asset-placeholder">IMG</div>}
              <div>
                <strong>{asset.name}</strong>
                <p>{asset.kind.toUpperCase()} · {Math.round(asset.size / 1024)} KB</p>
              </div>
              <button className="admin-btn admin-btn--ghost" type="button" onClick={() => void handleRemoveAsset(asset.id)}>
                {t('Xoa', 'Delete')}
              </button>
            </article>
          ))}
        </div>
      </article>

      <article className="admin-subcard robot-studio-subcard">
        <header className="admin-subcard__head">
          <div>
            <h3>Action Library</h3>
            <p>{t('Bat/tat 25 action va chinh intensity, speed, cooldown.', 'Enable/disable 25 actions and tune intensity, speed, and cooldown.')}</p>
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
            <p>{t('Canvas node-graph co branch dieu kien theo scene/intent/menu/presence.', 'Node-graph canvas with condition branches by scene/intent/menu/presence.')}</p>
          </div>
          <div className="admin-inline-actions">
            <button className="admin-btn" type="button" onClick={addGraph}>{t('Them graph', 'Add graph')}</button>
            <button className="admin-btn admin-btn--ghost" type="button" onClick={removeGraph}>{t('Xoa graph', 'Delete graph')}</button>
          </div>
        </header>
        <div className="robot-studio-toolbar">
          <label className="admin-field">
            <span>Graph hien tai</span>
            <select value={selectedGraphId} onChange={(event) => setSelectedGraphId(event.target.value)}>
              {config.graphBindings.map((graph) => (
                <option key={graph.id} value={graph.id}>{graph.name}</option>
              ))}
            </select>
          </label>
          {currentGraph ? (
            <label className="admin-field">
              <span>Ten graph</span>
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
            <button className="admin-btn admin-btn--ghost" type="button" onClick={removeNode}>Xoa node</button>
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





