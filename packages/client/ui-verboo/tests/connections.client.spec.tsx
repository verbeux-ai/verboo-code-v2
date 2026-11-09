// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Connection, Connections, ConnectionId, Toolkit } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { CustomMcpServerView, McpServerProbe } from '@deepseek-ai/dsh-api-verboo-mcp/types'
import type { ProductSnapshot } from '../src/client/model.ts'
import { ConnectionsPage } from '../src/client/Connections.tsx'
import { en, pt, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const toolkit = (slug: string, name: string, available = true, authType: Toolkit['authType'] = 'oauth'): Toolkit => ({
  slug, name, available, authType,
})
const account = (id: string, toolkitSlug: string, label: string, status: Connection['status'] = 'connected'): Connection => ({
  id: id as ConnectionId, toolkit: toolkitSlug, label, status,
})
const server = (overrides: Partial<CustomMcpServerView> = {}): CustomMcpServerView => ({
  name: 'docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headerNames: ['Authorization'],
  command: '',
  args: [],
  envNames: [],
  enabled: true,
  credentialRefs: ['VERBOO_MCP_DOCS_AUTHORIZATION'],
  createdAt: '2026-11-05T12:00:00Z',
  updatedAt: '2026-11-05T12:00:00Z',
  status: { state: 'connected', toolCount: 3, lastError: '', missing: [] },
  ...overrides,
})

function fixture(locale: 'pt' | 'en' | 'zh' = 'pt', overrides: Partial<ProductSnapshot> = {}) {
  const connections: Connections = {
    available: true,
    toolkits: [
      toolkit('github', 'GitHub'),
      toolkit('slack', 'Slack'),
      toolkit('notion', 'Notion'),
      toolkit('public_searxng', 'SearXNG', true, 'none'),
    ],
    accounts: [account('connection-1', 'github', 'Work')],
  }
  const state: ProductSnapshot = {
    view: null,
    profile: null,
    initialized: true,
    accountFailed: false,
    actionFailed: null,
    starting: false,
    plans: null,
    connections,
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
    mcpServers: [server()],
    loadingMcp: false,
    mcpFailed: false,
    mcpProbe: null,
    probingMcp: false,
    mcpError: null,
    ...overrides,
  }
  const copy: Readonly<Record<string, string>> = locale === 'pt' ? pt : locale === 'zh' ? zh : en
  const props: ComponentProps<typeof ConnectionsPage> = {
    useProduct: (selector: (snapshot: ProductSnapshot) => unknown) => selector(state),
    usePreferences: (
      selector: (snapshot: { locale: string; theme: string; languages: readonly { id: string; label: string }[] }) => unknown,
    ) => selector({ locale, theme: 'system', languages: [] }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
    t: (key: string, values?: Record<string, unknown>) => (copy[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => {
      const value = values?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    }),
    loadConnections: vi.fn(),
    loadMcpServers: vi.fn(),
    saveMcpServer: vi.fn(async () => true),
    deleteMcpServer: vi.fn(async () => true),
    setMcpEnabled: vi.fn(async () => true),
    probeMcpServer: vi.fn(async () => true),
    clearMcpProbe: vi.fn(),
    connect: vi.fn(async () => true),
    disconnect: vi.fn(async () => true),
    reopenConnection: vi.fn(),
    dismiss: vi.fn(),
  } as unknown as ComponentProps<typeof ConnectionsPage>
  return { props, state }
}

describe('connections page structure', () => {
  it('separates owned accounts, MCP servers and the catalog', () => {
    const { props } = fixture()
    const view = render(<ConnectionsPage {...props} />)
    expect(view.container.querySelector('[data-verboo-page="connections"]')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Conexões' })).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Servidores MCP/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'docs' })).toBeTruthy()
  })

  it('hides the catalog items until a category is chosen', () => {
    const { props, state } = fixture()
    state.connections!.toolkits.push(toolkit('figma', 'Figma'), toolkit('stripe', 'Stripe'))
    render(<ConnectionsPage {...props} />)
    // Nothing is listed before a choice: only the category entries are offered.
    expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Figma' })).toBeNull()
    expect(screen.getByText('Escolha uma categoria para ver os serviços.')).toBeTruthy()
    const categories = screen.getByRole('group', { name: 'Filtrar por categoria' })
    expect(within(categories).getByRole('button', { name: /Desenvolvimento/ })).toBeTruthy()
    expect(within(categories).getByRole('button', { name: /Design/ })).toBeTruthy()
  })

  it('reveals one category at a time and returns to the category list', () => {
    const { props, state } = fixture()
    state.connections!.toolkits.push(toolkit('figma', 'Figma'), toolkit('stripe', 'Stripe'))
    render(<ConnectionsPage {...props} />)
    const categories = screen.getByRole('group', { name: 'Filtrar por categoria' })
    fireEvent.click(within(categories).getByRole('button', { name: /Desenvolvimento/ }))
    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Figma' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Stripe' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Todas as categorias/ }))
    expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull()
    expect(screen.getByText('Escolha uma categoria para ver os serviços.')).toBeTruthy()
    const reopened = screen.getByRole('group', { name: 'Filtrar por categoria' })
    fireEvent.click(within(reopened).getByRole('button', { name: /Design/ }))
    expect(screen.getByRole('heading', { name: 'Figma' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull()
  })

  it('searches across every category even while none is selected', () => {
    const { props, state } = fixture()
    state.connections!.toolkits.push(toolkit('figma', 'Figma'))
    render(<ConnectionsPage {...props} />)
    fireEvent.change(screen.getByLabelText('Buscar um serviço'), { target: { value: 'fig' } })
    expect(screen.getByRole('heading', { name: 'Figma' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull()
    expect(screen.getByText('1 resultado')).toBeTruthy()
  })

  it('reports an empty MCP section with an actionable next step', () => {
    const { props } = fixture('pt', { mcpServers: [] })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText(/Nenhum servidor MCP/)).toBeTruthy()
  })

  it('keeps a failed MCP read distinguishable from an empty one', () => {
    const { props } = fixture('pt', { mcpServers: null, mcpFailed: true })
    render(<ConnectionsPage {...props} />)
    expect(screen.queryByText(/Nenhum servidor MCP/)).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('shows missing credential references on the server card', () => {
    const { props } = fixture('pt', {
      mcpServers: [server({ status: { state: 'waiting-credentials', toolCount: 0, lastError: '', missing: ['VERBOO_MCP_DOCS_AUTHORIZATION'] } })],
    })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText(/VERBOO_MCP_DOCS_AUTHORIZATION/)).toBeTruthy()
  })
})

describe('mcp server editing', () => {
  it('opens the create dialog, validates the name and saves a valid definition', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar servidor MCP/ }))
    const dialog = screen.getByRole('dialog')
    const save = within(dialog).getByRole('button', { name: 'Salvar' })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'new server' } })
    expect(within(dialog).getByText(/nome/i)).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/mcp' } })
    await Promise.resolve()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Salvar' }).disabled).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => {
      expect(props.saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'fresh', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }),
      )
    })
  })

  it('edits an existing server with keys shown and secrets blank', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const card = screen.getByRole('heading', { name: 'docs' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Editar' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome do servidor').readOnly).toBe(true)
    expect(within(dialog).getByDisplayValue('Authorization')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => {
      expect(props.saveMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'docs', headers: { Authorization: '' } }),
      )
    })
  })

  it('tests a definition without saving it and renders the outcome', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar servidor MCP/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/mcp' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Testar conexão' }))
    await vi.waitFor(() => {
      expect(props.probeMcpServer).toHaveBeenCalled()
    })
    expect(props.saveMcpServer).not.toHaveBeenCalled()
  })

  it('renders a probe that connected but could not list tools differently from a connect failure', () => {
    const probe = (stage: McpServerProbe['stage']): McpServerProbe => ({
      ok: false,
      stage,
      message: 'diagnostic',
      serverName: null,
      serverVersion: null,
      toolNames: [],
      truncated: false,
      durationMs: 12,
    })
    const withProbe = (stage: McpServerProbe['stage']) => {
      const built = fixture('pt', { mcpProbe: probe(stage) })
      const view = render(<ConnectionsPage {...built.props} />)
      const card = view.container.querySelector('article')!
      fireEvent.click(within(card).getByRole('button', { name: 'Testar' }))
      return view.container.textContent ?? ''
    }
    const connectText = withProbe('connect')
    cleanup()
    const listText = withProbe('list')
    expect(connectText).toContain('Não foi possível conectar')
    expect(listText).toContain('a listagem de ferramentas falhou')
    expect(connectText).not.toBe(listText)
  })

  it('cancels a removal without calling the Host', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const card = screen.getByRole('heading', { name: 'docs' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Remover' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(props.deleteMcpServer).not.toHaveBeenCalled()
  })

  it('confirms a removal before calling the Host', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const card = screen.getByRole('heading', { name: 'docs' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Remover' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover servidor' }))
    await vi.waitFor(() => {
      expect(props.deleteMcpServer).toHaveBeenCalledWith('docs')
    })
  })

  it('toggles a server without opening a dialog', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const card = screen.getByRole('heading', { name: 'docs' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Desativar docs' }))
    await vi.waitFor(() => {
      expect(props.setMcpEnabled).toHaveBeenCalledWith('docs', false)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the Host reason when a save was refused', () => {
    const { props } = fixture('pt', {
      actionFailed: 'mcp-save',
      mcpError: 'name must match [A-Za-z0-9_-]{1,32}',
    })
    render(<ConnectionsPage {...props} />)
    const card = screen.getByRole('heading', { name: 'docs' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Editar' }))
    expect(screen.getByRole('dialog').textContent).toContain('name must match')
  })
})

describe('owned service accounts', () => {
  it('shows the connection status and disconnects only after confirmation', async () => {
    const { props } = fixture('pt', {
      connections: {
        available: true,
        toolkits: [toolkit('github', 'GitHub')],
        accounts: [account('connection-1', 'github', 'Work', 'expired')],
      },
    })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('Autorização expirada')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    expect(props.disconnect).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desconectar conta' }))
    await vi.waitFor(() => {
      expect(props.disconnect).toHaveBeenCalledWith('connection-1')
    })
  })

  it('reopens a pending authorization link', () => {
    const { props } = fixture('pt', {
      connections: {
        available: true,
        toolkits: [toolkit('github', 'GitHub')],
        accounts: [account('connection-1', 'github', 'Work', 'pending')],
      },
      authorizationIds: ['connection-1' as ConnectionId],
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Abrir navegador novamente/ }))
    expect(props.reopenConnection).toHaveBeenCalledWith('connection-1')
  })

  it('offers the catalog connection flow and rejects a duplicate name', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' })).getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Nome da conexão'), { target: { value: 'work' } })
    expect(within(dialog).getByText(/já tem uma conexão/)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Nome da conexão'), { target: { value: 'Personal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Continuar no navegador/ }))
    expect(props.connect).toHaveBeenCalledWith('github', 'Personal')
  })

  it('labels a public service that needs no authorization', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' })).getByRole('button', { name: /Outros/ }))
    expect(screen.getByText('Disponível')).toBeTruthy()
  })
})

describe('english copy', () => {
  it('uses the same structure in English', () => {
    const { props } = fixture('en')
    render(<ConnectionsPage {...props} />)
    expect(screen.getByRole('heading', { name: /MCP servers/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add MCP server/ })).toBeTruthy()
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
    expect(screen.getByText('Pick a category to see its services.')).toBeTruthy()
  })
})

describe('service brand marks', () => {
  /** The card head holding the service icon, for one revealed service. */
  const serviceHead = (name: string) =>
    screen.getByRole('heading', { name }).closest('div')!.parentElement!

  /** Reveal one catalog service by name and return its card. */
  const openService = (name: string) => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Buscar um serviço'), { target: { value: name } })
    return screen.getByRole('heading', { name }).closest('article')!
  }

  it('shows the catalog mark instead of the product glyph', () => {
    const { props } = fixture('pt', {
      connections: {
        available: true,
        toolkits: [{ ...toolkit('googledrive', 'Google Drive'), logo: 'https://logos.test/drive.svg' }],
        accounts: [],
      },
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Buscar um serviço'), { target: { value: 'drive' } })
    const head = serviceHead('Google Drive')
    const mark = head.querySelector('img')!
    expect(mark.getAttribute('src')).toBe('https://logos.test/drive.svg')
    // The adjacent service name labels it, so the mark is decorative.
    expect(mark.getAttribute('alt')).toBe('')
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(head.querySelector('svg')).toBeNull()
  })

  it('keeps the product glyph when the catalog carries no mark', () => {
    openService('GitHub')
    const head = serviceHead('GitHub')
    expect(head.querySelector('img')).toBeNull()
    expect(head.querySelector('svg')).not.toBeNull()
  })

  it('falls back to the glyph when the mark cannot be loaded', () => {
    const { props } = fixture('pt', {
      connections: {
        available: true,
        toolkits: [{ ...toolkit('googledrive', 'Google Drive'), logo: 'https://logos.test/missing.svg' }],
        accounts: [],
      },
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Buscar um serviço'), { target: { value: 'drive' } })
    const head = serviceHead('Google Drive')
    fireEvent.error(head.querySelector('img')!)
    expect(head.querySelector('img')).toBeNull()
    expect(head.querySelector('svg')).not.toBeNull()
  })

  it('shows the mark beside an owned account', () => {
    const { props } = fixture('pt', {
      connections: {
        available: true,
        toolkits: [{ ...toolkit('github', 'GitHub'), logo: 'https://logos.test/github.svg' }],
        accounts: [account('connection-1', 'github', 'Work')],
      },
    })
    render(<ConnectionsPage {...props} />)
    const section = screen.getByRole('heading', { name: 'Contas conectadas' }).closest('section')!
    expect(section.querySelector('img')?.getAttribute('src')).toBe('https://logos.test/github.svg')
  })

  it('names the account service from the catalog inside the same row', () => {
    const { props } = fixture('pt', {
      connections: {
        available: true,
        toolkits: [toolkit('github', 'GitHub')],
        accounts: [account('connection-1', 'github', 'Work'), account('connection-2', 'mystery', 'Other')],
      },
    })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('GitHub')).not.toBeNull()
    // A toolkit the catalog no longer lists keeps its raw slug.
    expect(screen.getByText('mystery')).not.toBeNull()
  })
})
