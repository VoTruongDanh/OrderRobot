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

function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastForwardedRobotCommandAtRef = useRef(0)
  const [robotScalePercent, setRobotScalePercent] = useState<number>(() => getRobotScalePercent())
  const [cameraPreviewVisible, setCameraPreviewVisible] = useState<boolean>(() =>
    getCameraPreviewVisible(),
  )

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

  return (
    <div className="sample-shell">
      <div className="sample-frame" role="region" aria-label="Stitch Robot 3D Control Center">
        <iframe
          className="sample-iframe"
          ref={iframeRef}
          src="/stitch_robot_3d_control_center.html"
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
