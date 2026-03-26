import type { RobotMode } from '../../types'

export type RobotExpression = 'normal' | 'happy' | 'attentive' | 'thinking' | 'error'

export type RobotActionType = 'wave' | 'scan' | 'dance' | 'hero' | 'reset'

export type RobotCommand = {
  id: number
  type: RobotActionType
} | null

export function mapModeToExpression(mode: RobotMode, menuOpen: boolean): RobotExpression {
  if (mode === 'error') {
    return 'error'
  }
  if (mode === 'listening') {
    return 'attentive'
  }
  if (mode === 'thinking') {
    return 'thinking'
  }
  if (mode === 'speaking' || menuOpen) {
    return 'happy'
  }
  return 'normal'
}

export function isCalmRobotMode(mode: RobotMode): boolean {
  return mode === 'idle' || mode === 'detecting'
}
