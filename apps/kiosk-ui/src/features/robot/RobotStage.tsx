import { useEffect, useMemo, useState } from 'react'
import type { RobotMode } from '../../types'
import type { RobotActionType, RobotCommand } from './robot.types'
import { isCalmRobotMode, mapModeToExpression } from './robot.types'
import './robot-stage.css'

type RobotStageProps = {
  mode: RobotMode
  statusMessage?: string
  menuOpen: boolean
  command: RobotCommand
}

const ACTION_DURATION_MS: Record<Exclude<RobotActionType, 'reset'>, number> = {
  wave: 1500,
  scan: 1500,
  dance: 2200,
  hero: 1800,
}

const IDLE_ACTIONS: Array<Exclude<RobotActionType, 'reset'>> = ['wave', 'scan', 'dance']

const MODE_HINT: Record<RobotMode, string> = {
  idle: 'Robot dang cho yeu cau tiep theo.',
  detecting: 'Robot dang cho khach moi vao vung camera.',
  listening: 'Robot dang lang nghe va co the ngat loi de sua cau.',
  thinking: 'Robot dang xu ly yeu cau, ban van co the noi chen.',
  speaking: 'Robot dang phan hoi va tu dong mo menu khi can.',
  error: 'Robot dang gap loi tam thoi. Bam Lam moi de thu lai.',
}

export function RobotStage({ mode, statusMessage, menuOpen, command }: RobotStageProps) {
  const [activeAction, setActiveAction] = useState<Exclude<RobotActionType, 'reset'> | null>(null)
  const [idlePulse, setIdlePulse] = useState(0)

  useEffect(() => {
    if (!command) {
      return
    }

    if (command.type === 'reset') {
      const clearTimer = window.setTimeout(() => {
        setActiveAction(null)
      }, 0)
      return () => {
        window.clearTimeout(clearTimer)
      }
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveAction(command.type)
    const clearTimer = window.setTimeout(() => {
      setActiveAction((current) => (current === command.type ? null : current))
    }, ACTION_DURATION_MS[command.type])

    return () => {
      window.clearTimeout(clearTimer)
    }
  }, [command])

  useEffect(() => {
    if (!isCalmRobotMode(mode) || menuOpen || activeAction) {
      return
    }

    const delayMs = 9000 + Math.round(Math.random() * 7000)
    const timer = window.setTimeout(() => {
      const nextAction = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)]
      setActiveAction(nextAction)
      setIdlePulse((value) => value + 1)
      window.setTimeout(() => {
        setActiveAction((current) => (current === nextAction ? null : current))
      }, ACTION_DURATION_MS[nextAction])
    }, delayMs)

    return () => {
      window.clearTimeout(timer)
    }
  }, [activeAction, menuOpen, mode, idlePulse])

  const expression = useMemo(() => mapModeToExpression(mode, menuOpen), [menuOpen, mode])
  const displayHint = statusMessage || MODE_HINT[mode]

  const avatarClasses = [
    'robot3d-avatar',
    `robot3d-avatar--${expression}`,
    activeAction ? `robot3d-avatar--${activeAction}` : '',
    menuOpen ? 'robot3d-avatar--menu-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={`robot3d-card robot3d-card--${mode}`}>
      <div className={`robot3d-scene ${menuOpen ? 'robot3d-scene--menu-open' : ''}`}>
        <div className="robot3d-halo" />
        <div className={avatarClasses}>
          <div className="robot3d-head">
            <div className="robot3d-face">
              <div className="robot3d-eye robot3d-eye--left" />
              <div className="robot3d-eye robot3d-eye--right" />
              <div className="robot3d-mouth" />
            </div>
          </div>
          <div className="robot3d-neck" />
          <div className="robot3d-body">
            <div className="robot3d-core" />
          </div>
          <div className="robot3d-arm robot3d-arm--left" />
          <div className="robot3d-arm robot3d-arm--right" />
          <div className="robot3d-shadow" />
          <div className="robot3d-wave robot3d-wave--one" />
          <div className="robot3d-wave robot3d-wave--two" />
          <div className="robot3d-shockwave" />
        </div>
      </div>

      <div className="robot3d-copy">
        <p className="eyebrow">Aetheris Control</p>
        <h1>Robot trung tam tuong tac</h1>
        <p className="status-message">{displayHint}</p>
      </div>
    </section>
  )
}
