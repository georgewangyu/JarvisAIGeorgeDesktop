import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useJarvisCopy } from '@/i18n/jarvis'
import { runExportProfileFlow } from '@/store/profile-share'
import { $connection } from '@/store/session'

export function ConsumerBackupSettings({ profile }: { profile: string }) {
  const s = useJarvisCopy().backupExport
  const connection = useStore($connection)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const local = connection?.mode === 'local'
  const request = useRef(0)

  // Retire a pending native save dialog when its owning profile changes.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const current = ++request.current

    setSaving(false)
    setError('')
    setResult('')

    return () => { request.current = current + 1 }
  }, [local, profile])

  const save = async () => {
    if (saving || !local) {
      return
    }

    if (!window.hermesDesktop?.selectSavePath) {
      setError(s.saveUnavailable)

      return
    }

    const current = request.current

    setSaving(true)
    setError('')
    setResult('')

    try {
      const archive = await runExportProfileFlow(profile, { consumer: true, shouldContinue: () => request.current === current })

      if (archive && request.current === current) {
        setResult(s.saved)
      }
    } catch {
      if (request.current === current) {setError(s.saveError)}
    } finally {
      if (request.current === current) {setSaving(false)}
    }
  }

  return (
    <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">{s.title}</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        {s.detail}
      </p>
      <Button className="mt-4" disabled={!local || saving} onClick={() => void save()} variant="secondary">
        {saving ? s.saving : s.save}
      </Button>
      {!local && <p className="mt-2 text-xs text-muted-foreground">{s.localOnly}</p>}
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      {result && <p className="mt-2 text-sm" role="status">{result}</p>}
    </section>
  )
}
