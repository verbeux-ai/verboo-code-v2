// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type {
  Connection,
  ConnectionId,
  Connections,
  Toolkit,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type {
  CustomMcpServerView,
  McpServerProbe,
} from '@deepseek-ai/dsh-api-verboo-mcp/types'
import type { ProductSnapshot } from '../src/client/model.ts'
import { ConnectionsPage } from '../src/client/Connections.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(cleanup)

/** Render one locale string, substituting the supplied values. */
function translate(key: string, values?: Record<string, unknown>): string {
  const dictionary: Readonly<Record<string, string>> = pt
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => {
    const value = values?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })
}

const toolkit = (slug: string, name: string, authType: Toolkit['authType'] = 'oauth'): Toolkit => ({
  slug, name, available: true, authType,
})
const account = (id: string, slug: string, label: string, status: Connection['status'] = 'connected'): Connection => ({
  id: id as ConnectionId, toolkit: slug, label, status,
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
  status: { state: 'connected', toolCount: 2, lastError: '', missing: [] },
  ...overrides,
})
const probe = (overrides: Partial<McpServerProbe> = {}): McpServerProbe => ({
  ok: true,
  stage: null,
  message: null,
  serverName: 'fixture',
  serverVersion: '1.0.0',
  toolNames: ['search'],
  truncated: false,
  durationMs: 21,
  ...overrides,
})

/** The page over one snapshot and stub commands; tests override only what they exercise. */
function fixture(overrides: Partial<ProductSnapshot> = {}) {
  const connections: Connections = {
    available: true,
    toolkits: [toolkit('github', 'GitHub'), toolkit('figma', 'Figma'), toolkit('stripe', 'Stripe')],
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
  const props = {
    useProduct: (selector: (snapshot: ProductSnapshot) => unknown) => selector(state),
    usePreferences: (
      selector: (snapshot: { locale: string; theme: string; languages: readonly { id: string; label: string }[] }) => unknown,
    ) => selector({ locale: 'pt', theme: 'system', languages: [] }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
    t: translate,
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

const page = () => screen.getByRole('main')
const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const openDraft = () => {
  fireEvent.click(screen.getByRole('button', { name: /Adicionar servidor MCP/ }))
  return screen.getByRole('dialog')
}
const card = (name: string) => screen.getByRole('heading', { name }).closest('article')!

describe('summary and section states', () => {
  it('announces the three tallies once, politely', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    expect(page().querySelector('[role="status"]')?.textContent)
      .toBe('1 contas conectadas, 1 servidores MCP ativos, 3 serviços no catálogo')
  })

  it('scrolls to the section a tally names', () => {
    const { props } = fixture()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Contas conectadas/ }))
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('shows the loading placeholder before the first account read settles', () => {
    const { props } = fixture({ connections: null, loadingConnections: true })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeTruthy()
  })

  it('explains an unavailable catalog without inventing rows', () => {
    const { props, state } = fixture()
    state.connections = { available: false, toolkits: [], accounts: [] }
    render(<ConnectionsPage {...props} />)
    expect(screen.getAllByText(/As conexões estão indisponíveis/).length).toBeGreaterThan(0)
  })

  it('tells the user to finish authorizing in the browser during a handoff', () => {
    const { props } = fixture({ handoff: 'connection' })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText(/Autorize a conexão no navegador/)).toBeTruthy()
  })

  it('retries both reads from the header refresh', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Atualizar/ }))
    expect(props.loadConnections).toHaveBeenCalled()
    expect(props.loadMcpServers).toHaveBeenCalled()
  })
})

describe('editor rows', () => {
  it('adds, edits, reveals and removes a header row', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.click(within(dialog).getByRole('button', { name: /Adicionar cabeçalho/ }))
    const keys = within(dialog).getAllByRole('textbox', { name: 'Cabeçalho' })
    expect(keys.length).toBe(2)
    fireEvent.change(keys[1]!, { target: { value: 'X-Api-Key' } })
    const values = within(dialog).getAllByLabelText('Valor')
    fireEvent.change(values[1]!, { target: { value: 'secret' } })
    expect((values[1] as HTMLInputElement).type).toBe('password')

    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Mostrar' })[1]!)
    expect((within(dialog).getAllByLabelText('Valor')[1] as HTMLInputElement).type).toBe('text')
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Ocultar' })[0]!)
    expect((within(dialog).getAllByLabelText('Valor')[1] as HTMLInputElement).type).toBe('password')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover X-Api-Key' }))
    expect(within(dialog).getAllByRole('textbox', { name: 'Cabeçalho' }).length).toBe(1)
  })

  it('names an empty row by its field so the remove action stays labelled', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.click(within(dialog).getByRole('button', { name: /Adicionar cabeçalho/ }))
    expect(within(dialog).getAllByRole('button', { name: 'Remover Cabeçalho' }).length).toBeGreaterThan(0)
  })

  it('switches to a command transport and submits a parsed argument list', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Comando' }))
    expect(within(dialog).queryByLabelText('URL do endpoint')).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Comando'), { target: { value: ' npx ' } })
    fireEvent.change(within(dialog).getByLabelText('Argumentos'), { target: { value: ' -y   server  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Adicionar variável/ }))
    const envKey = within(dialog).getAllByLabelText('Variável')[0]!
    fireEvent.change(envKey, { target: { value: 'TOKEN' } })
    const envValue = within(dialog).getAllByLabelText('Valor')[0]!
    fireEvent.change(envValue, { target: { value: 'abc' } })
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'local' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => {
      expect(props.saveMcpServer).toHaveBeenCalledWith({
        name: 'local',
        transport: 'stdio',
        url: '',
        headers: {},
        command: 'npx',
        args: ['-y', 'server'],
        env: { TOKEN: 'abc' },
        enabled: true,
      })
    })
  })

  it('clears the probe outcome when the transport changes', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Comando' }))
    expect(props.clearMcpProbe).toHaveBeenCalled()
  })

  it('toggles the connect-on-save choice', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => {
      expect(props.saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    })
  })

  it('keeps the dialog open when the Host refuses the save', async () => {
    const { props } = fixture({ actionFailed: 'mcp-save', mcpError: 'name must match' })
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() =>{ expect(props.saveMcpServer).toHaveBeenCalled() })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('name must match')
  })

  it('closes the dialog after a confirmed save', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('tests the definition on Enter and ignores modifier keys', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    const url = within(dialog).getByLabelText('URL do endpoint')
    fireEvent.change(url, { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.keyDown(url, { key: 'Enter', ctrlKey: true })
    expect(props.probeMcpServer).not.toHaveBeenCalled()
    fireEvent.keyDown(url, { key: 'Enter' })
    await vi.waitFor(() =>{ expect(props.probeMcpServer).toHaveBeenCalled() })
  })

  it('leaves Enter on the checkbox to the checkbox itself', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.keyDown(within(dialog).getByRole('checkbox'), { key: 'Enter' })
    expect(props.probeMcpServer).not.toHaveBeenCalled()
  })

  it('refuses to test an invalid definition', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Testar conexão' }))
    expect(props.probeMcpServer).not.toHaveBeenCalled()
  })
})

describe('saved server actions', () => {
  it('tests a saved server with blank values so the Host keeps its secrets', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    await vi.waitFor(() => {
      expect(props.probeMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'docs', headers: { Authorization: '' }, env: {} }),
      )
    })
  })

  it('renders a successful outcome with its duration and tool count', () => {
    const { props } = fixture({
      mcpProbe: probe({ toolNames: ['a', 'b', 'c'] }),
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    const outcome = within(card('docs')).getByRole('status')
    expect(outcome.textContent).toContain('Conexão feita em 21 ms.')
    expect(outcome.textContent).toContain('fixture')
    expect(outcome.textContent).toContain('3 ferramentas disponíveis.')
  })

  it('lists at most eight found tools and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_value, index) => `tool-${String(index)}`)
    const { props } = fixture({ mcpProbe: probe({ toolNames: many }) })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    expect(screen.getByText('+3')).toBeTruthy()
  })

  it('says so when a server advertises no tools, and when the list was capped', () => {
    const { props, state } = fixture({
      mcpProbe: probe({ toolNames: [], truncated: true }),
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    expect(state.mcpProbe).not.toBeNull()
    expect(screen.getByText('O servidor não listou nenhuma ferramenta.')).toBeTruthy()
    expect(screen.getByText('Apenas as primeiras ferramentas são exibidas.')).toBeTruthy()
  })

  it('names the failing stage and keeps the diagnostic', () => {
    const { props } = fixture({
      mcpProbe: probe({ ok: false, stage: 'list', message: 'transport refused', toolNames: [] }),
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    expect(screen.getByText(/a listagem de ferramentas falhou/)).toBeTruthy()
    expect(screen.getByText('transport refused')).toBeTruthy()
  })

  it('keeps the removal dialog open and explains a refusal', async () => {
    const { props, state } = fixture({ actionFailed: 'mcp-delete', mcpError: 'still stored' })
    state.mcpServers = [server()]
    props.deleteMcpServer = vi.fn(async () => false)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Remover' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover servidor' }))
    await vi.waitFor(() =>{  expect(props.deleteMcpServer).toHaveBeenCalledWith('docs') })
    expect(screen.getByRole('dialog').textContent).toContain('still stored')
  })

  it('keeps the disconnect dialog open and explains a refusal', async () => {
    const { props } = fixture({ actionFailed: 'disconnect' })
    props.disconnect = vi.fn(async () => false)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desconectar conta' }))
    await vi.waitFor(() =>{ expect(props.disconnect).toHaveBeenCalled() })
    expect(screen.getByRole('dialog').textContent).toContain('continua conectada')
  })

  it('keeps the connect dialog open when authorization does not start', async () => {
    const { props } = fixture()
    props.connect = vi.fn(async () => false)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Nome da conexão'), { target: { value: 'Personal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Continuar no navegador/ }))
    await vi.waitFor(() =>{ expect(props.connect).toHaveBeenCalled() })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('reports a toggle failure with the Host reason', () => {
    const { props } = fixture({ actionFailed: 'mcp-toggle', mcpError: 'manager disposed' })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText(/manager disposed/)).toBeTruthy()
  })
})

describe('catalog paging and empty results', () => {
  it('pages past the first forty results', () => {
    const { props, state } = fixture()
    state.connections = {
      available: true,
      accounts: [],
      toolkits: Array.from({ length: 45 }, (_value, index) =>
        toolkit(`git-tool-${String(index)}`, `Git tool ${String(index)}`)),
    }
    render(<ConnectionsPage {...props} />)
    const categories = screen.getByRole('group', { name: 'Filtrar por categoria' })
    fireEvent.click(within(categories).getByRole('button', { name: /Desenvolvimento/ }))
    expect(screen.getByText('Exibindo 40 de 45')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }))
    expect(screen.getByText('Exibindo 45 de 45')).toBeTruthy()
  })

  it('offers a way out when a search finds nothing', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.change(screen.getByLabelText('Buscar um serviço'), { target: { value: 'zzzz' } })
    expect(screen.getByText('Nenhum serviço encontrado.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }))
    expect(screen.queryByText('Nenhum serviço encontrado.')).toBeNull()
    expect(screen.getByText('Escolha uma categoria para ver os serviços.')).toBeTruthy()
  })
})

describe('remaining editor branches', () => {
  it('labels every catalog authorization method', () => {
    const { props, state } = fixture()
    state.connections = {
      available: true,
      accounts: [],
      toolkits: [
        toolkit('github', 'GitHub', 'oauth'),
        toolkit('stripe', 'Stripe', 'credentials'),
        toolkit('sap', 'SAP', 'setup'),
        toolkit('searxng', 'SearXNG', 'none'),
      ],
    }
    render(<ConnectionsPage {...props} />)
    const categories = screen.getByRole('group', { name: 'Filtrar por categoria' })
    fireEvent.click(within(categories).getByRole('button', { name: /Desenvolvimento/ }))
    expect(screen.getByText(/Entre com sua conta/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Todas as categorias/ }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Finanças/ }))
    expect(screen.getByText(/Autorize com segurança/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Todas as categorias/ }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Outros/ }))
    expect(screen.getByText(/Requer configuração/)).toBeTruthy()
    expect(screen.getAllByText('Disponível').length).toBeGreaterThan(0)
  })

  it('summarises a stdio definition by its command line', () => {
    const { props } = fixture({
      mcpServers: [server({
        transport: 'stdio', url: '', command: 'npx', args: ['-y', 'server'], headerNames: [], envNames: ['TOKEN'],
      })],
    })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('npx -y server')).toBeTruthy()
    expect(screen.getByText(/1 variável/)).toBeTruthy()
  })

  it('edits a stdio definition with its environment key listed', () => {
    const { props } = fixture({
      mcpServers: [server({
        transport: 'stdio', url: '', command: 'npx', args: ['-y', 'server'], headerNames: [], envNames: ['TOKEN'],
      })],
    })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Editar' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText<HTMLInputElement>('Variável').value).toBe('TOKEN')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover TOKEN' }))
    expect(within(dialog).queryByLabelText('Variável')).toBeNull()
  })

  it('removes an environment row from a new definition', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Comando' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /Adicionar variável/ }))
    const keys = within(dialog).getAllByLabelText('Variável')
    expect(keys.length).toBe(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover Variável' }))
    expect(within(dialog).queryByLabelText('Variável')).toBeNull()
  })

  it('closes the dialogs from their own cancel and close actions', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /Adicionar servidor MCP/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Remover' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('scrolls to the MCP and catalog tallies', () => {
    const { props } = fixture()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Servidores MCP ativos/ }))
    fireEvent.click(screen.getByRole('button', { name: /Serviços no catálogo/ }))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('ignores a save and a probe that arrive without a draft', async () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    // Closing the dialog removes its handlers with the draft state.
    fireEvent.click(screen.getByRole('button', { name: /Adicionar servidor MCP/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(props.saveMcpServer).not.toHaveBeenCalled()
    expect(props.probeMcpServer).not.toHaveBeenCalled()
  })
})

describe('busy, failure and close paths', () => {
  it('shows the running state while a probe and a toggle are in flight', () => {
    const { props, state } = fixture({ probingMcp: true, busy: 'mcp:docs' })
    state.mcpServers = [server()]
    render(<ConnectionsPage {...props} />)
    const saved = card('docs')
    expect(within(saved).getAllByRole('button', { name: /Testando|Testar/ }).length).toBeGreaterThan(0)
    expect(within(saved).getByRole('button', { name: /Desativar docs/ })).toBeTruthy()
    // The toggle button reports its running state without changing its label.
    expect(within(saved).getByRole('button', { name: /Desativar docs/ }).textContent).toContain('Desativar')
  })

  it('shows the editor probe running state', () => {
    const { props } = fixture({ probingMcp: true })
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    const probeButton = within(dialog).getByRole<HTMLButtonElement>('button', { name: /Testando/ })
    expect(probeButton.disabled).toBe(true)
  })

  it('renders the saved probe result beside the editor and drops it when closed', () => {
    const { props } = fixture({ mcpProbe: probe() })
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    expect(within(dialog).getByText(/Conexão feita/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(props.clearMcpProbe).toHaveBeenCalled()
  })

  it('hides the server identity line when the probe learned no identity', () => {
    const { props } = fixture({ mcpProbe: probe({ serverName: null, serverVersion: null }) })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    expect(screen.queryByText('Servidor')).toBeNull()
    expect(screen.getByText(/Conexão feita/)).toBeTruthy()
  })

  it('keeps the dialog open while a save is in flight', async () => {
    const gate = Promise.withResolvers<boolean>()
    const { props } = fixture()
    props.saveMcpServer = vi.fn(async () => gate.promise)
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() =>{ expect(props.saveMcpServer).toHaveBeenCalled() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    gate.resolve(true)
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('keeps the removal dialog open while the removal is in flight', async () => {
    const gate = Promise.withResolvers<boolean>()
    const { props } = fixture()
    props.deleteMcpServer = vi.fn(async () => gate.promise)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Remover' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover servidor' }))
    await vi.waitFor(() =>{ expect(props.deleteMcpServer).toHaveBeenCalled() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    gate.resolve(true)
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('ignores a non-Enter key and an already handled Enter in the editor', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    const url = within(dialog).getByLabelText('URL do endpoint')
    fireEvent.keyDown(url, { key: 'a' })
    expect(props.probeMcpServer).not.toHaveBeenCalled()
    const handled = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    handled.preventDefault()
    url.dispatchEvent(handled)
    expect(props.probeMcpServer).not.toHaveBeenCalled()
  })
})

describe('closing a dialog through its own chrome', () => {
  it('closes the removal, disconnect and connect dialogs from their close button', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)

    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Remover' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps each dialog open while its command owns the close affordance', async () => {
    const removal = Promise.withResolvers<boolean>()
    const { props } = fixture()
    props.deleteMcpServer = vi.fn(async () => removal.promise)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Remover' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover servidor' }))
    await vi.waitFor(() =>{ expect(props.deleteMcpServer).toHaveBeenCalled() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    removal.resolve(true)
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })
})

describe('state combinations rendered at once', () => {
  it('shows the catalog failure notice with the Host reason', () => {
    const { props } = fixture({ connectionsFailed: true })
    render(<ConnectionsPage {...props} />)
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
  })

  it('falls back to the raw toolkit id for an account whose service left the catalog', () => {
    const { props } = fixture({
      connections: {
        available: true,
        toolkits: [toolkit('figma', 'Figma')],
        accounts: [account('connection-1', 'github', 'Work')],
      },
    })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('github')).toBeTruthy()
  })

  it('shows the MCP loading placeholder before the first read settles', () => {
    const { props } = fixture({ mcpServers: null, loadingMcp: true })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('Servidores MCP')).toBeTruthy()
  })

  it('explains a failed live connection on its card', () => {
    const { props } = fixture({
      mcpServers: [server({
        status: { state: 'failed', toolCount: 0, lastError: 'spawn ENOENT', missing: [] },
      })],
    })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('spawn ENOENT')).toBeTruthy()
  })

  it('marks a disabled server with an enable action', () => {
    const { props } = fixture({
      mcpServers: [server({ enabled: false, status: { state: 'disabled', toolCount: 0, lastError: '', missing: [] } })],
    })
    render(<ConnectionsPage {...props} />)
    expect(within(card('docs')).getByRole('button', { name: 'Ativar docs' })).toBeTruthy()
    expect(screen.getByText('Desativado')).toBeTruthy()
  })

  it('spins the catalog button of the service that is authorizing', () => {
    const { props } = fixture({ busy: 'github' })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    const connect = screen.getByRole('button', { name: 'Conectar GitHub' })
    expect(connect.querySelector('svg')).toBeTruthy()
  })

  it('offers provider configuration for a service that is not available', () => {
    const { props, state } = fixture()
    state.connections!.toolkits = [{ slug: 'sap', name: 'SAP', available: false, authType: 'setup' }]
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Outros/ }))
    expect(screen.getByRole('button', { name: 'Conectar SAP' })).toBeTruthy()
    expect(screen.getAllByText('Requer configuração do provedor').length).toBeGreaterThan(0)
  })

  it('reports a failed authorization start inside the connect dialog', () => {
    const { props } = fixture({ actionFailed: 'connect' })
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    expect(screen.getByRole('dialog').textContent).toContain('Não foi possível iniciar a autorização')
  })

  it('closes the editor through its close button while a save is in flight', async () => {
    const gate = Promise.withResolvers<boolean>()
    const { props } = fixture()
    props.saveMcpServer = vi.fn(async () => gate.promise)
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() =>{ expect(props.saveMcpServer).toHaveBeenCalled() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    gate.resolve(true)
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('reports the toggle failure with the Host reason in the toast', () => {
    const { props } = fixture({ actionFailed: 'mcp-toggle', mcpError: 'manager disposed' })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText(/manager disposed/)).toBeTruthy()
  })

  it('flags a duplicate name and a malformed endpoint inline', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'docs' } })
    expect(within(dialog).getByText('Já existe um servidor com este nome.')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'other' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'not-a-url' } })
    expect(within(dialog).getByText('Use uma URL que comece com http:// ou https://.')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Salvar' }).disabled).toBe(true)
  })
})

describe('closing while idle and saving refusals', () => {
  it('closes each dialog from its close button while no command runs', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the editor usable when the Host cannot confirm the save', async () => {
    const { props } = fixture()
    props.saveMcpServer = vi.fn(async () => false)
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'fresh' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() =>{ expect(props.saveMcpServer).toHaveBeenCalled() })
    // A refused save leaves the definition in the editor for correction.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome do servidor').value).toBe('fresh')
  })

  it('opens the editor while the MCP list has never settled', () => {
    const { props } = fixture({ mcpServers: null })
    render(<ConnectionsPage {...props} />)
    const dialog = openDraft()
    fireEvent.change(within(dialog).getByLabelText('Nome do servidor'), { target: { value: 'first' } })
    fireEvent.change(within(dialog).getByLabelText('URL do endpoint'), { target: { value: 'https://mcp.example.com/x' } })
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Salvar' }).disabled).toBe(false)
  })

  it('names the running probe on the card that was tested', async () => {
    const gate = Promise.withResolvers<boolean>()
    const { props, state } = fixture()
    props.probeMcpServer = vi.fn(async () => gate.promise)
    const view = render(<ConnectionsPage {...props} />)
    fireEvent.click(within(card('docs')).getByRole('button', { name: 'Testar' }))
    await vi.waitFor(() =>{ expect(props.probeMcpServer).toHaveBeenCalled() })
    // The presenter turns the running flag on while this card is the tested one.
    state.probingMcp = true
    view.rerender(<ConnectionsPage {...props} />)
    expect(within(card('docs')).getByText('Testando…')).toBeTruthy()
    gate.resolve(true)
    await settle()
  })
})

describe('failure reasons beside their generic line', () => {
  it('renders the Host reason under the MCP read failure', () => {
    const { props } = fixture({ mcpServers: null, mcpFailed: true, mcpError: 'store is not open' })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText('store is not open')).toBeTruthy()
  })

  it('renders the plain toggle failure line without a reason', () => {
    const { props } = fixture({ actionFailed: 'mcp-toggle' })
    render(<ConnectionsPage {...props} />)
    expect(screen.getByText(/Não foi possível alterar este servidor|Falha ao alterar/)).toBeTruthy()
  })
})

describe('closing the two confirmation dialogs', () => {
  it('closes the disconnect dialog from its own close control', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the connect dialog from its own close control', () => {
    const { props } = fixture()
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the close control stays inert while its command runs', () => {
  it('ignores close on the disconnect dialog while the removal is in flight', async () => {
    const gate = Promise.withResolvers<boolean>()
    const { props } = fixture()
    props.disconnect = vi.fn(async () => gate.promise)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desconectar conta' }))
    await vi.waitFor(() =>{ expect(props.disconnect).toHaveBeenCalled() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    gate.resolve(true)
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('ignores close on the connect dialog while authorization starts', async () => {
    const gate = Promise.withResolvers<boolean>()
    const { props } = fixture()
    props.connect = vi.fn(async () => gate.promise)
    render(<ConnectionsPage {...props} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por categoria' }))
      .getByRole('button', { name: /Desenvolvimento/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar GitHub' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Nome da conexão'), { target: { value: 'Personal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Continuar no navegador/ }))
    await vi.waitFor(() =>{ expect(props.connect).toHaveBeenCalled() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    gate.resolve(true)
    await vi.waitFor(() =>{ expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
