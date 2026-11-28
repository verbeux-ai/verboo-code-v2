// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FirstUseProps } from '../src/client/contracts.ts'
import { FirstUseTour } from '../src/client/FirstUseTour.tsx'
import { pt } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fixture(visible = true, measurable = true) {
  const actions = {
    observeFirstUse: vi.fn(),
    startFirstUse: vi.fn(),
    observeFirstUseStep: vi.fn(),
    backFirstUse: vi.fn(),
    finishFirstUse: vi.fn(),
  }
  const props: FirstUseProps = {
    t: (key, args) => (pt[key as keyof typeof pt] ?? key).replace(/\{(\w+)\}/g, (token, field: string) => {
      const values = args as Record<string, string> | undefined
      return values?.[field] ?? token
    }),
    useFirstUse: select => select({ visible, measurable }),
    ...actions,
  }
  return { props, actions }
}

it('opens a skippable welcome and waits for analytics authorization to count the view', () => {
  const { props, actions } = fixture(true, false)
  const view = render(<FirstUseTour {...props} />)
  expect(screen.getByRole('dialog', { name: pt.firstUseWelcome })).toBeTruthy()
  expect(screen.getByText(pt.firstUseThanks)).toBeTruthy()
  expect(actions.observeFirstUse).not.toHaveBeenCalled()
  view.rerender(<FirstUseTour {...props} useFirstUse={select => select({ visible: true, measurable: true })} />)
  expect(actions.observeFirstUse).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseLater }))
  expect(actions.finishFirstUse).toHaveBeenCalledWith(false)
  expect(actions.startFirstUse).not.toHaveBeenCalled()
})

it('starts on request, supports stepping back, and completes only on the last step', () => {
  const { props, actions } = fixture()
  render(<FirstUseTour {...props} />)
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseStart }))
  expect(actions.startFirstUse).toHaveBeenCalledOnce()
  expect(screen.getByRole('dialog', { name: pt.firstUseProjectTitle })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseNext }))
  expect(screen.getByRole('dialog', { name: pt.firstUseModelTitle })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseBack }))
  expect(screen.getByRole('dialog', { name: pt.firstUseProjectTitle })).toBeTruthy()
  for (let step = 0; step < 4; step++) fireEvent.click(screen.getByRole('button', { name: pt.firstUseNext }))
  expect(screen.getByRole('dialog', { name: pt.firstUseToolsTitle })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseNext }))
  expect(screen.getByRole('dialog', { name: pt.connections })).toBeTruthy()
  expect(screen.getByText(pt.firstUseConnectionsBody)).toBeTruthy()
  expect(actions.finishFirstUse).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseDone }))
  expect(actions.observeFirstUseStep).toHaveBeenCalledWith('desktop_first_use_step_connections', 'started')
  expect(actions.observeFirstUseStep).toHaveBeenLastCalledWith('desktop_first_use_step_connections', 'completed')
  expect(actions.backFirstUse).toHaveBeenCalledOnce()
  expect(actions.finishFirstUse).toHaveBeenCalledExactlyOnceWith(true)
})

it('closes a running tour with Escape', () => {
  const { props, actions } = fixture()
  render(<FirstUseTour {...props} />)
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseStart }))
  fireEvent.keyDown(screen.getByRole('dialog', { name: pt.firstUseProjectTitle }), { key: 'Escape' })
  expect(actions.observeFirstUseStep).toHaveBeenLastCalledWith('desktop_first_use_step_project', 'cancelled')
  expect(actions.finishFirstUse).toHaveBeenCalledExactlyOnceWith(false)
})
