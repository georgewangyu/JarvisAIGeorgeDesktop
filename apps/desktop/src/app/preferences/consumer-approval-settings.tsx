import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useJarvisCopy } from '@/i18n/jarvis'
import { $approvalModes, type ApprovalMode, setApprovalModeForProfile, syncApprovalModeForProfile } from '@/store/approval-mode'
import { confirm } from '@/store/confirm'
import { requestGatewayForProfile } from '@/store/gateway'

export function ConsumerApprovalSettings({ profile }: { profile: string }) {
  const s = useJarvisCopy().approval

  const options: { description: string; label: string; mode: ApprovalMode }[] = [
    { mode: 'smart', ...s.smart },
    { mode: 'manual', ...s.manual },
    { mode: 'off', ...s.off }
  ]

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
      title: s.confirmTitle,
      description: s.confirmDetail,
      confirmLabel: s.confirmLabel
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
    <section aria-label={s.title} className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">{s.title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{s.detail}</p>
      {state === 'error' ? (
        <div className="mt-4 flex items-center gap-4 text-sm" role="alert">
          <span>{s.loadError}</span>
          <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="secondary">{s.retry}</Button>
        </div>
      ) : state === 'loading' ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">{s.loading}</p>
      ) : (
        <div aria-label={s.modeLabel} className="mt-4 divide-y divide-(--ui-stroke-tertiary)" role="radiogroup">
          {options.map(option => (
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
      {writeError ? <p className="mt-3 text-sm text-(--ui-text-danger)" role="alert">{s.saveError}</p> : null}
    </section>
  )
}
