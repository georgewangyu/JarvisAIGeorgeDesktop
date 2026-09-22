import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { listOAuthProviders } from '@/api/config'
import { getGlobalModelInfo, setGlobalModel } from '@/api/models'
import { Button } from '@/components/ui/button'
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

const EMPTY_PERMISSIONS: JarvisOnboardingPermissionSnapshot = {
  apps: { mail: false, messages: false, notes: false, whatsapp: false },
  fullDiskAccess: 'unknown',
  microphone: 'not-determined',
  platform: 'darwin'
}

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
  const [permissions, setPermissions] = useState(EMPTY_PERMISSIONS)
  const [refreshing, setRefreshing] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      const [snapshot, accounts] = await Promise.all([
        window.hermesDesktop?.jarvisOnboarding?.getPermissions?.(),
        listOAuthProviders()
      ])

      setSignedIn(accounts.providers.some(provider => provider.id === 'openai-codex' && provider.status.logged_in))

      if (snapshot) {
        setPermissions(snapshot)
      }

      setError(null)
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

  const fullDiskAllowed = permissions.fullDiskAccess === 'granted'
  const microphoneAllowed = permissions.microphone === 'granted'

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

      <section className="mt-10">
        <h2 className="text-sm font-semibold">AI account</h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
          <ConnectionRow
            action={
              signedIn ? null : (
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
              )
            }
            detail={
              signedIn && currentProvider === 'openai-codex'
                ? currentModel
                : 'Use your ChatGPT or Codex subscription. No API key required.'
            }
            icon={KeyRound}
            label="ChatGPT / Codex"
            status={<Status active={signedIn}>{signedIn ? 'Connected' : 'Not connected'}</Status>}
          />
        </div>
      </section>

      <section className="mt-9">
        <h2 className="text-sm font-semibold">This Mac</h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
          <ConnectionRow
            action={
              fullDiskAllowed ? null : (
                <Button
                  onClick={() => void window.hermesDesktop?.jarvisOnboarding?.openFullDiskAccess?.()}
                  size="sm"
                  variant="secondary"
                >
                  Allow <ChevronRight className="size-4" />
                </Button>
              )
            }
            detail="Find information in files and supported Mac apps when you ask."
            icon={FileText}
            label="Files and local apps"
            status={<Status active={fullDiskAllowed}>{statusLabel(permissions.fullDiskAccess)}</Status>}
          />
          <ConnectionRow
            action={
              microphoneAllowed ? null : (
                <Button
                  onClick={async () => {
                    await window.hermesDesktop?.jarvisOnboarding?.requestMicrophone?.()
                    await refresh()
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
            status={<Status active={microphoneAllowed}>{statusLabel(permissions.microphone)}</Status>}
          />
          <ConnectionRow
            detail="Requested only when a task needs to see or interact with another app."
            icon={ShieldLock}
            label="Computer use"
            status={<Status>Set up when needed</Status>}
          />
        </div>
      </section>

      <section className="mt-9">
        <h2 className="text-sm font-semibold">Apps</h2>
        <p className="mt-1 text-sm text-(--ui-text-tertiary)">{s.appInventoryDetail}</p>
        <div className="mt-3 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
          <ConnectionRow
            detail="Find messages and prepare replies."
            icon={Mail}
            label="Mail"
            status={
              <Status active={permissions.apps.mail}>{permissions.apps.mail ? 'Detected' : 'Not installed'}</Status>
            }
          />
          <ConnectionRow
            detail="Find conversations and prepare messages."
            icon={MessageCircle}
            label="Messages"
            status={
              <Status active={permissions.apps.messages}>
                {permissions.apps.messages ? 'Detected' : 'Not installed'}
              </Status>
            }
          />
          <ConnectionRow
            detail="Find, summarize, and update notes when requested."
            icon={NotebookTabs}
            label="Notes"
            status={
              <Status active={permissions.apps.notes}>{permissions.apps.notes ? 'Detected' : 'Not installed'}</Status>
            }
          />
          <ConnectionRow
            detail="Use approved browser context for research and web tasks."
            icon={Globe}
            label="Browser"
            status={<Status active>Available</Status>}
          />
        </div>
      </section>

      <p className="mt-8 text-xs leading-5 text-(--ui-text-tertiary)">
        Jarvis asks before consequential actions such as sending, publishing, purchasing, or deleting important data.
      </p>
    </ConsumerSettingsLayout>
  )
}
