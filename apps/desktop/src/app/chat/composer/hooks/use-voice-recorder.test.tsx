import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyError } from '@/store/notifications'

import type { MicRecording } from './use-mic-recorder'
import { useVoiceRecorder } from './use-voice-recorder'

const micHandle = {
  cancel: vi.fn(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<MicRecording | null>>()
}

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: micHandle, level: 0, recording: false })
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          noSpeechDetected: 'No speech',
          recordingFailed: 'Recording failed',
          transcriptionFailed: 'Transcription failed',
          transcriptionUnavailable: 'Unavailable',
          tryRecordingAgain: 'Try again',
          unavailable: 'Unavailable'
        }
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const recording: MicRecording = {
  audio: new Blob(['sample'], { type: 'audio/webm' }),
  durationMs: 500,
  heardSpeech: true
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

describe('useVoiceRecorder Dictate lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    micHandle.start.mockResolvedValue(undefined)
    micHandle.stop.mockResolvedValue(recording)
  })

  afterEach(cleanup)

  it('admits only one microphone start while permission is pending, then inserts editable text', async () => {
    const pendingStart = deferred<void>()
    micHandle.start.mockReturnValueOnce(pendingStart.promise)
    const onTranscript = vi.fn()
    const focusInput = vi.fn()
    const onTranscribeAudio = vi.fn(async () => '  hello  ')

    const hook = renderHook(() =>
      useVoiceRecorder({ maxRecordingSeconds: 30, onTranscribeAudio, focusInput, onTranscript })
    )

    act(() => {
      hook.result.current.dictate()
      hook.result.current.dictate()
    })
    expect(micHandle.start).toHaveBeenCalledTimes(1)
    expect(hook.result.current.voiceStatus).toBe('starting')

    await act(async () => pendingStart.resolve())
    expect(hook.result.current.voiceStatus).toBe('recording')

    act(() => hook.result.current.dictate())
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('hello'))
    expect(onTranscribeAudio).toHaveBeenCalledWith(recording.audio)
    expect(focusInput).toHaveBeenCalledTimes(1)
    expect(hook.result.current.voiceStatus).toBe('idle')
  })

  it('does not stop or transcribe twice when clicked again during a pending stop', async () => {
    const pendingStop = deferred<MicRecording | null>()
    micHandle.stop.mockReturnValueOnce(pendingStop.promise)
    const onTranscript = vi.fn()
    const onTranscribeAudio = vi.fn(async () => 'one transcript')

    const hook = renderHook(() =>
      useVoiceRecorder({
        maxRecordingSeconds: 30,
        onTranscribeAudio,
        focusInput: vi.fn(),
        onTranscript
      })
    )

    await act(async () => hook.result.current.dictate())
    act(() => {
      hook.result.current.dictate()
      hook.result.current.dictate()
    })
    expect(micHandle.stop).toHaveBeenCalledTimes(1)
    expect(hook.result.current.voiceStatus).toBe('stopping')

    await act(async () => pendingStop.resolve(recording))
    expect(onTranscribeAudio).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledTimes(1)
  })

  it('releases the start latch after failure so the user can retry', async () => {
    micHandle.start.mockRejectedValueOnce(new Error('permission denied'))

    const hook = renderHook(() =>
      useVoiceRecorder({
        maxRecordingSeconds: 30,
        onTranscribeAudio: vi.fn(async () => 'hello'),
        focusInput: vi.fn(),
        onTranscript: vi.fn()
      })
    )

    await act(async () => hook.result.current.dictate())
    expect(hook.result.current.voiceStatus).toBe('idle')
    expect(notifyError).toHaveBeenCalledTimes(1)
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Recording failed')

    await act(async () => hook.result.current.dictate())
    expect(micHandle.start).toHaveBeenCalledTimes(2)
    expect(hook.result.current.voiceStatus).toBe('recording')
  })

  it('recovers from a stop failure without leaving Dictate stuck', async () => {
    micHandle.stop.mockRejectedValueOnce(new Error('recorder stopped unexpectedly'))
    const onTranscript = vi.fn()

    const hook = renderHook(() =>
      useVoiceRecorder({
        maxRecordingSeconds: 30,
        onTranscribeAudio: vi.fn(async () => 'recovered words'),
        focusInput: vi.fn(),
        onTranscript
      })
    )

    await act(async () => hook.result.current.dictate())
    await act(async () => hook.result.current.dictate())
    expect(hook.result.current.voiceStatus).toBe('idle')
    expect(notifyError).toHaveBeenCalledTimes(1)
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Recording failed')
    expect(micHandle.cancel).toHaveBeenCalledTimes(1)

    await act(async () => hook.result.current.dictate())
    await act(async () => hook.result.current.dictate())
    expect(micHandle.start).toHaveBeenCalledTimes(2)
    expect(onTranscript).toHaveBeenCalledWith('recovered words')
  })
})
