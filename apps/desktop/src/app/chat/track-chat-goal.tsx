import type { SessionGoalCreateResult, SessionGoalsListResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { GOALS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

interface TrackChatGoalProps {
  sessionId: string
  sessionTitle: string
}

/** A goal saved from chat points back to that conversation; no agent loop starts. */
export function TrackChatGoal({ sessionId, sessionTitle }: TrackChatGoalProps) {
  const gateway = useStore($gateway)
  const profile = useStore($activeGatewayProfile)
  const navigate = useNavigate()
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [tracked, setTracked] = useState(false)
  const dialogRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (targetSessionId) {
      inputRef.current?.focus()
    }
  }, [targetSessionId])

  useEffect(() => {
    let cancelled = false

    setTracked(false)

    if (gateway) {
      void gateway.request<SessionGoalsListResult>('session.goals.list', { profile }).then(
        result => {
          if (!cancelled) {
            const found = Array.isArray(result.goals) && result.goals.some(goal => goal.session_id === sessionId)

            setTracked(current => current || found)
          }
        },
        () => { /* The save path still has its own backend duplicate guard. */ }
      )
    }

    return () => { cancelled = true }
  }, [gateway, profile, sessionId])

  const close = () => {
    if (!saving) {
      setTargetSessionId(null)
      setError(false)
      triggerRef.current?.focus()
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()

    if (!gateway || !targetSessionId || !title.trim() || saving) {
      return
    }

    setSaving(true)
    setError(false)

    try {
      await gateway.request<SessionGoalCreateResult>('session.goals.create', {
        profile,
        source_session_id: targetSessionId,
        title: title.trim()
      })

      if ($gateway.get() !== gateway || $activeGatewayProfile.get() !== profile) {
        return
      }

      setTargetSessionId(null)
      setTracked(true)
      navigate(GOALS_ROUTE)
    } catch {
      if ($gateway.get() === gateway && $activeGatewayProfile.get() === profile) {
        setError(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        className="consumer-header-pill"
        onClick={() => {
          if (tracked) {
            navigate(GOALS_ROUTE)

            return
          }

          setTitle(sessionTitle === 'Jarvis' || sessionTitle === 'Untitled session' ? '' : sessionTitle)
          setError(false)
          setTargetSessionId(sessionId)
        }}
        ref={triggerRef}
        type="button"
      >
        <Codicon aria-hidden name="target" size="0.9rem" />
        <span>{tracked ? 'View goal' : 'Track goal'}</span>
      </button>
      {targetSessionId && createPortal(
        <div className="fixed inset-0 z-(--z-modal) grid place-items-center bg-black/22 p-4 backdrop-blur-[0.125rem]" onMouseDown={event => {
          if (event.target === event.currentTarget) {
            close()
          }
        }}>
          <form
            aria-label="Track this conversation as a goal"
            aria-modal="true"
            className="w-full max-w-lg space-y-5 rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) p-6 shadow-nous"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              } else if (event.key === 'Tab') {
                const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, input') ?? [])]
                  .filter(element => !element.hasAttribute('disabled'))

                const first = focusable[0]
                const last = focusable[focusable.length - 1]

                if (first && last && event.shiftKey && document.activeElement === first) {
                  event.preventDefault()
                  last.focus()
                } else if (first && last && !event.shiftKey && document.activeElement === last) {
                  event.preventDefault()
                  first.focus()
                }
              }
            }}
            onSubmit={event => void save(event)}
            ref={dialogRef}
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Track this goal</h2>
                <p className="mt-2 text-sm leading-6 text-(--ui-text-secondary)">Save a name for this conversation. Tracking is passive; Jarvis won't start background work.</p>
              </div>
              <Button aria-label="Close goal tracking" disabled={saving} onClick={close} size="sm" type="button" variant="ghost">Close</Button>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="track-chat-goal-title">Goal name</label>
              <Input id="track-chat-goal-title" maxLength={200} onChange={event => setTitle(event.target.value)} placeholder="What are you working toward?" ref={inputRef} value={title} />
            </div>
            {error && <p className="text-sm text-(--ui-text-danger)" role="alert">Could not save this goal. Check the connection or whether this chat is already tracked, then try again.</p>}
            <Button disabled={!title.trim() || saving || !gateway} type="submit">Save goal</Button>
          </form>
        </div>,
        document.body
      )}
    </>
  )
}
