import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { listOAuthProviders } from '@/api/config'
import { getGlobalModelInfo, setGlobalModel } from '@/api/models'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import type { JarvisCalendarEvent, JarvisCalendarStatus, JarvisOnboardingPermissionSnapshot, JarvisPermissionStatus } from '@/global'
import { useJarvisCopy } from '@/i18n/jarvis'
import {
  Calendar,
  Check,
  ChevronRight,
  FileText,
  Globe,
  KeyRound,
  Mail,
  MessageCircle,
  Mic,
  NotebookTabs,
  RefreshCw,
  ShieldLock
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $activeConnectionId } from '@/store/connections'
import { $activeGatewayProfile } from '@/store/profile'
import { $currentModel, $currentProvider } from '@/store/session'

import { ConsumerSettingsLayout } from '../preferences/settings-layout'

function statusLabel(status: JarvisPermissionStatus): string {
  if (status === 'granted') {
    return 'Allowed'
  }

  if (status === 'denied' || status === 'restricted') {
    return 'Needs attention'
  }

  if (status === 'not-determined') {
    return 'Not set up'
  }

  return 'Check access'
}

function Status({ active, children }: { active?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        active ? 'text-emerald-500' : 'text-(--ui-text-tertiary)'
      )}
    >
      {active ? <Check className="size-3.5" /> : null}
      {children}
    </span>
  )
}

function ConnectionRow({
  action,
  detail,
  icon: Icon,
  label,
  status
}: {
  action?: React.ReactNode
  detail: string
  icon: typeof Mail
  label: string
  status: React.ReactNode
}) {
  return (
    <div className="flex min-h-20 items-center gap-4 border-t border-(--ui-stroke-tertiary) px-5 py-4 first:border-t-0">
      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-(--ui-bg-tertiary)">
        <Icon className="size-5 text-(--ui-text-secondary)" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium tracking-tight">{label}</div>
        <div className="mt-1 text-sm text-(--ui-text-tertiary)">{detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {status}
        {action}
      </div>
    </div>
  )
}

export function ConnectionsView() {
  const s = useJarvisCopy()
  const activeConnectionId = useStore($activeConnectionId)
  const activeProfile = useStore($activeGatewayProfile)
  const calendarScope = JSON.stringify([activeConnectionId, activeProfile])
  const calendarScopeRef = useRef({ key: calendarScope })
  const refreshGeneration = useRef(0)

  // Each observed profile/connection switch gets a new identity. Comparing
  // only the scope string would accept a late A result after A → B → A.
  if (calendarScopeRef.current.key !== calendarScope) {
    calendarScopeRef.current = { key: calendarScope }
  }

  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const [permissions, setPermissions] = useState<JarvisOnboardingPermissionSnapshot | null>(null)
  const [permissionsCheckState, setPermissionsCheckState] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [refreshing, setRefreshing] = useState(false)
  const [requestingMicrophone, setRequestingMicrophone] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [calendar, setCalendar] = useState<JarvisCalendarStatus | null>(null)
  const [calendarBusy, setCalendarBusy] = useState(false)
  const [calendarEvents, setCalendarEvents] = useState<JarvisCalendarEvent[] | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [eventTitle, setEventTitle] = useState('')
  const [eventStart, setEventStart] = useState('')
  const [eventEnd, setEventEnd] = useState('')

  const [accountState, setAccountState] = useState<'checking' | 'connected' | 'disconnected' | 'unavailable'>(
    'checking'
  )

  const refresh = useCallback(async () => {
    const owner = calendarScopeRef.current
    const generation = ++refreshGeneration.current
    const isCurrent = () => owner === calendarScopeRef.current && generation === refreshGeneration.current
    setRefreshing(true)

    try {
      const getPermissions = window.hermesDesktop?.jarvisOnboarding?.getPermissions

      const [snapshotResult, accountsResult, calendarResult] = await Promise.allSettled([
        getPermissions?.(), listOAuthProviders(), window.hermesDesktop?.jarvisCalendar?.status()
      ])

      if (!isCurrent()) {return}

      const failures: string[] = []

      if (accountsResult.status === 'fulfilled') {
        setAccountState(
          accountsResult.value.providers.some(provider => provider.id === 'openai-codex' && provider.status.logged_in)
            ? 'connected'
            : 'disconnected'
        )
      } else {
        setAccountState('unavailable')
        failures.push('Could not check your AI account.')
      }

      if (snapshotResult.status === 'fulfilled' && snapshotResult.value) {
        setPermissions(snapshotResult.value)
        setPermissionsCheckState('ready')
      } else {
        setPermissionsCheckState(current => (current === 'ready' ? current : 'unavailable'))
        failures.push('Could not check Mac permissions.')
      }

      setCalendar(calendarResult.status === 'fulfilled' ? calendarResult.value ?? null : null)
      // A status refresh cannot prove that a previously read event is still authorized.
      setCalendarEvents(null)

      setError(failures.length > 0 ? failures.join(' ') : null)
    } catch {
      if (isCurrent()) {setError('Could not check this Mac. Try again.')}
    } finally {
      if (isCurrent()) {setRefreshing(false)}
    }
  }, [])

  useEffect(() => {
    setAccountState('checking')
    setError(null)
    setCalendar(null)
    setCalendarEvents(null)
    setCalendarError(null)
    setCalendarBusy(false)
    setEventTitle('')
    setEventStart('')
    setEventEnd('')
    void refresh()
  }, [calendarScope, refresh])

  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const fullDiskAllowed = permissions?.fullDiskAccess === 'granted'
  const microphoneAllowed = permissions?.microphone === 'granted'

  const macStatus = (status?: JarvisPermissionStatus) =>
    status ? statusLabel(status) : permissionsCheckState === 'checking' ? 'Checking' : 'Unavailable'

  const appStatus = (detected?: boolean) =>
    detected === undefined
      ? permissionsCheckState === 'checking'
        ? 'Checking'
        : 'Unavailable'
      : detected
        ? 'Detected'
        : 'Not installed'

  const search = query.trim().toLocaleLowerCase()
  const matches = (label: string) => label.toLocaleLowerCase().includes(search)
  const accountMatches = matches('ChatGPT / Codex')
  const filesMatch = matches('Files on this Mac')
  const microphoneMatch = matches('Microphone')
  const computerUseMatch = matches('Computer use')
  const macMatches = filesMatch || microphoneMatch || computerUseMatch
  const mailMatch = matches('Mail')
  const messagesMatch = matches('Messages')
  const notesMatch = matches('Notes')
  const whatsAppMatch = matches('WhatsApp')
  const browserMatch = matches('Browser')
  const calendarMatch = matches('Calendar')
  const appsMatch = mailMatch || messagesMatch || notesMatch || whatsAppMatch || browserMatch || calendarMatch

  const calendarLabel = !calendar?.supported
    ? 'Unavailable'
    : calendar.connected
      ? 'Connected'
      : calendar.authorization === 'denied' || calendar.authorization === 'restricted'
        ? 'Needs macOS access'
        : 'Not connected'

  const changeCalendarConnection = async (connect: boolean) => {
    const bridge = window.hermesDesktop?.jarvisCalendar

    if (!bridge) {return}
    const owner = calendarScopeRef.current
    setCalendarBusy(true)
    setCalendarError(null)
    setCalendarEvents(null)

    try {
      const next = connect ? await bridge.connect() : await bridge.disconnect()

      if (owner !== calendarScopeRef.current) {return}
      setCalendar(next)

      if (!next.connected) {setCalendarEvents(null)}

      if (connect && !next.connected) {setCalendarError('Calendar access was not granted. You can try again from macOS Settings.')}
    } catch {
      if (owner === calendarScopeRef.current) {setCalendarError('Could not change Calendar access. Try again.')}
    } finally {
      if (owner === calendarScopeRef.current) {setCalendarBusy(false)}
    }
  }

  const viewCalendar = async () => {
    const bridge = window.hermesDesktop?.jarvisCalendar

    if (!bridge || !calendar?.connected) {return}
    const owner = calendarScopeRef.current
    setCalendarBusy(true)
    setCalendarError(null)

    try {
      const start = new Date()
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
      const result = await bridge.list(start.toISOString(), end.toISOString())

      if (owner !== calendarScopeRef.current) {return}

      if (!result.ok || !result.events) {throw new Error('read_failed')}
      setCalendarEvents(result.events)
    } catch {
      if (owner !== calendarScopeRef.current) {return}
      setCalendarError('Could not read upcoming events. Check Calendar access and try again.')
      setCalendarEvents(null)
      const next = await bridge.status().catch(() => null)

      if (owner === calendarScopeRef.current) {setCalendar(next)}
    } finally {
      if (owner === calendarScopeRef.current) {setCalendarBusy(false)}
    }
  }

  const createCalendarEvent = async () => {
    const bridge = window.hermesDesktop?.jarvisCalendar

    if (!bridge || !calendar?.connected) {return}
    const owner = calendarScopeRef.current
    const start = new Date(eventStart)
    const end = new Date(eventEnd)

    if (!eventTitle.trim() || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      setCalendarError('Add a title and a valid start and end time.')

      return
    }

    setCalendarBusy(true)
    setCalendarError(null)

    try {
      const result = await bridge.create(eventTitle.trim(), start.toISOString(), end.toISOString())

      if (owner !== calendarScopeRef.current) {return}

      if (!result.ok && result.code === 'outcome_unknown') {
        setCalendarError('Could not confirm whether the event was created. Check Calendar before trying again.')
        setCalendarEvents(null)
        const next = await bridge.status().catch(() => null)

        if (owner === calendarScopeRef.current) {setCalendar(next)}

        return
      }

      if (!result.ok || !result.event) {throw new Error('create_failed')}
      setEventTitle('')
      setEventStart('')
      setEventEnd('')
      setCalendarEvents(current => current ? [...current, result.event!].sort((a, b) => a.start.localeCompare(b.start)) : null)
    } catch {
      if (owner !== calendarScopeRef.current) {return}
      setCalendarError('Event was not created. Check Calendar access and try again.')
      setCalendarEvents(null)
      const next = await bridge.status().catch(() => null)

      if (owner === calendarScopeRef.current) {setCalendar(next)}
    } finally {
      if (owner === calendarScopeRef.current) {setCalendarBusy(false)}
    }
  }

  return (
    <ConsumerSettingsLayout section="connections">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-(--ui-text-secondary)">
            Choose what Jarvis can use. You can grant access now or wait until a task needs it.
          </p>
        </div>
        <Button disabled={refreshing} onClick={() => void refresh()} size="sm" variant="secondary">
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error ? <p className="mt-5 text-sm text-destructive">{error}</p> : null}

      <SearchField
        aria-label="Search connections"
        containerClassName="mt-8 flex w-full rounded-xl bg-(--ui-bg-secondary) px-4 py-2 opacity-100"
        inputClassName="w-full [field-sizing:fixed]"
        onChange={setQuery}
        placeholder="Search connections"
        value={query}
      />

      {!accountMatches && !macMatches && !appsMatch ? (
        <p className="mt-10 text-sm text-(--ui-text-tertiary)">No matching connections.</p>
      ) : null}

      {accountMatches ? (
        <section className="mt-10">
          <h2 className="text-sm font-semibold">AI account</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
            <ConnectionRow
              action={
                accountState === 'disconnected' ? (
                  <Button
                    disabled={signingIn}
                    loading={signingIn}
                    onClick={async () => {
                      setSigningIn(true)
                      setError(null)

                      try {
                        const result = await window.hermesDesktop?.jarvisOnboarding?.startCodexOAuth?.()

                        if (!result?.ok) {
                          throw new Error(result?.message || 'ChatGPT sign-in did not finish.')
                        }

                        await setGlobalModel('openai-codex', 'gpt-5.6-sol')
                        const model = await getGlobalModelInfo()

                        $currentProvider.set(model.provider)
                        $currentModel.set(model.model)
                        await refresh()
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : 'ChatGPT sign-in did not finish.')
                      } finally {
                        setSigningIn(false)
                      }
                    }}
                    size="sm"
                  >
                    Connect
                  </Button>
                ) : null
              }
              detail={
                accountState === 'connected' && currentProvider === 'openai-codex'
                  ? currentModel
                  : 'Use your ChatGPT or Codex subscription. No API key required.'
              }
              icon={KeyRound}
              label="ChatGPT / Codex"
              status={
                <Status active={accountState === 'connected'}>
                  {accountState === 'connected'
                    ? 'Connected'
                    : accountState === 'disconnected'
                      ? 'Not connected'
                      : accountState === 'checking'
                        ? 'Checking'
                        : 'Unavailable'}
                </Status>
              }
            />
          </div>
        </section>
      ) : null}

      {macMatches ? (
        <section className="mt-9">
          <h2 className="text-sm font-semibold">This Mac</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
            {filesMatch ? (
              <ConnectionRow
                action={
                  permissions && window.hermesDesktop?.jarvisOnboarding?.openFullDiskAccess ? (
                    <Button
                      onClick={async () => {
                        try {
                          await window.hermesDesktop?.jarvisOnboarding?.openFullDiskAccess?.()
                        } catch {
                          setError('Could not open Full Disk Access settings.')
                        }
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {fullDiskAllowed ? 'Manage' : 'Allow'} <ChevronRight className="size-4" />
                    </Button>
                  ) : null
                }
                detail="Read files on this Mac when you ask. App access is separate."
                icon={FileText}
                label="Files on this Mac"
                status={<Status active={fullDiskAllowed}>{macStatus(permissions?.fullDiskAccess)}</Status>}
              />
            ) : null}
            {microphoneMatch ? (
              <ConnectionRow
                action={
                  microphoneAllowed ||
                  !permissions ||
                  !window.hermesDesktop?.jarvisOnboarding?.requestMicrophone ? null : (
                    <Button
                      disabled={requestingMicrophone}
                      loading={requestingMicrophone}
                      onClick={async () => {
                        setRequestingMicrophone(true)
                        setError(null)

                        try {
                          await window.hermesDesktop?.jarvisOnboarding?.requestMicrophone?.()
                          await refresh()
                        } catch {
                          setError('Could not request microphone access. Try again from System Settings.')
                        } finally {
                          setRequestingMicrophone(false)
                        }
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      Allow <ChevronRight className="size-4" />
                    </Button>
                  )
                }
                detail="Speak naturally to Jarvis when you choose voice input."
                icon={Mic}
                label="Microphone"
                status={<Status active={microphoneAllowed}>{macStatus(permissions?.microphone)}</Status>}
              />
            ) : null}
            {computerUseMatch ? (
              <ConnectionRow
                detail="Requested only when a task needs to see or interact with another app."
                icon={ShieldLock}
                label="Computer use"
                status={<Status>Set up when needed</Status>}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {appsMatch ? (
        <section className="mt-9">
          <h2 className="text-sm font-semibold">Apps</h2>
          <p className="mt-1 text-sm text-(--ui-text-tertiary)">
            {calendar?.connected ? s.appInventoryCalendarConnectedDetail : s.appInventoryDetail}
          </p>
          <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
            {calendarMatch ? (
              <>
                <ConnectionRow
                  action={calendar?.supported ? (
                    <Button
                      disabled={calendarBusy}
                      loading={calendarBusy}
                      onClick={() => void changeCalendarConnection(!calendar.connected)}
                      size="sm"
                      variant={calendar.connected ? 'secondary' : 'default'}
                    >
                      {calendar.connected ? 'Disconnect' : 'Connect'}
                    </Button>
                  ) : null}
                  detail="Apple Calendar preview. macOS access and a separate Jarvis connection are both required."
                  icon={Calendar}
                  label="Calendar"
                  status={<Status active={calendar?.connected}>{calendarLabel}</Status>}
                />
                {calendar?.connected ? (
                  <div className="border-t border-(--ui-stroke-tertiary) px-5 py-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Upcoming events</p>
                        <p className="text-xs text-(--ui-text-tertiary)">Only loaded when you ask. Next 7 days.</p>
                      </div>
                      <Button disabled={calendarBusy} onClick={() => void viewCalendar()} size="sm" variant="secondary">View upcoming</Button>
                    </div>
                    {calendarEvents ? (
                      <ul aria-label="Upcoming Calendar events" className="mt-4 space-y-2 text-sm">
                        {calendarEvents.length ? calendarEvents.map(event => (
                          <li className="flex justify-between gap-3" key={event.id || `${event.start}-${event.title}`}>
                            <span className="min-w-0 truncate">{event.title || 'Untitled event'}</span>
                            <time className="shrink-0 text-(--ui-text-tertiary)" dateTime={event.start}>{new Date(event.start).toLocaleString()}</time>
                          </li>
                        )) : <li className="text-(--ui-text-tertiary)">No events in the next 7 days.</li>}
                      </ul>
                    ) : null}
                    <div className="mt-6 border-t border-(--ui-stroke-tertiary) pt-5">
                      <p className="text-sm font-medium">Add an event</p>
                      <p className="mt-1 text-xs text-(--ui-text-tertiary)">Nothing is added until you choose Create event.</p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <input aria-label="Event title" className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-primary) px-3 py-2 text-sm sm:col-span-2" maxLength={200} onChange={event => setEventTitle(event.target.value)} placeholder="Event title" value={eventTitle} />
                        <input aria-label="Event start" className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-primary) px-3 py-2 text-sm" onChange={event => setEventStart(event.target.value)} type="datetime-local" value={eventStart} />
                        <input aria-label="Event end" className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-primary) px-3 py-2 text-sm" onChange={event => setEventEnd(event.target.value)} type="datetime-local" value={eventEnd} />
                      </div>
                      <Button className="mt-3" disabled={calendarBusy} onClick={() => void createCalendarEvent()} size="sm">Create event</Button>
                    </div>
                  </div>
                ) : null}
                {calendarError ? <p className="border-t border-(--ui-stroke-tertiary) px-5 py-3 text-sm text-destructive">{calendarError}</p> : null}
              </>
            ) : null}
            {mailMatch ? (
              <ConnectionRow
                detail="App detection only. Mail access is not connected yet."
                icon={Mail}
                label="Mail"
                status={<Status>{appStatus(permissions?.apps.mail)}</Status>}
              />
            ) : null}
            {messagesMatch ? (
              <ConnectionRow
                detail="App detection only. Message access is not connected yet."
                icon={MessageCircle}
                label="Messages"
                status={<Status>{appStatus(permissions?.apps.messages)}</Status>}
              />
            ) : null}
            {notesMatch ? (
              <ConnectionRow
                detail="App detection only. Notes access is not connected yet."
                icon={NotebookTabs}
                label="Notes"
                status={<Status>{appStatus(permissions?.apps.notes)}</Status>}
              />
            ) : null}
            {whatsAppMatch ? (
              <ConnectionRow
                detail="App detection only. WhatsApp access is not connected yet."
                icon={MessageCircle}
                label="WhatsApp"
                status={<Status>{appStatus(permissions?.apps.whatsapp)}</Status>}
              />
            ) : null}
            {browserMatch ? (
              <ConnectionRow
                detail="Browser research is set up when a task needs it."
                icon={Globe}
                label="Browser"
                status={<Status>On demand</Status>}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      <p className="mt-8 text-xs leading-5 text-(--ui-text-tertiary)">
        Connecting an account or app grants access to that source, not blanket approval for every action. Some actions
        can run without a separate prompt; review your approval setting before using a connection.
      </p>
    </ConsumerSettingsLayout>
  )
}
