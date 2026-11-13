// @vitest-environment jsdom
/**
 * The [OI] sign-in dialog: one step at a time, a refusal reported in place, and
 * a signed-in state that offers the way out again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OpenAiSignIn } from '../src/client/OpenAiSignIn.tsx'
import type { OpenAiSignInActions } from '../src/client/OpenAiSignIn.tsx'
import { en, pt } from '../src/client/locales.ts'

afterEach(cleanup)

/** Resolve a dictionary key, substituting the tokens a caller passes. */
const copy = (dictionary: Readonly<Record<string, string>>) =>
  (key: string): string => dictionary[key] ?? key

/** The actions a dialog drives, each a spy the test can inspect. */
function actions(overrides: Partial<OpenAiSignInActions> = {}): OpenAiSignInActions {
  return {
    begin: vi.fn(async () => ({ url: 'https://auth.openai.com/oauth/authorize?x=1', handle: 'handle-1' })),
    complete: vi.fn(async () => true),
    signOut: vi.fn(async () => undefined),
    close: vi.fn(),
    ...overrides,
  }
}

describe('[OI] sign-in dialog', () => {
  it('renders nothing while it is closed', () => {
    const { container } = render(
      <OpenAiSignIn status={{ signedIn: false }} actions={actions()} open={false} t={copy(en)} />,
    )
    expect(container.textContent).toBe('')
  })

  it('opens the provider page and only then asks for the code', () => {
    const driven = actions()
    render(<OpenAiSignIn status={{ signedIn: false }} actions={driven} open t={copy(en)} />)
    // The code field belongs to the second step; asking for it before the page
    // opened would strand a reader who has nothing to paste.
    expect(screen.queryByLabelText('Authorization code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }))
    return vi.waitFor(() => {
      expect(driven.begin).toHaveBeenCalledTimes(1)
      expect(screen.getByLabelText('Authorization code')).toBeTruthy()
    })
  })

  it('reports a failed start in place instead of advancing', async () => {
    const driven = actions({ begin: vi.fn(async () => undefined) })
    render(<OpenAiSignIn status={{ signedIn: false }} actions={driven} open t={copy(en)} />)
    fireEvent.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }))
    await vi.waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.queryByLabelText('Authorization code')).toBeNull()
  })

  it('keeps the finish control disabled until a code is present', async () => {
    const driven = actions()
    render(<OpenAiSignIn status={{ signedIn: false }} actions={driven} open t={copy(en)} />)
    fireEvent.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }))
    const finish = await screen.findByRole('button', { name: 'Finish sign-in' })
    expect((finish as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Authorization code'), { target: { value: 'abc123' } })
    expect((finish as HTMLButtonElement).disabled).toBe(false)
  })

  it('closes once the exchange stores a session, and presents the handle it was given', async () => {
    const driven = actions()
    render(<OpenAiSignIn status={{ signedIn: false }} actions={driven} open t={copy(en)} />)
    fireEvent.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }))
    fireEvent.change(await screen.findByLabelText('Authorization code'), { target: { value: '  abc123  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }))
    await vi.waitFor(() => {
      // The pasted code is trimmed: a copied code carries stray whitespace.
      expect(driven.complete).toHaveBeenCalledWith('handle-1', 'abc123')
      expect(driven.close).toHaveBeenCalledTimes(1)
    })
  })

  it('reports a rejected exchange and stays open for another attempt', async () => {
    const driven = actions({ complete: vi.fn(async () => false) })
    render(<OpenAiSignIn status={{ signedIn: false }} actions={driven} open t={copy(en)} />)
    fireEvent.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }))
    fireEvent.change(await screen.findByLabelText('Authorization code'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }))
    await vi.waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(driven.close).not.toHaveBeenCalled()
  })

  it('names the stored plan and offers the way out when a session exists', () => {
    const driven = actions()
    render(
      <OpenAiSignIn
        status={{ signedIn: true, planType: 'team', activeUntil: '2027-03-12T00:00:00+00:00' }}
        actions={driven} open t={copy(en)}
      />,
    )
    expect(screen.getByText(/team/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    return vi.waitFor(() => { expect(driven.signOut).toHaveBeenCalledTimes(1) })
  })

  it('never renders a token, only the plan it belongs to', () => {
    const { container } = render(
      <OpenAiSignIn
        status={{ signedIn: true, planType: 'team' }}
        actions={actions()} open t={copy(en)}
      />,
    )
    const text = container.textContent ?? ''
    for (const secret of ['access-token', 'refresh-token', 'Bearer']) expect(text).not.toContain(secret)
  })

  it('localizes both steps in Portuguese', () => {
    render(<OpenAiSignIn status={{ signedIn: false }} actions={actions()} open t={copy(pt)} />)
    expect(screen.getByText(/Use os modelos GPT/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Entrar com ChatGPT/ })).toBeTruthy()
  })
})
