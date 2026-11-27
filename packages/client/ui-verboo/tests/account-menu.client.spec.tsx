// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AccountMenu } from '../src/client/Sidebar.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = (key: string) => (pt as Record<string, string>)[key] ?? key

it.each([true, false])('opens account navigation from the sidebar, wide=%s', (wide) => {
  const go = vi.fn()
  render(<AccountMenu name="Savas" wide={wide} selected={null} go={go} t={t} />)
  const trigger = screen.getByRole('button', { name: pt.account })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: pt.analytics }))
  expect(go).toHaveBeenCalledWith('verboo.analytics')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: pt.preferences }))
  expect(go).toHaveBeenLastCalledWith('verboo.preferences')
})

it('dismisses the account menu with Escape', () => {
  const go = vi.fn()
  render(<AccountMenu name="Savas" wide selected={null} go={go} t={t} />)
  const trigger = screen.getByRole('button', { name: pt.account })
  fireEvent.click(trigger)
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(go).not.toHaveBeenCalled()
})
