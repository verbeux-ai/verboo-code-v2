// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QuitConfirmation } from '../src/client/QuitHold.tsx'
import { pt } from '../src/client/locales.ts'
import type { ProductProps } from '../src/client/contracts.ts'

const t = ((key: keyof typeof pt) => pt[key]) as ProductProps['t']
afterEach(() => { cleanup(); globalThis.__VERBOO_QUIT_CONFIRMATION__ = undefined })

it('shows the Boo dialog and returns explicit cancel and exit decisions', async () => {
  let notify: () => void = () => {}
  const respond = vi.fn().mockResolvedValue(undefined)
  globalThis.__VERBOO_QUIT_CONFIRMATION__ = { subscribe: (listener) => { notify = listener; return () => {} }, respond }
  render(<QuitConfirmation t={t} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  notify()
  const dialog = await screen.findByRole('dialog', { name: 'Sair do Verboo Code?' })
  expect(dialog.querySelector('img')).not.toBeNull()
  expect(dialog.textContent).toContain('serão interrompidas')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar trabalhando' }))
  await waitFor(() => { expect(respond).toHaveBeenCalledWith(false) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  notify()
  const next = await screen.findByRole('dialog', { name: 'Sair do Verboo Code?' })
  fireEvent.click(within(next).getByRole('button', { name: 'Sair mesmo assim' }))
  await waitFor(() => { expect(respond).toHaveBeenCalledWith(true) })
})
