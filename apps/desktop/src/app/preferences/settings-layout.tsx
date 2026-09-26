import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useJarvisCopy } from '@/i18n/jarvis'

import { PAGE_INSET_X } from '../layout-constants'
import { CONNECTIONS_ROUTE, PREFERENCES_ROUTE } from '../routes'

interface ConsumerSettingsLayoutProps {
  section: 'general' | 'connections' | 'data-controls'
  children: ReactNode
}

export function ConsumerSettingsLayout({ section, children }: ConsumerSettingsLayoutProps) {
  const navigate = useNavigate()
  const s = useJarvisCopy()

  return (
    <div className="consumer-page flex h-full flex-col overflow-hidden bg-(--ui-chat-surface-background) pt-(--titlebar-height) md:flex-row">
      <nav
        aria-label={s.title}
        className="flex shrink-0 gap-2 overflow-x-auto border-(--ui-stroke-tertiary) p-4 md:w-52 md:flex-col md:gap-1 md:border-r md:pt-8"
      >
        <p className="mb-5 hidden px-2 text-xs font-semibold text-muted-foreground md:block">{s.title}</p>
        <Button
          aria-current={section === 'general' ? 'page' : undefined}
          className="justify-start"
          onClick={() => navigate(PREFERENCES_ROUTE)}
          variant={section === 'general' ? 'secondary' : 'ghost'}
        >
          <Codicon name="settings-gear" /> {s.general}
        </Button>
        <Button
          aria-current={section === 'connections' ? 'page' : undefined}
          className="justify-start"
          onClick={() => navigate(CONNECTIONS_ROUTE)}
          variant={section === 'connections' ? 'secondary' : 'ghost'}
        >
          <Codicon name="plug" /> {s.connectionsNav}
        </Button>
        <Button
          aria-current={section === 'data-controls' ? 'page' : undefined}
          className="justify-start"
          onClick={() => navigate(`${PREFERENCES_ROUTE}?section=data-controls`)}
          variant={section === 'data-controls' ? 'secondary' : 'ghost'}
        >
          <Codicon name="archive" /> {s.dataControls.title}
        </Button>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <main className={`mx-auto w-full max-w-3xl pb-16 pt-8 ${PAGE_INSET_X}`}>{children}</main>
      </div>
    </div>
  )
}
