// @vitest-environment jsdom
/**
 * The [OI] subscription is an account a reader connects, so its entry lives with
 * the connected accounts and opens the sign-in dialog from there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ProductSnapshot } from '../src/client/model.ts'
import { ConnectionsPage } from '../src/client/Connections.tsx'
import { en, pt } from '../src/client/locales.ts'

afterEach(cleanup)

/** Mount the page with one external session state and every read settled. */
function page(signedIn: boolean, dictionary: Readonly<Record<string, string>> = en) {
  const openOpenAiDialog = vi.fn()
  // The page reads one product snapshot; an empty catalog keeps this fixture
  // about the subscription section rather than about the catalog.
  const state = {
    view: null, profile: null, profilePreviouslyVerified: false, initialized: true,
    accountFailed: false, actionFailed: null, starting: false, plans: null,
    connections: { toolkits: [], accounts: [] },
    plansFailed: false, connectionsFailed: false, loadingPlans: false, loadingConnections: false,
    busy: null, handoff: null, handoffUntil: 0, connectedTarget: null, feedback: null,
    modelFailed: false, initializingModel: false, browserBlocked: false, navigationFailed: false,
    authorizationIds: [], mcpServers: [], loadingMcp: false, mcpFailed: false,
    mcpProbe: null, probingMcp: false, mcpError: null,
  } satisfies Partial<ProductSnapshot> as ProductSnapshot
  const props = {
    useProduct: (selector: (snapshot: ProductSnapshot) => unknown) => selector(state),
    usePreferences: (selector: (snapshot: unknown) => unknown) =>
      selector({ locale: 'en', theme: 'system', languages: [] }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
    useExternalStatus: (selector: (snapshot: unknown) => unknown) => selector({ signedIn, planType: 'team' }),
    t: (key: string, values?: Record<string, unknown>) => {
      const copy = dictionary[key] ?? key
      if (values === undefined) return copy
      return copy.replace(/\{(\w+)\}/g, (match, name: string) =>
        typeof values[name] === 'string' ? values[name] : match)
    },
    loadConnections: vi.fn(), loadMcpServers: vi.fn(), saveMcpServer: vi.fn(async () => true),
    deleteMcpServer: vi.fn(async () => true), setMcpEnabled: vi.fn(async () => true),
    probeMcpServer: vi.fn(async () => true), clearMcpProbe: vi.fn(),
    connect: vi.fn(async () => true), disconnect: vi.fn(async () => true),
    reopenConnection: vi.fn(), dismiss: vi.fn(), openOpenAiDialog,
  } as ComponentProps<typeof ConnectionsPage>
  render(<ConnectionsPage {...props} />)
  return { openOpenAiDialog }
}

describe('[OI] subscription on the connections page', () => {
  it('shows its own section beside the connected accounts', () => {
    page(false)
    expect(screen.getByText('External subscriptions')).toBeTruthy()
    expect(screen.getByText('Use the GPT models your ChatGPT plan includes.')).toBeTruthy()
  })

  it('offers the connect action while no session is stored', () => {
    const { openOpenAiDialog } = page(false)
    expect(screen.getByText('Not connected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(openOpenAiDialog).toHaveBeenCalledTimes(1)
  })

  it('reports the plan and offers management once a session exists', () => {
    page(true)
    expect(screen.getByText('ChatGPT team')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
  })

  it('localizes the section in Portuguese', () => {
    page(false, pt)
    expect(screen.getByText('Assinaturas externas')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Conectar' })).toBeTruthy()
  })
})
