import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { runExportProfileFlow } from '@/store/profile-share'
import { $connection } from '@/store/session'

export function ConsumerBackupSettings({ profile }: { profile: string }) {
  const connection = useStore($connection)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const local = connection?.mode === 'local'

  const save = async () => {
    if (saving || !local) {
      return
    }

    setSaving(true)
    setError(false)

    try {
      await runExportProfileFlow(profile, { consumer: true })
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">Back up assistant setup</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        Save settings, routines, skills, and memories. The file may contain personal details; chats and sign-in credentials aren’t included.
      </p>
      <Button className="mt-4" disabled={!local || saving} onClick={() => void save()} variant="secondary">
        {saving ? 'Saving…' : 'Save setup backup'}
      </Button>
      {!local && <p className="mt-2 text-xs text-muted-foreground">Available when Jarvis is running on this Mac.</p>}
      {error && <p className="mt-2 text-sm text-destructive" role="alert">Couldn’t open the save dialog. Try again.</p>}
    </section>
  )
}
