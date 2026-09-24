import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import type { JarvisOnboardingPermissionSnapshot } from '@/global'
import { useJarvisCopy } from '@/i18n/jarvis'
import { Check, ChevronLeft, FileText, Lock, Mail, MessageCircle, Mic, NotebookTabs, ShieldLock } from '@/lib/icons'
import { cn } from '@/lib/utils'

type Step = 'connect' | 'files' | 'apps' | 'microphone' | 'ready'
type AppId = keyof JarvisOnboardingPermissionSnapshot['apps']

interface JarvisSetupJourneyProps {
  alreadyConnected?: boolean
  reviewMode?: boolean
  bootstrapComplete: boolean
  bootstrapError: string | null
  onBeginSetup: () => Promise<void>
  onConnectOther: () => void
  onFinish: () => Promise<void>
  onSkip?: () => void
  onShowInstallDetails: () => void
}

const STEPS: Step[] = ['connect', 'files', 'apps', 'microphone', 'ready']

const APPS: { id: AppId; label: string; icon: typeof Mail }[] = [
  { id: 'mail', label: 'Mail', icon: Mail },
  { id: 'messages', label: 'Messages', icon: MessageCircle },
  { id: 'notes', label: 'Notes', icon: NotebookTabs },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle }
]

const EMPTY_PERMISSIONS: JarvisOnboardingPermissionSnapshot = {
  apps: { mail: false, messages: false, notes: false, whatsapp: false },
  fullDiskAccess: 'unknown',
  microphone: 'not-determined',
  platform: 'darwin'
}

function StepDots({ step }: { step: Step }) {
  const active = STEPS.indexOf(step)

  return (
    <div aria-label={`Setup step ${active + 1} of ${STEPS.length}`} className="flex items-center gap-2">
      {STEPS.map((item, index) => (
        <span
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            index === active
              ? 'w-6 bg-(--ui-accent)'
              : index < active
                ? 'w-1.5 bg-(--ui-text-secondary)'
                : 'w-1.5 bg-(--ui-stroke-primary)'
          )}
          key={item}
        />
      ))}
    </div>
  )
}

function SetupShell({ children, onBack, onClose, step }: { children: React.ReactNode; onBack?: () => void; onClose?: () => void; step: Step }) {
  return (
    <div
      className="fixed inset-0 z-(--z-setup) grid grid-rows-[5.25rem_1fr_4rem] bg-(--ui-chat-surface-background) text-foreground"
      data-glass-opaque=""
    >
      <header className="flex items-center justify-between px-8 pt-5 [-webkit-app-region:drag]">
        <div className="flex items-center gap-3">
          {onBack ? (
            <Button
              aria-label="Back"
              className="[-webkit-app-region:no-drag]"
              onClick={onBack}
              size="icon-lg"
              variant="secondary"
            >
              <ChevronLeft />
            </Button>
          ) : (
            <BrandMark className="size-10" />
          )}
          <span className="text-sm font-medium tracking-tight">JarvisAIGeorge</span>
        </div>
        <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
          <span className="text-xs font-medium text-(--ui-text-tertiary)">
            Step {STEPS.indexOf(step) + 1} of {STEPS.length}
          </span>
          {onClose ? <Button onClick={onClose} size="sm" variant="ghost">Close setup</Button> : null}
        </div>
      </header>

      <main className="flex min-h-0 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="w-full max-w-[43rem] animate-in fade-in slide-in-from-bottom-2 duration-300">{children}</div>
      </main>

      <footer className="flex items-center justify-center pb-6">
        <StepDots step={step} />
      </footer>
    </div>
  )
}

function PermissionStatus({ granted }: { granted: boolean }) {
  return granted ? (
    <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
      <Check className="size-3.5" /> Allowed
    </span>
  ) : null
}

export function JarvisSetupJourney({
  alreadyConnected = false,
  reviewMode = false,
  bootstrapComplete,
  bootstrapError,
  onBeginSetup,
  onConnectOther,
  onFinish,
  onSkip,
  onShowInstallDetails
}: JarvisSetupJourneyProps) {
  const s = useJarvisCopy()
  const [step, setStep] = useState<Step>('connect')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [permissionActionPending, setPermissionActionPending] = useState(false)
  const [permissions, setPermissions] = useState(EMPTY_PERMISSIONS)

  const stepIndex = STEPS.indexOf(step)
  const back = stepIndex > 0 ? () => setStep(STEPS[stepIndex - 1]) : undefined

  useEffect(() => setPermissionError(null), [step])

  useEffect(() => {
    if (step !== 'files' && step !== 'apps' && step !== 'microphone') {
      return
    }

    let disposed = false

    const refresh = async () => {
      const snapshot = await window.hermesDesktop?.jarvisOnboarding?.getPermissions?.()

      if (!disposed && snapshot) {
        setPermissions(snapshot)
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [step])


  if (step === 'connect') {
    return (
      <SetupShell onClose={reviewMode ? onSkip : undefined} step={step}>
        <div className="mx-auto grid max-w-xl justify-items-center text-center">
          <BrandMark className="size-20" />
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-(--ui-text-tertiary)">
            Your AI, on your Mac
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">Set up Jarvis</h1>
          <p className="mt-4 max-w-lg text-base leading-7 text-(--ui-text-secondary)">
            Connect your AI account, choose what Jarvis can access, and start with a private assistant that works from
            this Mac.
          </p>

          <div className="mt-9 grid w-full max-w-sm gap-3">
            <Button
              className="w-full"
              disabled={starting}
              loading={starting}
              onClick={async () => {
                setStarting(true)
                setStartError(null)

                try {
                  await onBeginSetup()
                  setStep('files')
                } catch (error) {
                  setStartError(error instanceof Error ? error.message : 'Setup could not start.')
                } finally {
                  setStarting(false)
                }
              }}
              size="lg"
            >
              Get started
            </Button>
            <Button onClick={onConnectOther} size="sm" variant="text">
              Other AI providers
            </Button>
            {onSkip && !reviewMode ? (
              <Button onClick={onSkip} size="sm" variant="text">
                I'll choose a provider later
              </Button>
            ) : null}
          </div>

          <p className="mt-6 text-xs leading-5 text-(--ui-text-tertiary)">
            {alreadyConnected
              ? 'Your existing connection and conversations will stay as they are.'
              : 'You’ll sign in securely with ChatGPT before setup finishes. No API key is required.'}
          </p>
          {startError ? <p className="mt-4 text-sm text-destructive">{startError}</p> : null}
        </div>
      </SetupShell>
    )
  }

  if (step === 'files') {
    const granted = permissions.fullDiskAccess === 'granted'

    return (
      <SetupShell onBack={back} onClose={reviewMode ? onSkip : undefined} step={step}>
        <div className="mx-auto max-w-2xl text-center">
          <FileText className="mx-auto size-14 text-(--ui-accent)" strokeWidth={1.5} />
          <h1 className="mt-5 text-3xl font-semibold tracking-[-0.035em]">Let Jarvis work with your files?</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-(--ui-text-secondary)">
            Full Disk Access can help Jarvis read protected local files when you ask. App-specific access is separate and
            not connected yet.
          </p>

          <div className="mt-8 flex items-center gap-4 rounded-2xl bg-(--ui-bg-quaternary) p-5 text-left">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-(--ui-chat-surface-background)">
              <Lock className="size-5 text-(--ui-text-secondary)" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Full Disk Access</div>
              <div className="mt-1 text-sm text-(--ui-text-tertiary)">
                Needed for some protected files. You can continue without it.
              </div>
            </div>
            {granted ? (
              <PermissionStatus granted />
            ) : (
              <Button
                disabled={permissionActionPending}
                onClick={async () => {
                  setPermissionActionPending(true)
                  setPermissionError(null)

                  try {
                    const opened = await window.hermesDesktop?.jarvisOnboarding?.openFullDiskAccess?.()

                    if (!opened) {
                      throw new Error('System Settings could not open. Try again or continue without access.')
                    }
                  } catch {
                    setPermissionError('System Settings could not open. Try again or continue without access.')
                  } finally {
                    setPermissionActionPending(false)
                  }
                }}
                size="sm"
              >
                Open settings
              </Button>
            )}
          </div>

          {permissionError ? <p className="mt-3 text-sm text-destructive" role="alert">{permissionError}</p> : null}

          <div className="mt-8 flex justify-center gap-3">
            <Button onClick={() => setStep('apps')} size="lg">
              {granted ? 'Continue' : 'Continue without access'}
            </Button>
          </div>
          <p className="mt-4 text-xs text-(--ui-text-tertiary)">You can change this later in System Settings.</p>
        </div>
      </SetupShell>
    )
  }

  if (step === 'apps') {
    return (
      <SetupShell onBack={back} onClose={reviewMode ? onSkip : undefined} step={step}>
        <div className="mx-auto max-w-2xl">
          <div className="text-center">
            <ShieldLock className="mx-auto size-14 text-(--ui-accent)" strokeWidth={1.5} />
            <h1 className="mt-5 text-3xl font-semibold tracking-[-0.035em]">{s.appInventory}</h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-(--ui-text-secondary)">
              {s.appInventoryDetail}
            </p>
          </div>

          <div className="mt-7 overflow-hidden rounded-2xl bg-(--ui-bg-quaternary)">
            {APPS.map(({ id, icon: Icon, label }, index) => {
              const isInstalled = permissions.apps[id]

              return (
                <div
                  className={cn(
                    'flex items-center gap-4 px-5 py-4',
                    index > 0 && 'border-t border-(--ui-stroke-tertiary)'
                  )}
                  key={id}
                >
                  <Icon className="size-5 shrink-0 text-(--ui-text-secondary)" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{label}</div>
                    <div className="mt-0.5 text-xs text-(--ui-text-tertiary)">
                      {isInstalled ? 'Detected on this Mac' : 'Not installed'}
                    </div>
                  </div>
                  <span className="text-sm text-(--ui-text-tertiary)">{isInstalled ? s.appPending : 'Unavailable'}</span>
                </div>
              )
            })}
          </div>

          <div className="mt-7 flex justify-center">
            <Button onClick={() => setStep('microphone')} size="lg">
              Continue
            </Button>
          </div>
        </div>
      </SetupShell>
    )
  }

  if (step === 'microphone') {
    const granted = permissions.microphone === 'granted'
    const denied = permissions.microphone === 'denied'
    const restricted = permissions.microphone === 'restricted'

    return (
      <SetupShell onBack={back} onClose={reviewMode ? onSkip : undefined} step={step}>
        <div className="mx-auto max-w-2xl text-center">
          <Mic className="mx-auto size-14 text-(--ui-accent)" strokeWidth={1.5} />
          <h1 className="mt-5 text-3xl font-semibold tracking-[-0.035em]">Enable voice input?</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-(--ui-text-secondary)">
            Speak naturally to Jarvis and turn voice into text anywhere in the app.
          </p>

          <div className="mt-8 flex items-center gap-4 rounded-2xl bg-(--ui-bg-quaternary) p-5 text-left">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-(--ui-chat-surface-background)">
              <Mic className="size-5 text-(--ui-text-secondary)" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Microphone</div>
              <div className="mt-1 text-sm text-(--ui-text-tertiary)">
                {restricted
                  ? 'Microphone access is restricted on this Mac.'
                  : denied
                    ? 'Access was denied. You can change it in System Settings.'
                    : 'Used only when you activate voice input.'}
              </div>
            </div>
            {granted ? (
              <PermissionStatus granted />
            ) : restricted ? null : (
              <Button
                disabled={permissionActionPending}
                onClick={async () => {
                  setPermissionActionPending(true)
                  setPermissionError(null)

                  try {
                    const request = window.hermesDesktop?.jarvisOnboarding?.requestMicrophone

                    if (!request) {
                      throw new Error('Microphone settings are unavailable.')
                    }

                    await request()
                    const snapshot = await window.hermesDesktop?.jarvisOnboarding?.getPermissions?.()

                    if (snapshot) {
                      setPermissions(snapshot)
                    }
                  } catch {
                    setPermissionError('Microphone settings could not open. Try again or skip for now.')
                  } finally {
                    setPermissionActionPending(false)
                  }
                }}
                size="sm"
              >
                {denied ? 'Open settings' : 'Allow'}
              </Button>
            )}
          </div>

          {permissionError ? <p className="mt-3 text-sm text-destructive" role="alert">{permissionError}</p> : null}

          <div className="mt-8 flex justify-center gap-3">
            <Button onClick={() => setStep('ready')} size="lg">
              {granted ? 'Continue' : 'Skip for now'}
            </Button>
          </div>
        </div>
      </SetupShell>
    )
  }

  return (
    <SetupShell onBack={back} onClose={reviewMode ? onSkip : undefined} step="ready">
      <div className="mx-auto grid max-w-xl justify-items-center text-center">
        <div className="grid size-20 place-items-center rounded-[1.5rem] bg-(--ui-accent) text-(--ui-accent-foreground)">
          {bootstrapComplete ? <Check className="size-9" strokeWidth={2} /> : <BrandMark className="size-12" />}
        </div>
        <h1 className="mt-7 text-4xl font-semibold tracking-[-0.04em]">
          {alreadyConnected
            ? 'Setup reviewed'
            : bootstrapComplete ? 'Finish connecting Jarvis' : bootstrapError ? 'Setup needs attention' : 'Preparing Jarvis'}
        </h1>
        <p className="mt-4 max-w-lg text-base leading-7 text-(--ui-text-secondary)">
          {alreadyConnected
            ? 'Your account and conversations are unchanged. You can adjust access later in Connections.'
            : bootstrapComplete
            ? 'One last step: sign in with ChatGPT to start using Jarvis.'
            : bootstrapError
              ? 'Jarvis could not finish setup. Your permission choices were saved.'
              : 'Jarvis is finishing setup in the background. This can take a few minutes the first time.'}
        </p>

        <div className="mt-9 grid w-full max-w-sm gap-3">
          {bootstrapError ? (
            <Button className="w-full" onClick={onShowInstallDetails} size="lg">
              View setup details
            </Button>
          ) : (
            <Button
              className="w-full"
              disabled={!bootstrapComplete || signingIn}
              loading={!bootstrapComplete || signingIn}
              onClick={async () => {
                setSigningIn(true)
                setSignInError(null)

                try {
                  await onFinish()
                } catch (error) {
                  setSignInError(error instanceof Error ? error.message : 'ChatGPT sign-in did not finish.')
                  setSigningIn(false)
                }
              }}
              size="lg"
            >
              {alreadyConnected ? 'Return to Jarvis' : signingIn ? 'Finish sign-in in your browser' : 'Continue with ChatGPT / Codex'}
            </Button>
          )}
          {onSkip && !reviewMode && bootstrapComplete && !signingIn ? (
            <Button onClick={onSkip} size="sm" variant="text">
              I'll choose a provider later
            </Button>
          ) : null}
          {signInError ? <p className="text-sm text-destructive">{signInError}</p> : null}
        </div>
      </div>
    </SetupShell>
  )
}
