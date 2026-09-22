import type { Translations } from '@/i18n'

import { PanelAction } from '../overlays/panel'

interface JobActionsProps {
  busy: boolean
  c: Translations['cron']
  state: string
  onPauseResume: () => void
  onTrigger: () => void
}

export function JobActions({ busy, c, state, onPauseResume, onTrigger }: JobActionsProps) {
  const isPaused = state === 'paused'

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {state !== 'completed' && (
        <PanelAction disabled={busy} icon={isPaused ? 'play' : 'debug-pause'} onClick={onPauseResume}>
          {isPaused ? c.resumeTitle : c.pauseTitle}
        </PanelAction>
      )}
      <PanelAction disabled={busy || state === 'running'} icon="zap" onClick={onTrigger} primary>
        {state === 'completed' ? c.runAgain : c.triggerNow}
      </PanelAction>
    </div>
  )
}
