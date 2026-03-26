import './App.css'
import { useEffect, useRef, useState } from 'react'
import { getRobotScalePercent, subscribeAdminConfigChanges } from './config'

function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [robotScalePercent, setRobotScalePercent] = useState<number>(() => getRobotScalePercent())

  useEffect(() => {
    const applyScale = () => {
      const next = getRobotScalePercent()
      setRobotScalePercent(next)
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'orderrobot:robot-scale', scalePercent: next },
        window.location.origin,
      )
    }

    const unsubscribe = subscribeAdminConfigChanges(() => {
      applyScale()
    })

    applyScale()
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
          }}
        />
      </div>
    </div>
  )
}

export default App
