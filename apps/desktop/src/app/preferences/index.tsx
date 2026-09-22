import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { useJarvisCopy } from '@/i18n/jarvis'
import { canUseQuickEntry } from '@/store/quick-entry'
import { useTheme } from '@/themes'
import type { ThemeMode } from '@/themes/context'

import { CONNECTIONS_ROUTE } from '../routes'
import { QuickEntrySettings } from '../settings/quick-entry-settings'

import { ConsumerSettingsLayout } from './settings-layout'

export function PreferencesView() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const s = useJarvisCopy()
  const { mode, setMode, setTheme, themeName } = useTheme()

  return (
    <ConsumerSettingsLayout section="general">
      <h1 className="text-2xl font-semibold tracking-tight">{s.general}</h1>
      <section className="mt-10 space-y-5">
        <h2 className="text-base font-semibold">{t.settings.sections.appearance}</h2>
        <SegmentedControl<ThemeMode>
          onChange={setMode}
          options={(['system', 'light', 'dark'] as const).map(id => ({
            id,
            label: t.settings.modeOptions[id].label
          }))}
          value={mode}
        />
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
      <details className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
        <summary className="cursor-pointer text-base font-semibold">{t.settings.sections.advanced}</summary>
        <p className="mb-4 mt-3 text-sm text-muted-foreground">{s.advancedDetail}</p>
        <p className="text-sm text-muted-foreground">
          Jarvis keeps provider, safety, and runtime details managed automatically in this preview.
        </p>
      </details>
      <p className="mt-12 text-xs leading-5 text-muted-foreground">{s.local}</p>
    </ConsumerSettingsLayout>
  )
}
