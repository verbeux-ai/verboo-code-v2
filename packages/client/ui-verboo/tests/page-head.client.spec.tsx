// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PageHead } from '../src/client/PageParts.tsx'

afterEach(cleanup)

it('offers an accessible close action when the page provides one', () => {
  const onClose = vi.fn()
  render(<PageHead title="Preferências" description="Conta" t={key => key === 'close' ? 'Fechar' : key} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
  expect(onClose).toHaveBeenCalledOnce()
})
