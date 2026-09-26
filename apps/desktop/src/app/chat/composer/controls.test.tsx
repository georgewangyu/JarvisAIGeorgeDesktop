import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { I18nProvider } from '@/i18n'
import { $hudMode } from '@/store/hud'
import { applyWakeStartResult, applyWakeStatus, resetWakeWordState } from '@/store/wake-word'

import { ComposerControls } from './controls'

vi.mock('./model-pill', () => ({ ModelPill: () => <button type="button">Choose model</button> }))
vi.mock('./voice-engine-rows', () => ({ useVoiceEngineName: () => 'Test engine', VoiceEngineRows: () => <div>Technical voice engines</div> }))

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { active: false, enabled: false }
}

function renderControls(overrides: Partial<React.ComponentProps<typeof ComposerControls>> = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ComposerControls
        autoSpeak={false}
        busy={false}
        busyAction="stop"
        canSubmit={true}
        conversation={{
          active: false,
          level: 0,
          muted: false,
          onEnd: vi.fn(),
          onStart: vi.fn(),
          onStopTurn: vi.fn(),
          onToggleMute: vi.fn(),
          status: 'idle'
        }}
        disabled={false}
        hasComposerPayload={true}
        onDictate={vi.fn()}
        onQueue={vi.fn()}
        onToggleAutoSpeak={vi.fn()}
        state={state}
        voiceStatus="idle"
        {...overrides}
      />
    </I18nProvider>
  )
}

async function expectShortcutTooltip(label: string, shortcut: string) {
  fireEvent.pointerMove(screen.getByLabelText(label), { pointerType: 'mouse' })

  const tooltip = await screen.findByRole('tooltip')

  expect(tooltip.textContent).toContain(label)
  expect(tooltip.textContent).toContain(shortcut)
}

afterEach(() => {
  cleanup()
  $hudMode.set(false)
})

// The HUD is a Spotlight bar a few hundred pixels wide: the voice controls
// fold into one menu there, and the way out of HUD mode joins the row instead
// of floating above the bar in a reserved strip. The docked composer keeps the
// mic inline, with the other voice toggles fanned out of it on hover, and
// shows no exit.
describe('HUD mode', () => {
  it('keeps the mic inline, fans the toggles on hover, and offers no exit in the docked composer', async () => {
    renderControls()

    const mic = screen.getByLabelText('Voice dictation')

    expect(mic).toBeTruthy()
    expect(screen.queryByLabelText('Read replies aloud')).toBeNull()

    fireEvent.pointerEnter(mic.parentElement!)

    expect(await screen.findByLabelText('Read replies aloud')).toBeTruthy()
    expect(screen.getByLabelText('Wake word "hey hermes"')).toBeTruthy()
    expect(screen.queryByLabelText('Exit HUD mode')).toBeNull()
    expect(screen.queryByLabelText('Reset HUD size and position')).toBeNull()
    // No folded menu trigger — the fan's group shares the "Voice" name.
    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull()
  })

  it('folds them into one menu and offers the way out in the HUD', () => {
    $hudMode.set(true)
    renderControls()

    expect(screen.getByLabelText('Voice')).toBeTruthy()
    expect(screen.getByLabelText('Reset HUD size and position')).toBeTruthy()
    expect(screen.getByLabelText('Exit HUD mode')).toBeTruthy()

    // Folded away, not duplicated — the whole point is the row's width back.
    expect(screen.queryByLabelText('Voice dictation')).toBeNull()
    expect(screen.queryByLabelText('Read replies aloud')).toBeNull()
  })

  // A collapsed menu that looked idle while the mic was open would be a worse
  // trade than the space it saves, so the trigger reports the live state.
  it('reports a live voice state on the collapsed trigger', () => {
    $hudMode.set(true)
    renderControls({ voiceStatus: 'recording' })

    expect(screen.getByLabelText('Stop dictation')).toBeTruthy()
    expect(screen.queryByLabelText('Voice')).toBeNull()
  })

  it('reports microphone opening and finishing rather than appearing idle', () => {
    $hudMode.set(true)
    const view = renderControls({ voiceStatus: 'starting' })

    expect(screen.getByLabelText('Opening microphone')).toBeTruthy()
    view.unmount()
    renderControls({ voiceStatus: 'stopping' })
    expect(screen.getByLabelText('Finishing recording')).toBeTruthy()
  })
})

// A tile can be narrower than the controls cost, and the row is inside an
// overflow-hidden surface — so anything that doesn't fold gets clipped off the
// right edge, send button first. The ladder keeps going past `stacked`: voice
// folds into the same menu the HUD uses, then the model pill drops. Send is
// the last thing standing.
describe('narrow tiles', () => {
  it('folds the voice controls into one menu without entering HUD mode', () => {
    renderControls({ foldVoice: true })

    expect(screen.getByLabelText('Voice')).toBeTruthy()
    expect(screen.queryByLabelText('Voice dictation')).toBeNull()
    expect(screen.queryByLabelText('Read replies aloud')).toBeNull()

    // Folding is a width decision, not the HUD: no exit affordance appears.
    expect(screen.queryByLabelText('Exit HUD mode')).toBeNull()
  })

  it('keeps Send at the tightest width, with everything else dropped', () => {
    renderControls({ foldVoice: true, minimal: true })

    expect(screen.getByLabelText('Send')).toBeTruthy()
    expect(screen.queryByLabelText('Voice')).toBeNull()
  })

  it('keeps Stop reachable mid-turn at the tightest width', () => {
    renderControls({ busy: true, busyAction: 'stop', foldVoice: true, hasComposerPayload: false, minimal: true })

    expect(screen.getByLabelText('Stop')).toBeTruthy()
  })
})

describe('consumer composer', () => {
  it('starts and stops dictation directly while keeping advanced voice settings separate', () => {
    const onDictate = vi.fn()
    const enabledState = { ...state, voice: { active: false, enabled: true } }
    const view = renderControls({ consumer: true, onDictate, state: enabledState })

    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    expect(onDictate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Voice' })).toBeTruthy()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <ComposerControls
          autoSpeak={false}
          busy={false}
          busyAction="stop"
          canSubmit={true}
          consumer={true}
          conversation={{ active: false, level: 0, muted: false, onEnd: vi.fn(), onStart: vi.fn(), onStopTurn: vi.fn(), onToggleMute: vi.fn(), status: 'idle' }}
          disabled={false}
          hasComposerPayload={true}
          onDictate={onDictate}
          onQueue={vi.fn()}
          onToggleAutoSpeak={vi.fn()}
          state={{ ...enabledState, voice: { active: true, enabled: true } }}
          voiceStatus="recording"
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    expect(onDictate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Voice' })).toBeTruthy()
  })

  it('reports dictation transitions and prevents another click during a pending phase', () => {
    const onDictate = vi.fn()
    renderControls({ consumer: true, onDictate, state: { ...state, voice: { active: true, enabled: true } }, voiceStatus: 'starting' })
    const button = screen.getByRole('button', { name: 'Opening microphone' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onDictate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Voice' })).toBeTruthy()
  })

  it('keeps the primary voice action without the extra engine dropdown', () => {
    renderControls({ consumer: true, hasComposerPayload: false })
    expect(screen.getByLabelText('Start voice conversation')).toBeTruthy()
    expect(screen.queryByLabelText('Voice chat engine')).toBeNull()
  })

  it('keeps backend voice engines out of the consumer voice menu', async () => {
    renderControls({ consumer: true })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Voice' }), { button: 0, ctrlKey: false })

    expect(await screen.findByRole('menu', { name: 'Voice' })).toBeTruthy()
    expect(screen.queryByText('Technical voice engines')).toBeNull()
    expect(screen.getByText('Read replies aloud')).toBeTruthy()
  })

  it('does not put backend wake-word diagnostics in the consumer tooltip', async () => {
    applyWakeStartResult({ hint: 'run a local installer at /private/path', reason: 'unavailable', started: false })

    try {
      renderControls({ consumer: true })
      fireEvent.pointerMove(screen.getByRole('button', { name: 'Voice' }), { pointerType: 'mouse' })

      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip.textContent).toContain('Check microphone access and try again.')
      expect(tooltip.textContent).not.toContain('/private/path')
    } finally {
      resetWakeWordState()
    }
  })

  it('opens options for its own keyboard target, not another pane', () => {
    renderControls({ consumer: true })
    fireEvent(window, new CustomEvent('hermes:composer-model-menu', { detail: { target: 'tile:other' } }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent(window, new CustomEvent('hermes:composer-model-menu', { detail: { target: 'main' } }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('discloses model controls on demand while keeping send and voice reachable', async () => {
    renderControls({ consumer: true })

    expect(screen.queryByRole('button', { name: 'Choose model' })).toBeNull()
    expect(screen.getByLabelText('Send')).toBeTruthy()
    expect(screen.getByLabelText('Voice')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))
    expect(await screen.findByRole('button', { name: 'Choose model' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Choose model' })).toBeNull()
  })

  it('honors guided-chat hiding and preserves live dictation status', () => {
    renderControls({ consumer: true, hideModelPill: true, voiceStatus: 'recording' })

    expect(screen.queryByRole('button', { name: 'Chat options' })).toBeNull()
    expect(screen.getByLabelText('Stop dictation')).toBeTruthy()
  })
})

describe('ComposerControls shortcut tooltips', () => {
  it('shows Enter for Send', async () => {
    renderControls()

    await expectShortcutTooltip('Send', '↵')
  })

  it('keeps Send (not Steer) while a turn is running if there is a payload', async () => {
    renderControls({ busy: true, busyAction: 'steer' })

    await expectShortcutTooltip('Send', '↵')
  })

  it('shows Stop only when the composer is empty mid-turn', async () => {
    renderControls({ busy: true, busyAction: 'stop', canSubmit: true, hasComposerPayload: false })

    await expectShortcutTooltip('Stop', '↵')
  })

  it('shows Ctrl+Enter for Queue as the secondary mid-turn action', async () => {
    renderControls({ busy: true, busyAction: 'queue' })

    await expectShortcutTooltip('Queue message', 'Ctrl+↵')
  })
})

describe('wake-word ear visibility', () => {
  afterEach(() => {
    resetWakeWordState()
  })

  // The ear lives in the mic's fan now: hover the mic to reach it.
  const findEar = async () => {
    fireEvent.pointerEnter(screen.getByLabelText('Voice dictation').parentElement!)

    return screen.findByLabelText('Wake word "hey hermes"')
  }

  it('stays reachable during a busy agent turn', async () => {
    applyWakeStatus({ available: true, enabled: true, listening: true, phrase: 'hey hermes' })
    renderControls({ busy: true, busyAction: 'stop' })

    expect((await findEar()).getAttribute('aria-pressed')).toBe('true')
  })

  it('stays reachable (enabled in config) even when a start was refused', async () => {
    applyWakeStatus({ available: true, enabled: true, listening: false, phrase: 'hey hermes' })
    // Transient refusal marks available false but enabled keeps it mounted.
    applyWakeStartResult({ hint: 'mic busy', reason: 'unavailable', started: false })
    renderControls()

    expect((await findEar()).getAttribute('aria-pressed')).toBe('false')
  })

  it('stays reachable (never hides) even when unavailable and not enabled', async () => {
    applyWakeStatus({ available: false, enabled: false, listening: false, phrase: 'hey hermes' })
    applyWakeStartResult({ hint: 'run `hermes tools` (Voice section)', reason: 'unavailable', started: false })
    renderControls()

    // The ear ALWAYS shows so the user can click to enable; a refused start
    // never hides the control.
    expect(((await findEar()) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a disabled paused ear inside the voice-conversation pill', () => {
    applyWakeStatus({ available: true, enabled: true, listening: true, phrase: 'hey hermes' })
    renderControls({
      conversation: {
        active: true,
        level: 0,
        muted: false,
        onEnd: vi.fn(),
        onStart: vi.fn(),
        onStopTurn: vi.fn(),
        onToggleMute: vi.fn(),
        status: 'listening'
      }
    })

    const ear = screen.getByLabelText('Wake word: "hey hermes" — paused during voice chat')
    expect((ear as HTMLButtonElement).disabled).toBe(true)
  })
})
