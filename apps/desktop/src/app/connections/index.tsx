import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { listOAuthProviders } from '@/api/config'
import { getGlobalModelInfo, setGlobalModel } from '@/api/models'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import type { JarvisOnboardingPermissionSnapshot, JarvisPermissionStatus } from '@/global'
import { useJarvisCopy } from '@/i18n/jarvis'
import {
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
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const [permissions, setPermissions] = useState<JarvisOnboardingPermissionSnapshot | null>(null)
  const [permissionsCheckState, setPermissionsCheckState] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [refreshing, setRefreshing] = useState(false)
  const [requestingMicrophone, setRequestingMicrophone] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const [accountState, setAccountState] = useState<'checking' | 'connected' | 'disconnected' | 'unavailable'>(
    'checking'
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      const getPermissions = window.hermesDesktop?.jarvisOnboarding?.getPermissions
      const [snapshotResult, accountsResult] = await Promise.allSettled([getPermissions?.(), listOAuthProviders()])

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

      setError(failures.length > 0 ? failures.join(' ') : null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check this Mac.')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()

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
  const appsMatch = mailMatch || messagesMatch || notesMatch || whatsAppMatch || browserMatch

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
          <p className="mt-1 text-sm text-(--ui-text-tertiary)">{s.appInventoryDetail}</p>
          <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
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
        Jarvis asks before consequential actions such as sending, publishing, purchasing, or deleting important data.
      </p>
    </ConsumerSettingsLayout>
  )
}
