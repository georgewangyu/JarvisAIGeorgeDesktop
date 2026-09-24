import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $approvalModes } from '@/store/approval-mode'

import { ConsumerApprovalSettings } from './consumer-approval-settings'

const { requestGatewayForProfile, confirm } = vi.hoisted(() => ({
  requestGatewayForProfile: vi.fn(),
  confirm: vi.fn()
}))

vi.mock('@/store/gateway', () => ({ requestGatewayForProfile }))
vi.mock('@/store/confirm', () => ({ confirm }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $approvalModes.set({})
})

it('loads and changes the enforced approval mode for the selected profile', async () => {
  requestGatewayForProfile.mockImplementation(async (_profile, method, params) => ({
    value: method === 'config.get' ? 'manual' : params.value
  }))

  render(<ConsumerApprovalSettings profile="work" />)

  expect(await screen.findByRole('radio', { name: /Ask more often/ })).toHaveProperty('checked', true)
  expect(requestGatewayForProfile).toHaveBeenCalledWith(
    'work', 'config.get', { key: 'approvals.mode' }, undefined, undefined, { spawnPriority: 'foreground' }
  )

  fireEvent.click(screen.getByRole('radio', { name: /Balanced/ }))

  await waitFor(() => expect(screen.getByRole('radio', { name: /Balanced/ })).toHaveProperty('checked', true))
  expect(requestGatewayForProfile).toHaveBeenCalledWith(
    'work', 'config.set', { key: 'approvals.mode', value: 'smart' }, undefined, undefined,
    { spawnPriority: 'foreground' }
  )
})

it('does not silently choose a mode when the backend cannot load it, and recovers on Retry', async () => {
  requestGatewayForProfile.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ value: 'manual' })

  render(<ConsumerApprovalSettings profile="work" />)

  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load approval settings.')
  expect(screen.queryByRole('radio')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('radio', { name: /Ask more often/ })).toHaveProperty('checked', true)
})

it('requires explicit confirmation for fewer prompts and rolls back a refused write', async () => {
  requestGatewayForProfile.mockImplementation(async (_profile, method) => {
    if (method === 'config.get') {return { value: 'manual' }}
    throw new Error('denied')
  })
  confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

  render(<ConsumerApprovalSettings profile="work" />)

  const fewerPrompts = await screen.findByRole('radio', { name: /Fewer prompts/ })
  expect(screen.getByText(/some destructive terminal commands remain blocked/)).toBeTruthy()
  fireEvent.click(fewerPrompts)
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
    description: expect.stringContaining('some destructive terminal commands remain blocked')
  }))
  expect(requestGatewayForProfile).toHaveBeenCalledTimes(1)

  fireEvent.click(fewerPrompts)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Couldn’t save that choice.'))
  expect(screen.getByRole('radio', { name: /Ask more often/ })).toHaveProperty('checked', true)
  expect(requestGatewayForProfile).toHaveBeenCalledWith(
    'work', 'config.set', { key: 'approvals.mode', value: 'off' }, undefined, undefined,
    { spawnPriority: 'foreground' }
  )
})

it('expires a pending fewer-prompts confirmation across an A→B→A profile switch', async () => {
  let accept!: (value: boolean) => void
  confirm.mockImplementation(() => new Promise<boolean>(resolve => {accept = resolve}))
  requestGatewayForProfile.mockResolvedValue({ value: 'manual' })

  const view = render(<ConsumerApprovalSettings profile="work" />)
  fireEvent.click(await screen.findByRole('radio', { name: /Fewer prompts/ }))
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce())

  view.rerender(<ConsumerApprovalSettings profile="personal" />)
  expect(await screen.findByRole('radio', { name: /Ask more often/ })).toHaveProperty('checked', true)
  view.rerender(<ConsumerApprovalSettings profile="work" />)
  await waitFor(() => expect(requestGatewayForProfile.mock.calls.filter(
    ([profile, method]) => profile === 'work' && method === 'config.get'
  )).toHaveLength(2))

  await act(async () => {accept(true)})
  expect(requestGatewayForProfile).not.toHaveBeenCalledWith(
    'work', 'config.set', { key: 'approvals.mode', value: 'off' }, undefined, undefined,
    { spawnPriority: 'foreground' }
  )
  expect(requestGatewayForProfile).not.toHaveBeenCalledWith(
    'personal', 'config.set', { key: 'approvals.mode', value: 'off' }, undefined, undefined,
    { spawnPriority: 'foreground' }
  )
})
