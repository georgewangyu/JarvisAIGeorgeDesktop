// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getHermesConfigRecord = vi.fn()
const getHermesConfigDefaults = vi.fn()
const saveHermesConfig = vi.fn()

vi.mock('@/hermes', () => ({ getHermesConfigRecord, getHermesConfigDefaults, saveHermesConfig }))

const { exportSettingsConfig, restoreDefaultSettings } = await import('./data-controls')

beforeEach(() => {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:settings-export'),
    revokeObjectURL: vi.fn()
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings data controls', () => {
  it('exports the selected profile and revokes the download URL', async () => {
    getHermesConfigRecord.mockResolvedValueOnce({ model: 'selected-profile' })

    await exportSettingsConfig('coder')

    expect(getHermesConfigRecord).toHaveBeenCalledWith('coder')
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
    expect((vi.mocked(HTMLAnchorElement.prototype.click).mock.instances[0] as HTMLAnchorElement).download).toBe('jarvis-config.json')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:settings-export')
  })

  it('does not offer a download when the selected profile is denied', async () => {
    getHermesConfigRecord.mockRejectedValueOnce(new Error('profile denied'))

    await expect(exportSettingsConfig('denied')).rejects.toThrow('profile denied')

    expect(getHermesConfigRecord).toHaveBeenCalledWith('denied')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('restores defaults only to the selected profile', async () => {
    const defaults = { model: 'default-model' }
    getHermesConfigDefaults.mockResolvedValueOnce(defaults)
    saveHermesConfig.mockResolvedValueOnce({ ok: true })

    await restoreDefaultSettings('coder')

    expect(saveHermesConfig).toHaveBeenCalledWith(defaults, 'coder')
  })

  it('keeps the active-profile request shape when no override is selected', async () => {
    getHermesConfigRecord.mockResolvedValueOnce({})
    getHermesConfigDefaults.mockResolvedValueOnce({})
    saveHermesConfig.mockResolvedValueOnce({ ok: true })

    await exportSettingsConfig()
    await restoreDefaultSettings()

    expect(getHermesConfigRecord).toHaveBeenCalledWith(undefined)
    expect(saveHermesConfig).toHaveBeenCalledWith({}, undefined)
  })

  it('surfaces a backend refusal instead of reporting success', async () => {
    getHermesConfigDefaults.mockResolvedValueOnce({ model: 'default-model' })
    saveHermesConfig.mockResolvedValueOnce({ ok: false })

    await expect(restoreDefaultSettings('denied')).rejects.toThrow('refused')
    expect(saveHermesConfig).toHaveBeenCalledWith({ model: 'default-model' }, 'denied')
  })
})
