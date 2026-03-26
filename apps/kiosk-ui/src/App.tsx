import './App.css'
import { useEffect, useRef, useState } from 'react'
import {
  getCameraPreviewVisible,
  getRobotScalePercent,
  subscribeAdminConfigChanges,
} from './config'

function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [robotScalePercent, setRobotScalePercent] = useState<number>(() => getRobotScalePercent())
  const [cameraPreviewVisible, setCameraPreviewVisible] = useState<boolean>(() =>
    getCameraPreviewVisible(),
  )

  useEffect(() => {
    const syncAdminConfigToIframe = () => {
      const nextScale = getRobotScalePercent()
      const nextCameraVisible = getCameraPreviewVisible()
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
          }}
        />
      </div>
    </div>
  )
}

export default App
