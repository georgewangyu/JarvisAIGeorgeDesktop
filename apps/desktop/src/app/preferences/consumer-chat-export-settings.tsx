import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { exportConsumerChatHistory, exportConsumerLocalData } from '@/hermes'
import { $connection } from '@/store/session'

export function ConsumerChatExportSettings({ profile }: { profile: string }) {
  const connection = useStore($connection)
  const local = connection?.mode === 'local'
  const request = useRef(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [localOpen, setLocalOpen] = useState(false)
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState('')
  const [localResult, setLocalResult] = useState('')

  // An already-open save dialog must not export the previous profile after a switch.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const current = ++request.current

    setOpen(false)
    setBusy(false)
    setError('')
    setResult('')
    setLocalOpen(false)
    setLocalBusy(false)
    setLocalError('')
    setLocalResult('')

    return () => { request.current = current + 1 }
  }, [local, profile])

  async function download() {
    if (!local || busy) {return}
    const pick = window.hermesDesktop?.selectSavePath

    if (!pick) {
      setError('The Mac save dialog is unavailable. Try again.')

      return
    }

    const current = request.current

    setBusy(true)
    setError('')

    try {
      const output = await pick({
        defaultPath: 'Jarvis-chat-history.jsonl',
        filters: [{ extensions: ['jsonl'], name: 'JSON Lines' }],
        title: 'Save Jarvis chat history'
      })

      if (!output || request.current !== current) {return}
      const saved = await exportConsumerChatHistory(profile, output)

      if (request.current !== current) {return}

      if (!saved.ok) {throw new Error('Export was not completed')}
      setResult(`${saved.chats} ${saved.chats === 1 ? 'chat' : 'chats'} saved to the location you chose.`)
      setOpen(false)
    } catch {
      if (request.current === current) {setError('Could not save chat history. Choose another location and try again.')}
    } finally {
      if (request.current === current) {setBusy(false)}
    }
  }

  async function downloadLocalData() {
    if (!local || localBusy) {return}
    const pick = window.hermesDesktop?.selectSavePath

    if (!pick) {
      setLocalError('The Mac save dialog is unavailable. Try again.')

      return
    }

    const current = request.current

    setLocalBusy(true)
    setLocalError('')

    try {
      const output = await pick({
        defaultPath: 'Jarvis-local-data.zip',
        filters: [{ extensions: ['zip'], name: 'ZIP archive' }],
        title: 'Save local Jarvis data'
      })

      if (!output || request.current !== current) {return}
      const saved = await exportConsumerLocalData(profile, output)

      if (request.current !== current) {return}

      if (!saved.ok) {throw new Error('Export was not completed')}
      setLocalResult(`Local copy saved: ${saved.chats} ${saved.chats === 1 ? 'chat' : 'chats'} and ${saved.images} uploaded ${saved.images === 1 ? 'image' : 'images'}.`)
      setLocalOpen(false)
    } catch {
      if (request.current === current) {setLocalError('Could not save local data. Choose another location and try again.')}
    } finally {
      if (request.current === current) {setLocalBusy(false)}
    }
  }

  return (
    <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">Your data</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        Save a local copy of visible chats, reviewed assistant setup, and uploaded images from those chats. It can contain personal details. Credentials, routines, generated files, and other agent data are not included.
      </p>
      <Button className="mt-4" disabled={!local} onClick={() => {setLocalError(''); setLocalResult(''); setLocalOpen(true)}} variant="secondary">
        Download local Jarvis data
      </Button>
      {localResult && <p className="mt-2 text-sm" role="status">{localResult}</p>}
      <p className="mt-5 max-w-xl text-sm text-muted-foreground">Need only the conversation text? Save chat history separately.</p>
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
      <Dialog onOpenChange={setLocalOpen} open={localOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download local Jarvis data?</DialogTitle>
            <DialogDescription>
              Save visible chats, selected setup and memory notes, and verified uploaded images from this profile. The archive may contain sensitive personal information. It excludes sign-in credentials, routines, generated files, and other agent data; it is not a complete or restorable backup.
            </DialogDescription>
          </DialogHeader>
          {localError && <p className="text-sm text-destructive" role="alert">{localError}</p>}
          <DialogFooter>
            <Button disabled={localBusy} onClick={() => setLocalOpen(false)} variant="outline">Cancel</Button>
            <Button disabled={localBusy} onClick={() => void downloadLocalData()}>{localBusy ? 'Saving…' : 'Choose save location'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
