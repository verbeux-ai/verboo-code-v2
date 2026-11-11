// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { AccountCredentialRevision, AccountUserId, AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ProductSnapshot } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'
import { Onboarding } from '../src/client/Onboarding.tsx'

afterEach(cleanup)

const accountView = (
  revision: string,
  status: AccountView['status'] = 'credential-stored',
): AccountView => ({
  status,
  credentialRevision: revision as AccountCredentialRevision,
  attempt: null,
  links: { usageUrl: 'https://code.verboo.ai/dashboard', topUpUrl: 'https://code.verboo.ai/plans' },
})

function fixture(initial: Partial<ProductSnapshot> = {}) {
  let snapshot: ProductSnapshot = {
    view: accountView('revision-1'),
    profile: null,
    profilePreviouslyVerified: false,
    initialized: true,
    accountFailed: false,
    actionFailed: null,
    starting: false,
    plans: null,
    connections: null,
    plansFailed: false,
    connectionsFailed: false,
    loadingPlans: false,
    loadingConnections: false,
    busy: null,
    handoff: null,
    handoffUntil: 0,
    connectedTarget: null,
    feedback: null,
    modelFailed: false,
    initializingModel: false,
    browserBlocked: false,
    navigationFailed: false,
    authorizationIds: [],
    mcpServers: null,
    loadingMcp: false,
    mcpFailed: false,
    mcpProbe: null,
    probingMcp: false,
    mcpError: null,
    ...initial,
  }
  const retryAccount = vi.fn()
  const props = {
    useProduct: (selector: (state: ProductSnapshot) => unknown) => selector(snapshot),
    t: (key: string) => (en as Readonly<Record<string, string>>)[key] ?? key,
    retryAccount,
    start: vi.fn(),
    reopen: vi.fn(),
    cancel: vi.fn(),
    signOut: vi.fn(async () => true),
  } as unknown as ComponentProps<typeof Onboarding>
  return {
    props,
    setSnapshot: (next: Partial<ProductSnapshot>) => {
      snapshot = { ...snapshot, ...next }
    },
  }
}

it('keeps onboarding closed during a later profile refresh and preserves recovery paths', () => {
  const { props, setSnapshot } = fixture()
  const view = render(<Onboarding {...props} />)

  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Checking your account')

  setSnapshot({
    profile: { id: 'user-1' as AccountUserId, name: 'Verboo', contact: null },
    profilePreviouslyVerified: true,
  })
  view.rerender(<Onboarding {...props} />)
  expect(screen.queryByRole('dialog')).toBeNull()

  // A rotated credential invalidates the current profile while its replacement is loading.
  setSnapshot({ view: accountView('revision-2'), profile: null, accountFailed: false })
  view.rerender(<Onboarding {...props} />)
  expect(screen.queryByRole('dialog')).toBeNull()

  // A failed refresh remains actionable, even after a previous successful verification.
  setSnapshot({ accountFailed: true })
  view.rerender(<Onboarding {...props} />)
  expect(screen.getByRole('alert').textContent).toContain('couldn’t verify it')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(props.retryAccount).toHaveBeenCalledOnce()

  // A signed-out account must still get the sign-in screen.
  setSnapshot({ view: accountView('revision-2', 'signed-out'), accountFailed: false })
  view.rerender(<Onboarding {...props} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue with Verboo' })).toBeTruthy()
})
