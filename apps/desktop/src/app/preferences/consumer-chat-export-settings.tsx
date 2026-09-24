import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { exportConsumerChatHistory } from '@/hermes'
import { $connection } from '@/store/session'

export function ConsumerChatExportSettings({ profile }: { profile: string }) {
  const connection = useStore($connection)
  const local = connection?.mode === 'local'
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')

  async function download() {
    if (!local || busy) {return}
    const pick = window.hermesDesktop?.selectSavePath

    if (!pick) {
      setError('The Mac save dialog is unavailable. Try again.')

      return
    }

    setBusy(true)
    setError('')

    try {
      const output = await pick({
        defaultPath: 'Jarvis-chat-history.jsonl',
        filters: [{ extensions: ['jsonl'], name: 'JSON Lines' }],
        title: 'Save Jarvis chat history'
      })

      if (!output) {return}
      const saved = await exportConsumerChatHistory(profile, output)

      if (!saved.ok) {throw new Error('Export was not completed')}
      setResult(`${saved.chats} ${saved.chats === 1 ? 'chat' : 'chats'} saved to the location you chose.`)
      setOpen(false)
    } catch {
      setError('Could not save chat history. Choose another location and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">Your data</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        Download visible Jarvis conversations from this Mac. This export includes chat text, which may contain personal details. It does not include files, credentials, or other agent data.
      </p>
      <Button className="mt-4" disabled={!local} onClick={() => {setError(''); setResult(''); setOpen(true)}} variant="secondary">
        Download chat history
      </Button>
      {!local && <p className="mt-2 text-xs text-muted-foreground">Available when Jarvis is running on this Mac.</p>}
      {result && <p className="mt-2 text-sm" role="status">{result}</p>}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download chat history?</DialogTitle>
            <DialogDescription>Save a local copy of visible Jarvis chats from this profile. The file may contain sensitive conversation text. It does not include files or sign-in credentials.</DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(false)} variant="outline">Cancel</Button>
            <Button disabled={busy} onClick={() => void download()}>{busy ? 'Saving…' : 'Choose save location'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
