import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { isSubmitEnter } from '@/lib/ime'
import {
  $quickEntry,
  canUseQuickEntry,
  loadQuickEntrySettings,
  QUICK_ENTRY_DEFAULT_SHORTCUT,
  saveQuickEntrySettings
} from '@/store/quick-entry'

import { ListRow, ToggleRow } from './primitives'

/**
 * Quick Entry — the global-hotkey mini composer's settings rows.
 *
 * The MAIN process is authoritative (it owns the OS accelerator), so this reads
 * the live registration state on mount and surfaces the failure the feature must
 * never swallow: a chord another app already owns comes back `registered: false`
 * with `error: 'taken'` and says so, right under the field.
 */
export function QuickEntrySettings({ consumer = false }: { consumer?: boolean }) {
  const { t } = useI18n()
  const q = t.settings.quickEntry
  const state = useStore($quickEntry)
  // The field is a local draft: the accelerator is only committed on blur/Enter,
  // so a half-typed chord ("Alt+") never tears down the live registration.
  const [draft, setDraft] = useState<null | string>(null)

  useEffect(() => {
    void loadQuickEntrySettings()
  }, [])

  if (!canUseQuickEntry()) {
    return null
  }

  const commit = () => {
    const next = (draft ?? '').trim()
    setDraft(null)

    if (next && next !== state.shortcut) {
      void saveQuickEntrySettings({ shortcut: next })
    }
  }

  const status =
    state.registered === null
      ? null
      : state.error === 'taken'
        ? q.takenBy
        : state.error === 'invalid'
          ? q.invalidShortcut
          : state.enabled && state.registered
            ? q.active
            : null

  const shortcutInput = (
    <Input
      aria-label={q.shortcutTitle}
      disabled={!state.enabled}
      onBlur={commit}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (isSubmitEnter(event)) {
          event.preventDefault()
          commit()
        }
      }}
      placeholder={QUICK_ENTRY_DEFAULT_SHORTCUT}
      value={draft ?? state.shortcut}
    />
  )

  if (consumer) {
    return (
      <div className="mt-4 space-y-5">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="font-medium">{q.enabledTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{q.enabledDesc}</p>
          </div>
          <Switch
            aria-label={q.enabledTitle}
            checked={state.enabled}
            onCheckedChange={enabled => {
              triggerHaptic('selection')
              void saveQuickEntrySettings({ enabled })
            }}
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          <div className="min-w-0">
            <p className="font-medium">{q.shortcutTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{q.shortcutDesc}</p>
            {status && (
              <p className={state.error ? 'mt-1 text-sm text-amber-500/90' : 'mt-1 text-sm text-muted-foreground'}>
                {status}
              </p>
            )}
          </div>
          <div className="w-full shrink-0 sm:w-56">{shortcutInput}</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <ToggleRow
        checked={state.enabled}
        description={q.enabledDesc}
        label={q.enabledTitle}
        onChange={enabled => void saveQuickEntrySettings({ enabled })}
      />
      <ListRow
        action={shortcutInput}
        below={
          status && (
            <div
              className={
                state.error
                  ? 'mt-1 text-[length:var(--conversation-caption-font-size)] text-amber-500/90'
                  : 'mt-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'
              }
            >
              {status}
            </div>
          )
        }
        description={q.shortcutDesc}
        title={q.shortcutTitle}
      />
    </>
  )
}
