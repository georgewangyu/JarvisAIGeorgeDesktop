import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
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
  retryQuickEntrySettings,
  saveQuickEntrySettings
} from '@/store/quick-entry'

import { ListRow, ToggleRow } from './primitives'

function displayShortcut(shortcut: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

  const keyNames: Record<string, string> = {
    Alt: isMac ? '⌥' : 'Alt',
    Command: isMac ? '⌘' : 'Win',
    CommandOrControl: isMac ? '⌘' : 'Ctrl',
    Control: isMac ? '⌃' : 'Ctrl',
    Option: isMac ? '⌥' : 'Alt',
    Shift: isMac ? '⇧' : 'Shift',
    Space: 'Space'
  }

  return shortcut
    .split('+')
    .map(part => keyNames[part] ?? part)
    .join(isMac ? ' ' : ' + ')
}

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
  const [editingShortcut, setEditingShortcut] = useState(false)

  useEffect(() => {
    void loadQuickEntrySettings()
  }, [])

  if (!canUseQuickEntry()) {
    return null
  }

  const commit = () => {
    const next = (draft ?? '').trim()
    setDraft(null)
    setEditingShortcut(false)

    if (next && next !== state.shortcut) {
      void saveQuickEntrySettings({ shortcut: next })
    }
  }

  const registrationStatus = state.error
    ? { invalid: q.invalidShortcut, taken: q.takenBy }[state.error]
    : state.enabled && state.registered
      ? q.active
      : null

  const status = state.failure
    ? { load: q.loadFailed, save: q.saveFailed }[state.failure]
    : state.registered === null
      ? null
      : registrationStatus

  const shortcutInput = (
    <Input
      aria-label={q.shortcutTitle}
      disabled={!state.enabled}
      onBlur={commit}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape' && consumer) {
          setDraft(null)
          setEditingShortcut(false)

          return
        }

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
            {editingShortcut && <p className="mt-1 text-sm text-muted-foreground">{q.shortcutDesc}</p>}
            {status && (
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className={state.error || state.failure ? 'text-sm text-amber-500/90' : 'text-sm text-muted-foreground'}>
                  {status}
                </p>
                {state.failure && <Button onClick={() => void retryQuickEntrySettings()} size="inline" variant="textStrong">{t.common.retry}</Button>}
              </div>
            )}
          </div>
          <div className="w-full shrink-0 sm:w-56">
            {editingShortcut ? (
              shortcutInput
            ) : (
              <button
                aria-label={`${t.common.change} ${q.shortcutTitle}`}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-(--ui-surface-secondary,transparent) disabled:opacity-50"
                disabled={!state.enabled}
                onClick={() => setEditingShortcut(true)}
                type="button"
              >
                <kbd className="font-sans font-medium">{displayShortcut(state.shortcut)}</kbd>
                <span className="text-muted-foreground">{t.common.change}</span>
              </button>
            )}
          </div>
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
                state.error || state.failure
                  ? 'mt-1 text-[length:var(--conversation-caption-font-size)] text-amber-500/90'
                  : 'mt-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'
              }
            >
              <span>{status}</span>
              {state.failure && <Button className="ml-2" onClick={() => void retryQuickEntrySettings()} size="inline" variant="textStrong">{t.common.retry}</Button>}
            </div>
          )
        }
        description={q.shortcutDesc}
        title={q.shortcutTitle}
      />
    </>
  )
}
