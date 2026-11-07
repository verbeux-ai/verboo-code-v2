/**
 * User-defined MCP servers for Verboo Code (`ctx.verbooMcp`). A definition is
 * validated at the write, stored durably as keys plus `${credential:REF}`
 * templates, and registered on the shared `dsh-mcp-manager` fleet, so the
 * Agent's tool registry gains `mcp__<name>__<tool>` entries for exactly the
 * servers the user enabled. Secret values cross in one direction only: a
 * surface submits them, the Host writes them to the credential store, and no
 * read path returns them.
 *
 * @module @deepseek-ai/dsh-api-verboo-mcp
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { probeServer } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig, McpProbeResult } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { mcpServerDomain } from './store.ts'
import type { StoredMcpServer } from './store.ts'
import { DefinitionError, normalizeDefinition } from './validate.ts'
import type { NormalizedDefinition } from './validate.ts'
import type {
  CustomMcpServerView,
  McpResult,
  McpServerInput,
  McpServerProbe,
  McpTransport,
} from './types.ts'

export type {
  CustomMcpServer,
  CustomMcpServerView,
  CustomMcpStatus,
  McpError,
  McpResult,
  McpServerInput,
  McpServerProbe,
  McpTransport,
} from './types.ts'

/** Connection, probe and admission budgets for user-defined servers. */
export const Config = Schema.object({
  /** Budget for one connection attempt plus its initial tool discovery. */
  startupTimeoutMs: Schema.number().min(1000).max(120000).default(30000),
  /** Budget for one tool call on a user-defined server. */
  toolCallTimeoutMs: Schema.number().min(1000).max(600000).default(60000),
  /** Budget for one "test connection" probe, including tool listing. */
  probeTimeoutMs: Schema.number().min(1000).max(60000).default(15000),
  /** Most tool names one probe reports back. */
  probeMaxToolNames: Schema.number().min(1).max(512).default(120),
  /** Highest number of definitions one account may store. */
  maxServers: Schema.number().min(1).max(64).default(24),
})
/** Resolved user-defined MCP server configuration. */
export interface Config {
  /** Budget for one connection attempt plus its initial tool discovery. */
  startupTimeoutMs?: number
  /** Budget for one tool call on a user-defined server. */
  toolCallTimeoutMs?: number
  /** Budget for one probe, including tool listing. */
  probeTimeoutMs?: number
  /** Most tool names one probe reports back. */
  probeMaxToolNames?: number
  /** Highest number of definitions one account may store. */
  maxServers?: number
}

/** One definition as the Agent tool layer reports it. */
export interface VerbooMcpServerSummary {
  /** Server key; its tools register as `mcp__<name>__<tool>`. */
  name: string
  /** Transport this definition connects with. */
  transport: McpTransport
  /** Credential-free target: endpoint URL or the stdio command line. */
  target: string
  /** Whether the user asked for a live connection. */
  enabled: boolean
  /** Coarse connection state. */
  state: string
  /** Registered tools in the live generation; `0` when none is registered. */
  toolCount: number
  /** Why the server is unusable right now; empty when it is connected or switched off. */
  problem: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User-defined MCP servers owned by the signed-in account. */
    verbooMcp: VerbooMcpServers
  }
}

const EMPTY_STATUS: CustomMcpServerView['status'] = {
  state: 'unknown',
  toolCount: 0,
  lastError: '',
  missing: [],
}

/** Credential-free target description for one definition. */
function targetOf(entry: StoredMcpServer): string {
  if (entry.transport === 'stdio') {
    return [entry.command, ...entry.args].join(' ').trim()
  }
  return entry.url
}

/**
 * The user-defined MCP server service. Definitions live in a `per-record`
 * storage domain; each mounted definition owns one `ctx.mcpManager.register()`
 * disposer, so reconciliation adds and withdraws servers without touching
 * manager-configured ones.
 */
export default class VerbooMcpServers extends TypertRemoteService {
  static inject = ['credentials', 'mcpManager', 'storageDomain']
  /** Schema for {@link Config}; a service class reads its configuration from here. */
  static Config = Config

  private readonly budgets: Required<Config>
  /** Disposer per mounted definition, keyed by server name. */
  private readonly mounted = new Map<string, () => void>()
  /** Serialized reconciliation, so two writes never mount the same server twice. */
  private chain: Promise<unknown> = Promise.resolve()
  /** Opened definition domain; set once by {@link VerbooMcpServers}. */
  private opening: Promise<Domain<typeof mcpServerDomain>> | undefined
  private stopping = false

  /**
   * @param ctx - Host context providing credentials, the MCP manager and storage.
   * @param config - validated connection, probe and admission budgets.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'verbooMcp', { namespace: 'verbooMcp' })
    // The Loader applies Config before construction, so every budget is
    // defined here; the defaults cover a hand-constructed service.
    /* v8 ignore next 7 -- the schema supplies each field before this runs */
    this.budgets = {
      startupTimeoutMs: config.startupTimeoutMs ?? 30000,
      toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60000,
      probeTimeoutMs: config.probeTimeoutMs ?? 15000,
      probeMaxToolNames: config.probeMaxToolNames ?? 120,
      maxServers: config.maxServers ?? 24,
    }
  }

  /**
   * Open the definition domain, mount the stored enabled definitions, and
   * release both on teardown.
   */
  *[Service.init](): Generator<() => Promise<void> | void, void, void> {
    const opening = this.ctx.storageDomain.open(mcpServerDomain)
    this.opening = opening
    yield async () => {
      this.stopping = true
      await this.chain
      for (const dispose of this.mounted.values()) dispose()
      this.mounted.clear()
      const domain = await opening
      await domain.close()
      this.opening = undefined
    }
    void opening.then(
      () => this.reconcile().catch((error: unknown) => {
        this.ctx.logger.error('verboo-mcp: mounting the stored definitions failed')
        this.ctx.logger.error(error)
      }),
      (error: unknown) => {
        this.ctx.logger.error('verboo-mcp: opening the definition store failed')
        this.ctx.logger.error(error)
      },
    )
  }

  /** Serialize one reconciliation behind every queued predecessor. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** The opened definition domain. */
  private async store(): Promise<Domain<typeof mcpServerDomain>> {
    /* v8 ignore next 3 -- activation sets `opening` before any call can reach a Remote method */
    if (this.opening === undefined) {
      throw new DefinitionError('unavailable', 'the MCP server store is not open')
    }
    return this.opening
  }

  /** Stored definitions in name order. */
  private async entries(): Promise<StoredMcpServer[]> {
    const table = (await this.store()).table('servers')
    return [...table.entries()]
      .map(([, value]) => value)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Flatten the manager's status into the facts a surface renders. */
  private statusOf(
    status: McpManagedServerView['status'] | undefined,
    missing: string[],
  ): CustomMcpServerView['status'] {
    if (status === undefined) return { ...EMPTY_STATUS, missing }
    switch (status.state) {
      case 'connected':
        return { state: 'connected', toolCount: status.toolCount, lastError: '', missing }
      case 'connecting':
        return { state: 'connecting', toolCount: 0, lastError: '', missing }
      case 'reconnecting':
        return { state: 'reconnecting', toolCount: 0, lastError: status.lastError, missing }
      case 'waiting-credentials':
        return { state: 'waiting-credentials', toolCount: 0, lastError: status.lastError, missing }
      case 'disabled':
        return { state: 'disabled', toolCount: 0, lastError: '', missing }
      case 'failed':
        return {
          state: 'failed',
          toolCount: 0,
          lastError: status.reason === 'cleanup' ? 'cleanup is incomplete' : status.lastError ?? '',
          missing,
        }
      case 'closed':
        return { state: 'unknown', toolCount: 0, lastError: '', missing }
    }
  }

  private view(
    entry: StoredMcpServer,
    live: McpManagedServerView | undefined,
    missing: string[],
  ): CustomMcpServerView {
    return {
      name: entry.name,
      transport: entry.transport,
      url: entry.url,
      headerNames: Object.keys(entry.headers),
      command: entry.command,
      args: [...entry.args],
      envNames: Object.keys(entry.env),
      enabled: entry.enabled,
      credentialRefs: [...entry.credentialRefs],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      status: this.statusOf(entry.enabled ? live?.status : { state: 'disabled' }, missing),
    }
  }

  /**
   * Mount every enabled definition and withdraw every disabled or removed one.
   * @returns after the manager accepted every registration change.
   */
  async reconcile(): Promise<void> {
    return this.enqueue(async () => {
      const entries = await this.entries()
      const wanted = new Map(entries.filter(entry => entry.enabled).map(entry => [entry.name, entry]))
      for (const [name, dispose] of this.mounted) {
        if (wanted.has(name)) continue
        dispose()
        this.mounted.delete(name)
      }
      /* v8 ignore next -- teardown awaits the queued chain before it sets `stopping` */
      if (this.stopping) return
      for (const [name, entry] of wanted) {
        if (this.mounted.has(name)) continue
        try {
          this.mounted.set(name, this.register(name, entry))
        } catch (error: unknown) {
          // A name the deployment already configured stays that deployment's
          // server; the definition remains stored and reports why it is idle.
          this.ctx.logger.warn(
            /* v8 ignore next -- register() throws Error instances */
            `verboo-mcp: "${name}" could not mount: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    })
  }

  private register(name: string, entry: StoredMcpServer): () => void {
    return this.ctx.mcpManager.register(name, {
      transport: entry.transport,
      command: entry.command,
      args: [...entry.args],
      env: { ...entry.env },
      cwd: '',
      url: entry.url,
      headers: { ...entry.headers },
      toolCallTimeoutMs: this.budgets.toolCallTimeoutMs,
      startupTimeoutMs: this.budgets.startupTimeoutMs,
    })
  }

  /** Write the plaintext values one submission carried, before its definition is stored. */
  private async storeSecrets(definition: NormalizedDefinition): Promise<void> {
    for (const secret of definition.secrets) {
      await this.ctx.credentials.set(credentialRef(secret.ref), secret.value)
    }
  }

  /**
   * Report the references of one definition with no stored value.
   * @param entry - stored definition.
   * @returns unconfigured reference names in definition order.
   */
  private async missingCredentials(entry: StoredMcpServer): Promise<string[]> {
    const missing: string[] = []
    for (const ref of entry.credentialRefs) {
      const info = await this.ctx.credentials.describe(credentialRef(ref))
      if (!info.configured) missing.push(ref)
    }
    return missing
  }

  private async present(stored: StoredMcpServer): Promise<CustomMcpServerView> {
    const live = this.ctx.mcpManager.list().find(view => view.name === stored.name)
    return this.view(stored, live, await this.missingCredentials(stored))
  }

  /**
   * List this account's definitions with their live state.
   * @returns every stored definition in name order.
   */
  @Remote('list')
  async listFromClient(): Promise<McpResult<CustomMcpServerView[]>> {
    return this.read(async () => {
      await this.reconcile()
      const live = new Map(this.ctx.mcpManager.list().map(view => [view.name, view]))
      const views: CustomMcpServerView[] = []
      for (const entry of await this.entries()) {
        views.push(this.view(entry, live.get(entry.name), await this.missingCredentials(entry)))
      }
      return views
    })
  }

  /**
   * Create or replace one definition.
   * @param input - submitted definition; non-empty header and environment values are stored as credentials.
   * @returns the stored definition with its live state.
   */
  @Remote('save')
  async saveFromClient(input: McpServerInput): Promise<McpResult<CustomMcpServerView>> {
    return this.read(async () => {
      const definition = normalizeDefinition(input)
      const table = (await this.store()).table('servers')
      const existing = table.get(definition.name)
      if (existing === undefined && table.size >= this.budgets.maxServers) {
        throw new DefinitionError(
          'unavailable',
          `at most ${String(this.budgets.maxServers)} MCP servers are accepted; remove one before adding another`,
        )
      }
      await this.storeSecrets(definition)
      const now = new Date().toISOString()
      const stored: StoredMcpServer = {
        name: definition.name,
        transport: definition.transport,
        url: definition.url,
        headers: definition.headers,
        command: definition.command,
        args: definition.args,
        env: definition.env,
        enabled: definition.enabled,
        credentialRefs: definition.credentialRefs,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await table.put(stored.name, stored)
      // A key the edit dropped takes its reference with it.
      const kept = new Set(stored.credentialRefs)
      for (const ref of existing?.credentialRefs ?? []) {
        if (kept.has(ref)) continue
        await this.ctx.credentials.unset(credentialRef(ref))
      }
      this.unmount(stored.name)
      await this.reconcile()
      return this.present(stored)
    })
  }

  /**
   * Connect or disconnect one stored definition without editing it.
   * @param name - server key.
   * @param enabled - whether the definition should hold a live connection.
   * @returns the stored definition with its live state.
   */
  @Remote('setEnabled')
  async setEnabledFromClient(
    name: string,
    enabled: boolean,
  ): Promise<McpResult<CustomMcpServerView>> {
    return this.read(async () => {
      const table = (await this.store()).table('servers')
      const existing = table.get(name)
      if (existing === undefined) {
        throw new DefinitionError('not_found', `no MCP server named "${name}"`)
      }
      const stored: StoredMcpServer = { ...existing, enabled, updatedAt: new Date().toISOString() }
      await table.put(name, stored)
      this.unmount(name)
      await this.reconcile()
      return this.present(stored)
    })
  }

  /**
   * Remove one definition and withdraw its tools.
   * @param name - server key.
   * @returns `null` after the Host confirmed removal.
   */
  @Remote('removeServer')
  async removeFromClient(name: string): Promise<McpResult<null>> {
    return this.read(async () => {
      const table = (await this.store()).table('servers')
      const existing = table.get(name)
      if (existing === undefined) {
        throw new DefinitionError('not_found', `no MCP server named "${name}"`)
      }
      this.unmount(name)
      await table.delete(name)
      // The definition owned these references; keeping them would leave secrets
      // nothing names any more. A failure here does not resurrect the definition.
      for (const ref of existing.credentialRefs) {
        try {
          await this.ctx.credentials.unset(credentialRef(ref))
        } catch (error: unknown) {
          this.ctx.logger.warn(
            /* v8 ignore next -- every provider in the seam rejects Error */
            `verboo-mcp: withdrawing the credential of "${name}" failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          )
        }
      }
      await this.reconcile()
      return null
    })
  }

  /** Drop one mounted registration so the next reconcile rebuilds it. */
  private unmount(name: string): void {
    const dispose = this.mounted.get(name)
    if (dispose === undefined) return
    dispose()
    this.mounted.delete(name)
  }

  /**
   * Test one definition without saving it.
   * @param input - submitted definition; its secret values are used for this probe only.
   * @param signal - caller cancellation.
   * @returns the probe outcome, including advertised tool names.
   */
  @Remote('probe')
  async probeFromClient(
    input: McpServerInput,
    signal: AbortSignal,
  ): Promise<McpResult<McpServerProbe>> {
    return this.read(async () => {
      const definition = normalizeDefinition(input)
      const probe = await probeServer(this.ctx, await this.probeConfig(definition), {
        timeoutMs: this.budgets.probeTimeoutMs,
        maxToolNames: this.budgets.probeMaxToolNames,
        signal,
      })
      return this.probeResult(probe)
    })
  }

  /**
   * Compose the mcp-client configuration one probe connects with. Values the
   * submission carried win over stored ones; an unresolved template keeps the
   * literal, so the probe reports the missing credential instead of connecting
   * with a placeholder.
   */
  private async probeConfig(definition: NormalizedDefinition): Promise<McpClientConfig> {
    const inline = new Map(definition.secrets.map(secret => [secret.ref, secret.value]))
    const expand = async (source: Record<string, string>): Promise<Record<string, string>> => {
      const out: Record<string, string> = {}
      for (const [key, template] of Object.entries(source)) {
        const match = /^\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template)
        /* v8 ignore next 4 -- splitSecrets templates every non-empty submitted value */
        if (match === null) {
          out[key] = template
          continue
        }
        const ref = match[1] as string
        const direct = inline.get(ref)
        out[key] = direct ?? (await this.ctx.credentials.resolve(credentialRef(ref)))?.value ?? template
      }
      return out
    }
    const shared = {
      serverName: definition.name,
      toolCallTimeoutMs: this.budgets.toolCallTimeoutMs,
      startupTimeoutMs: this.budgets.startupTimeoutMs,
      closeTimeoutMs: 5000,
      expandTemplates: false as const,
      failOnStartupError: false as const,
    }
    if (definition.transport === 'stdio') {
      return {
        transport: 'stdio',
        command: definition.command,
        args: [...definition.args],
        env: await expand(definition.env),
        cwd: '',
        ...shared,
      }
    }
    return {
      transport: 'streamable-http',
      url: definition.url,
      headers: await expand(definition.headers),
      ...shared,
    }
  }

  private probeResult(result: McpProbeResult): McpServerProbe {
    if (result.ok) {
      return {
        ok: true,
        stage: null,
        message: null,
        serverName: result.serverInfo?.name ?? null,
        serverVersion: result.serverInfo?.version ?? null,
        toolNames: result.toolNames,
        truncated: result.truncated,
        durationMs: result.durationMs,
      }
    }
    return {
      ok: false,
      stage: result.stage,
      message: result.message,
      serverName: null,
      serverVersion: null,
      toolNames: [],
      truncated: false,
      durationMs: result.durationMs,
    }
  }

  /**
   * The definitions as the Agent tool layer reports them, each with the
   * blocking condition when it is unusable.
   * @returns one summary per stored definition in name order.
   */
  async summaries(): Promise<VerbooMcpServerSummary[]> {
    const live = new Map(this.ctx.mcpManager.list().map(view => [view.name, view]))
    const out: VerbooMcpServerSummary[] = []
    for (const entry of await this.entries()) {
      const liveView = live.get(entry.name)
      const view = this.view(entry, liveView, await this.missingCredentials(entry))
      out.push({
        name: entry.name,
        transport: entry.transport,
        target: targetOf(entry),
        enabled: entry.enabled,
        state: view.status.state,
        toolCount: liveView?.status.state === 'connected' ? liveView.status.toolCount : 0,
        problem: this.problemOf(entry, view),
      })
    }
    return out
  }

  private problemOf(entry: StoredMcpServer, view: CustomMcpServerView): string {
    if (!entry.enabled) return ''
    switch (view.status.state) {
      case 'connected':
        return ''
      case 'waiting-credentials':
        return view.status.missing.length === 0
          ? 'a credential value is missing'
          : `missing credential values: ${view.status.missing.join(', ')}`
      case 'failed':
        return view.status.lastError === ''
          ? 'the server failed to start; check the definition'
          : view.status.lastError
      case 'disabled':
        return 'the server is switched off'
      default:
        return `the server is ${view.status.state}`
    }
  }

  /**
   * Convert a thrown definition or storage failure into a wire result that
   * carries no secret and no upstream body.
   * @param work - the definition operation.
   * @returns the value, or the failure category with actionable text.
   */
  private async read<T>(work: () => Promise<T>): Promise<McpResult<T>> {
    try {
      return { ok: true, data: await work() }
    } catch (error: unknown) {
      if (error instanceof DefinitionError) {
        return { ok: false, code: error.code, message: error.message }
      }
      return {
        ok: false,
        code: 'contract_error',
        /* v8 ignore next -- every producer in this chain throws Error */
        message: error instanceof Error ? error.message : 'the MCP server operation failed',
      }
    }
  }
}
