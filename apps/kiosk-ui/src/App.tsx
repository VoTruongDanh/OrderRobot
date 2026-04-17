import './App.css'
import { useEffect, useRef, useState } from 'react'
import {
  ADMIN_ROBOT_STUDIO_COMMAND_KEY,
  getAllAdminEnvConfig,
  getCameraPreviewVisible,
  getMicNoiseFilterStrength,
  getRobotScalePercent,
  getRobotStudioConfig,
  subscribeAdminConfigChanges,
} from './config'

function parseStoreIdFromLocation(locationLike: Pick<Location, 'pathname' | 'search'>): string {
  const searchParams = new URLSearchParams(locationLike.search || '')
  const path = String(locationLike.pathname || '')
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
    const normalized = String(candidate || '').trim()
    if (/^\d+$/.test(normalized) && Number.parseInt(normalized, 10) > 0) {
      return normalized
    }
  }
  return ''
}

function parseTableIdFromLocation(locationLike: Pick<Location, 'pathname' | 'search'>): string {
  const searchParams = new URLSearchParams(locationLike.search || '')
  const path = String(locationLike.pathname || '')
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
    const normalized = String(candidate || '').trim()
    if (/^\d+$/.test(normalized) && Number.parseInt(normalized, 10) > 0) {
      return normalized
    }
  }
  return ''
}

function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastForwardedRobotCommandAtRef = useRef(0)
  const [robotScalePercent, setRobotScalePercent] = useState<number>(() => getRobotScalePercent())
  const [cameraPreviewVisible, setCameraPreviewVisible] = useState<boolean>(() =>
    getCameraPreviewVisible(),
  )
  const storeId = parseStoreIdFromLocation(window.location)
  const tableId = parseTableIdFromLocation(window.location)
  const iframeSrc = (() => {
    if (!storeId) return '/stitch_robot_3d_control_center.html'
    const params = new URLSearchParams(window.location.search || '')
    params.set('storeid', storeId)
    if (tableId) {
      params.set('tableid', tableId)
    }
    return `/stitch_robot_3d_control_center.html?${params.toString()}`
  })()

  useEffect(() => {
    const syncAdminConfigToIframe = () => {
      const nextScale = getRobotScalePercent()
      const nextCameraVisible = getCameraPreviewVisible()
      const nextMicNoiseStrength = getMicNoiseFilterStrength()
      const nextRobotStudioConfig = getRobotStudioConfig()
      const nextAdminEnvConfig = getAllAdminEnvConfig()
      setRobotScalePercent(nextScale)
      setCameraPreviewVisible(nextCameraVisible)
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'orderrobot:robot-scale', scalePercent: nextScale },
        window.location.origin,
      )
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'orderrobot:camera-preview-visible', visible: nextCameraVisible },
        window.location.origin,
      )
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'orderrobot:admin-mic-noise-filter', strength: nextMicNoiseStrength },
        window.location.origin,
      )
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'orderrobot:robot-studio-config', config: nextRobotStudioConfig },
        window.location.origin,
      )
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'orderrobot:admin-env-config', config: nextAdminEnvConfig },
        window.location.origin,
      )

      try {
        const rawCommand = localStorage.getItem(ADMIN_ROBOT_STUDIO_COMMAND_KEY)
        if (!rawCommand) return
        const parsed = JSON.parse(rawCommand) as {
          type?: string
          command?: string
          actionId?: string
          graphId?: string
          context?: unknown
          issuedAt?: number
        }
        const issuedAt = Number(parsed.issuedAt ?? 0)
        if (!Number.isFinite(issuedAt) || issuedAt <= lastForwardedRobotCommandAtRef.current) return
        lastForwardedRobotCommandAtRef.current = issuedAt
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'orderrobot:robot-studio-command',
            command: parsed.command ?? parsed.type,
            actionId: parsed.actionId,
            graphId: parsed.graphId,
            context: parsed.context,
            issuedAt,
          },
          window.location.origin,
        )
      } catch {
        // ignore invalid command payload
      }
    }

    const unsubscribe = subscribeAdminConfigChanges(() => {
      syncAdminConfigToIframe()
    })

    syncAdminConfigToIframe()
    return unsubscribe
  }, [])

  if (!storeId) {
    return (
      <main className="sample-shell sample-shell--empty">
        <section className="store-gate-card" role="status" aria-live="polite">
          <div className="store-gate-card__icon" aria-hidden="true">
            <span>!</span>
          </div>
          <p className="store-gate-card__eyebrow">Kiosk Error</p>
          <h1>Thiếu thông tin cửa hàng</h1>
          <p className="store-gate-card__lead">Không thể khởi động kiosk lúc này.</p>
        </section>
      </main>
    )
  }

  return (
    <div className="sample-shell">
      <div className="sample-frame" role="region" aria-label="Stitch Robot 3D Control Center">
        <iframe
          className="sample-iframe"
          ref={iframeRef}
          src={iframeSrc}
          title="Stitch Robot 3D Control Center"
          allow="autoplay; microphone; camera"
          onLoad={() => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'orderrobot:robot-scale', scalePercent: robotScalePercent },
              window.location.origin,
            )
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'orderrobot:camera-preview-visible', visible: cameraPreviewVisible },
              window.location.origin,
            )
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'orderrobot:admin-mic-noise-filter', strength: getMicNoiseFilterStrength() },
              window.location.origin,
            )
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'orderrobot:robot-studio-config', config: getRobotStudioConfig() },
              window.location.origin,
            )
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'orderrobot:admin-env-config', config: getAllAdminEnvConfig() },
              window.location.origin,
            )
          }}
        />
      </div>
    </div>
  )
}

export default App
