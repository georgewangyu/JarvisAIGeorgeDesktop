import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { LanguageSwitcher } from '@/components/language-switcher'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { useJarvisCopy } from '@/i18n/jarvis'
import { openConsumerSetupReview } from '@/store/consumer-setup-review'
import { $activeGatewayProfile } from '@/store/profile'
import { canUseQuickEntry } from '@/store/quick-entry'
import { $desktopVersion, refreshDesktopVersion } from '@/store/updates'
import { useTheme } from '@/themes'
import type { ThemeMode } from '@/themes/context'

import { CONNECTIONS_ROUTE } from '../routes'
import { QuickEntrySettings } from '../settings/quick-entry-settings'

import { ConsumerApprovalSettings } from './consumer-approval-settings'
import { ConsumerBackupSettings } from './consumer-backup-settings'
import { ConsumerChatExportSettings } from './consumer-chat-export-settings'
import { ConsumerImageExportSettings } from './consumer-image-export-settings'
import { ConsumerSettingsLayout } from './settings-layout'

export function PreferencesView() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const s = useJarvisCopy()
  const { mode, setMode, setTheme, themeName } = useTheme()
  const version = useStore($desktopVersion)
  const profile = useStore($activeGatewayProfile)
  const [searchParams] = useSearchParams()
  const dataControls = searchParams.get('section') === 'data-controls'

  useEffect(() => {
    void refreshDesktopVersion()
  }, [])

  if (dataControls) {
    return (
      <ConsumerSettingsLayout section="data-controls">
        <header className="border-b border-(--ui-stroke-tertiary) pb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Data controls</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Save copies of the local data Jarvis can currently export. These are not a complete backup or a way to delete your data.
          </p>
        </header>
        <ConsumerChatExportSettings key={`chat-export-${profile}`} profile={profile} />
        <ConsumerImageExportSettings key={`image-export-${profile}`} profile={profile} />
        <ConsumerBackupSettings key={`backup-${profile}`} profile={profile} />
      </ConsumerSettingsLayout>
    )
  }

  return (
    <ConsumerSettingsLayout section="general">
      <header className="border-b border-(--ui-stroke-tertiary) pb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{s.general}</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{s.intro}</p>
      </header>
      <section className="flex flex-wrap items-center justify-between gap-4 pt-8">
        <div>
          <h2 className="text-base font-semibold">{t.language.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.language.description}</p>
        </div>
        <LanguageSwitcher />
      </section>
      <section className="mt-8 space-y-6 border-t border-(--ui-stroke-tertiary) pt-8">
        <h2 className="text-base font-semibold">{t.settings.sections.appearance}</h2>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="font-medium">{t.settings.appearance.colorMode}</h3>
          <SegmentedControl<ThemeMode>
            onChange={setMode}
            options={(['system', 'light', 'dark'] as const).map(id => ({
              id,
              label: t.settings.modeOptions[id].label
            }))}
            value={mode}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-medium">{s.theme}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{s.themeDetail}</p>
          </div>
          <Button disabled={themeName === 'jarvis'} onClick={() => setTheme('jarvis')} variant="secondary">
            {s.restore}
          </Button>
        </div>
      </section>
      {canUseQuickEntry() && (
        <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
          <h2 className="text-base font-semibold">{s.quickChat}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{s.quickChatDetail}</p>
          <QuickEntrySettings consumer />
        </section>
      )}
      <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
        <h2 className="text-base font-semibold">{s.connections}</h2>
        <p className="mb-4 mt-2 text-sm text-muted-foreground">{s.connectionsDetail}</p>
        <Button onClick={() => navigate(CONNECTIONS_ROUTE)} variant="secondary">
          {s.open}
        </Button>
      </section>
      <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
        <h2 className="text-base font-semibold">Review setup</h2>
        <p className="mb-4 mt-2 text-sm text-muted-foreground">
          Revisit Mac access and app detection. This does not reset your account, chats, or permissions.
        </p>
        <Button onClick={openConsumerSetupReview} variant="secondary">Review setup steps</Button>
      </section>
      <ConsumerApprovalSettings key={profile} profile={profile} />
      <details className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
        <summary className="cursor-pointer text-base font-semibold">{t.settings.sections.advanced}</summary>
        <p className="mb-4 mt-3 text-sm text-muted-foreground">{s.advancedDetail}</p>
        <p className="text-sm text-muted-foreground">
          Jarvis keeps provider and runtime details managed automatically in this preview.
        </p>
      </details>
      <footer className="mt-10 space-y-6 border-t border-(--ui-stroke-tertiary) pt-8">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium">{s.appVersion}</h2>
          <span className="text-sm text-muted-foreground">{version?.desktopAppVersion ?? '—'}</span>
        </div>
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">{s.local}</p>
      </footer>
    </ConsumerSettingsLayout>
  )
}
