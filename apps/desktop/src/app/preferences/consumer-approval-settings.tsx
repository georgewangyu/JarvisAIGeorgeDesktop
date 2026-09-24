import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { $approvalModes, type ApprovalMode, setApprovalModeForProfile, syncApprovalModeForProfile } from '@/store/approval-mode'
import { confirm } from '@/store/confirm'
import { requestGatewayForProfile } from '@/store/gateway'

const OPTIONS: { description: string; label: string; mode: ApprovalMode }[] = [
  { mode: 'smart', label: 'Balanced', description: 'Handle routine actions and ask when approval is needed.' },
  { mode: 'manual', label: 'Ask more often', description: 'Ask before actions that require tool approval.' },
  { mode: 'off', label: 'Fewer prompts', description: 'Skip normal tool approval prompts. Mac permissions still apply; some destructive terminal commands remain blocked.' }
]

export function ConsumerApprovalSettings({ profile }: { profile: string }) {
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default']
  const [state, setState] = useState<'error' | 'loading' | 'ready' | 'saving'>('loading')
  const [writeError, setWriteError] = useState(false)
  const [retry, setRetry] = useState(0)
  const scopeEpoch = useRef(0)

  useEffect(() => () => { scopeEpoch.current += 1 }, [profile])

  const request = useCallback((method: string, params?: Record<string, unknown>) =>
    requestGatewayForProfile(profile, method, params ?? {}, undefined, undefined, { spawnPriority: 'foreground' }), [profile])

  useEffect(() => {
    let current = true

    setState('loading')
    void syncApprovalModeForProfile(request, profile).then(
      () => {
        if (current) {
          setState('ready')
        }
      },
      () => {
        if (current) {
          setState('error')
        }
      }
    )

    return () => { current = false }
  }, [profile, request, retry])

  const choose = async (next: ApprovalMode) => {
    if (state !== 'ready' || next === mode) {
      return
    }

    const epoch = scopeEpoch.current

    if (next === 'off' && !await confirm({
      title: 'Use fewer approval prompts?',
      description: 'Jarvis will skip normal tool approval prompts for this AI profile. Mac permissions still apply; some destructive terminal commands remain blocked. You can change this later.',
      confirmLabel: 'Use fewer prompts'
    })) {
      return
    }

    if (scopeEpoch.current !== epoch) {return}

    setWriteError(false)
    setState('saving')

    try {
      const saved = await setApprovalModeForProfile(request, profile, next)

      if (scopeEpoch.current === epoch) {setWriteError(saved !== next)}
    } catch {
      if (scopeEpoch.current === epoch) {setWriteError(true)}
    } finally {
      if (scopeEpoch.current === epoch) {setState('ready')}
    }
  }

  return (
    <section aria-label="Action approvals" className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">Action approvals</h2>
      <p className="mt-2 text-sm text-muted-foreground">Choose how Jarvis asks before acting with this AI profile.</p>
      {state === 'error' ? (
        <div className="mt-4 flex items-center gap-4 text-sm" role="alert">
          <span>Couldn’t load approval settings.</span>
          <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="secondary">Retry</Button>
        </div>
      ) : state === 'loading' ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">Loading approval settings…</p>
      ) : (
        <div aria-label="Approval mode" className="mt-4 divide-y divide-(--ui-stroke-tertiary)" role="radiogroup">
          {OPTIONS.map(option => (
            <label className="flex cursor-pointer items-start gap-4 py-4" key={option.mode}>
              <input
                checked={mode === option.mode}
                className="mt-1 accent-(--ui-accent)"
                disabled={state === 'saving'}
                name={`approval-mode-${profile}`}
                onChange={() => void choose(option.mode)}
                type="radio"
                value={option.mode}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {writeError ? <p className="mt-3 text-sm text-(--ui-text-danger)" role="alert">Couldn’t save that choice. Your previous setting is still in effect.</p> : null}
    </section>
  )
}
