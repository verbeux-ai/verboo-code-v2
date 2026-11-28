// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Hero } from '../src/client/Hero.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(visible: boolean, measurable: boolean) {
  const actions = {
    observeFirstUse: vi.fn(),
    dismissFirstUse: vi.fn(),
    prepareFirstProject: vi.fn<(prompt: string) => Promise<void>>().mockResolvedValue(undefined),
  }
  const props: Partial<ComponentProps<typeof Hero>> = {
    t: key => pt[key],
    useFirstUse: select => select({ visible, measurable }),
    ...actions,
  }
  return { props: props as ComponentProps<typeof Hero>, actions }
}

it('keeps the regular introduction after first use', () => {
  const { props, actions } = fixture(false, true)
  render(<Hero {...props} />)
  screen.getByRole('heading', { name: pt.homeTitle })
  expect(screen.queryByRole('button', { name: pt.firstUseOpen })).toBeNull()
  expect(actions.observeFirstUse).not.toHaveBeenCalled()
})

it('keeps setup available without measurement and waits for authorization to record the view', async () => {
  const { props, actions } = fixture(true, false)
  const view = render(<Hero {...props} />)
  expect(actions.observeFirstUse).not.toHaveBeenCalled()
  view.rerender(<Hero {...props} useFirstUse={select => select({ visible: true, measurable: true })} />)
  expect(actions.observeFirstUse).toHaveBeenCalledOnce()

  fireEvent.click(screen.getByRole('button', { name: pt.firstUseOpen }))
  await waitFor(() => expect(actions.prepareFirstProject).toHaveBeenCalledExactlyOnceWith(pt.firstUsePrompt))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: pt.firstUseOpen }).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: pt.firstUseLater }))
  expect(actions.dismissFirstUse).toHaveBeenCalledOnce()
})

it('allows a new attempt after the project could not be opened', async () => {
  const { props, actions } = fixture(true, true)
  actions.prepareFirstProject.mockRejectedValueOnce(new Error('fixture'))
  render(<Hero {...props} />)
  const open = screen.getByRole('button', { name: pt.firstUseOpen })
  fireEvent.click(open)
  expect((await screen.findByRole('status')).textContent).toBe(pt.firstUseFailed)
  fireEvent.click(open)
  await waitFor(() => expect(actions.prepareFirstProject).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('status')).toBeNull()
})
