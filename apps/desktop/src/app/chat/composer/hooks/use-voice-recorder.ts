import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'

import type { VoiceActivityState, VoiceStatus } from '../types'

import { useMicRecorder } from './use-mic-recorder'

interface VoiceRecorderOptions {
  maxRecordingSeconds: number
  onTranscribeAudio?: (audio: Blob) => Promise<string>
  focusInput: () => void
  onTranscript: (text: string) => void
}

export function useVoiceRecorder({
  maxRecordingSeconds,
  onTranscribeAudio,
  focusInput,
  onTranscript
}: VoiceRecorderOptions) {
  const { t } = useI18n()
  const voiceCopy = t.notifications.voice
  const { handle, level } = useMicRecorder(voiceCopy)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  // React state can lag a click while microphone permission or stop is pending.
  const phaseRef = useRef<'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing'>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const startedAtRef = useRef(0)
  const intervalRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)

  const clearTimers = () => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  useEffect(() => () => clearTimers(), [])

  const stop = async () => {
    if (phaseRef.current !== 'recording') {
      return
    }

    phaseRef.current = 'stopping'
    setVoiceStatus('stopping')
    clearTimers()

    let result

    try {
      result = await handle.stop()
    } catch (error) {
      // MediaRecorder.stop() can throw before its onstop cleanup runs. Release
      // the stream before returning to idle, even when no audio was captured.
      try {handle.cancel()} catch { /* Keep the original recording error. */ }
      notifyError(error, voiceCopy.recordingFailed)
    }

    if (!result || !onTranscribeAudio) {
      phaseRef.current = 'idle'
      setVoiceStatus('idle')
      focusInput()

      return
    }

    phaseRef.current = 'transcribing'
    setVoiceStatus('transcribing')

    try {
      const transcript = (await onTranscribeAudio(result.audio)).trim()

      if (!transcript) {
        notify({ kind: 'warning', title: voiceCopy.noSpeechDetected, message: voiceCopy.tryRecordingAgain })
      } else {
        onTranscript(transcript)
      }
    } catch (error) {
      notifyError(error, voiceCopy.transcriptionFailed)
    } finally {
      phaseRef.current = 'idle'
      setVoiceStatus('idle')
      focusInput()
    }
  }

  const start = async () => {
    if (phaseRef.current !== 'idle') {
      return
    }

    if (!onTranscribeAudio) {
      notify({ kind: 'warning', title: voiceCopy.unavailable, message: voiceCopy.transcriptionUnavailable })

      return
    }

    phaseRef.current = 'starting'
    setVoiceStatus('starting')

    try {
      await handle.start({
        onError: error => {
          clearTimers()
          phaseRef.current = 'idle'
          setVoiceStatus('idle')
          notifyError(error, voiceCopy.recordingFailed)
        }
      })

      if (phaseRef.current !== 'starting') {
        return
      }

      phaseRef.current = 'recording'
      startedAtRef.current = Date.now()
      setElapsedSeconds(0)
      setVoiceStatus('recording')
      intervalRef.current = window.setInterval(() => setElapsedSeconds((Date.now() - startedAtRef.current) / 1000), 250)
      const cap = Math.max(1, Math.min(Math.trunc(maxRecordingSeconds), 600))
      timeoutRef.current = window.setTimeout(() => void stop(), cap * 1000)
    } catch (error) {
      phaseRef.current = 'idle'
      setVoiceStatus('idle')
      notifyError(error, voiceCopy.recordingFailed)
    }
  }

  const dictate = () => {
    if (phaseRef.current === 'recording') {
      void stop()
    } else if (phaseRef.current === 'idle') {
      void start()
    }
  }

  const voiceActivityState: VoiceActivityState = {
    elapsedSeconds,
    level,
    status: voiceStatus
  }

  return { dictate, voiceActivityState, voiceStatus }
}
