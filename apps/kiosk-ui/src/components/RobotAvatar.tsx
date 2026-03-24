import type { RobotMode } from '../types'

type RobotAvatarProps = {
  mode: RobotMode
  statusMessage: string
}

export function RobotAvatar({ mode, statusMessage }: RobotAvatarProps) {
  return (
    <section className={`robot-card robot-card--${mode}`}>
      <div className="robot-stage">
        <div className="robot-halo" />
        <div className="robot-avatar" aria-hidden="true">
          <div className="maid-headband">
            <span />
            <span />
            <span />
          </div>
          <div className="robot-hair" />
          <div className="robot-face">
            <div className="robot-eye robot-eye--left" />
            <div className="robot-eye robot-eye--right" />
            <div className="robot-blush robot-blush--left" />
            <div className="robot-blush robot-blush--right" />
            <div className="robot-mouth" />
          </div>
          <div className="robot-neck" />
          <div className="robot-body">
            <div className="robot-apron" />
            <div className="robot-bow" />
          </div>
          <div className="robot-arm robot-arm--left" />
          <div className="robot-arm robot-arm--right" />
          <div className="robot-wave robot-wave--one" />
          <div className="robot-wave robot-wave--two" />
        </div>
      </div>

      <div className="robot-copy">
        <p className="eyebrow">Order Robot Kiosk</p>
        <h1>Gọi món bằng giọng nói</h1>
        <p className="status-message">{statusMessage}</p>
      </div>
    </section>
  )
}
