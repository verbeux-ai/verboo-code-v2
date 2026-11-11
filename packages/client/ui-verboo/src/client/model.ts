/** Reactive product presenter. Components receive snapshots through renderer-bound hooks. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  AccountView,
  AccountProfile,
  SignInAttemptId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type {
  Connections,
  ConnectionId,
  Plans,
  PlanId,
  Result,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type {
  CustomMcpServerView,
  McpResult,
  McpServerInput,
  McpServerProbe,
} from '@deepseek-ai/dsh-api-verboo-mcp/types'

/** Account-owned display data and progress without credentials. */
export interface ProductSnapshot {
  view: AccountView | null
  profile: AccountProfile | null
  /** Whether this Client has successfully verified a stored account at least once. */
  profilePreviouslyVerified: boolean
  initialized: boolean
  accountFailed: boolean
  actionFailed:
    | 'sign-in'
    | 'connect'
    | 'disconnect'
    | 'sign-out'
    | 'global'
    | 'mcp-save'
    | 'mcp-delete'
    | 'mcp-toggle'
    | null
  starting: boolean
  plans: Plans | null
  connections: Connections | null
  plansFailed: boolean
  connectionsFailed: boolean
  loadingPlans: boolean
  loadingConnections: boolean
  busy: string | null
  handoff: 'connection' | 'billing' | null
  handoffUntil: number
  connectedTarget: {
    id: ConnectionId | null
    toolkit: string
    label: string
  } | null
  feedback: 'connectionSuccess' | 'disconnectSuccess' | 'mcpSaved' | 'mcpDeleted' | 'mcpTick' | null
  modelFailed: boolean
  initializingModel: boolean
  browserBlocked: boolean
  navigationFailed: boolean
  authorizationIds: ConnectionId[]
  /** User-defined MCP servers with their live state; `null` until the first read settles. */
  mcpServers: CustomMcpServerView[] | null
  loadingMcp: boolean
  mcpFailed: boolean
  /** Result of the last connection test, shown in the editor; `null` when none ran. */
  mcpProbe: McpServerProbe | null
  probingMcp: boolean
  /** Host-supplied reason the last MCP write or read failed; `null` when none did. */
  mcpError: string | null
}
/** Host calls and external navigation required by the product presenter. */
export interface ProductApi {
  profile(this: void): Promise<AccountProfile | null>
  /**
   * Begin one sign-in and open its authorization in the reserved browser tab.
   * @returns after authorization is presented or an actionable failure is recorded.
   */
  start(this: void): Promise<AccountView>
  /**
   * Cancel only the observed authorization attempt.
   * @returns after the owning Host confirms cancellation.
   */
  cancel(this: void, id: SignInAttemptId): Promise<AccountView>
  /**
   * Sign out while fencing late replies from a replacement account.
   * @returns whether the owning account was signed out.
   */
  signOut(this: void): Promise<AccountView>
  plans(this: void): Promise<Result<Plans>>
  connections(this: void): Promise<Result<Connections>>
  /**
   * Create or reopen one authorization and reconcile its server resource.
   * @param slug - configured service toolkit.
   * @param label - display name distinguishing this external account.
   * @returns whether an authorization resource is available.
   */
  connect(this: void,
    slug: string,
    label: string,
  ): Promise<
    Result<{ url: string; expiresAt: string; id: ConnectionId | null }>
  >
  /**
   * Disconnect one owned account and retain failures in its dialog.
   * @param id - current account’s connection identity.
   * @returns whether the server confirmed disconnection.
   */
  disconnect(this: void, id: ConnectionId): Promise<Result<null>>
  /**
   * Open the official commercial flow and reconcile only its target plan.
   * @param plan - owned or catalog plan, or null to browse.
   * @param purchase - whether the website should begin subscription selection.
   * @returns whether browser navigation succeeded.
   */
  billing(this: void, plan: PlanId | null, purchase: boolean): Promise<Result<string>>
  open(this: void, url: string): Promise<void>
  /**
   * Join initialization requests for the current account model.
   * @returns after model setup succeeds or its retry state is published.
   */
  initializeModel(this: void): Promise<boolean>
  /**
   * Read every user-defined MCP server with its live connection state.
   * @returns the owned definitions, or a credential-free failure category.
   */
  mcpServers(this: void): Promise<McpResult<CustomMcpServerView[]>>
  /**
   * Create or replace one user-defined MCP server.
   * @param input - complete definition; non-empty header and env values are stored as credentials.
   * @returns the stored definition with its live state.
   */
  saveMcpServer(this: void, input: McpServerInput): Promise<McpResult<CustomMcpServerView>>
  /**
   * Remove one user-defined MCP server and withdraw its tools.
   * @param name - server key.
   * @returns after the Host confirms removal.
   */
  deleteMcpServer(this: void, name: string): Promise<McpResult<null>>
  /**
   * Connect or disconnect one stored definition without editing it.
   * @param name - server key.
   * @param enabled - whether the server should hold a live connection.
   * @returns the stored definition with its live state.
   */
  setMcpEnabled(this: void, name: string, enabled: boolean): Promise<McpResult<CustomMcpServerView>>
  /**
   * Test a definition without saving it.
   * @param input - complete definition to try.
   * @returns the probe outcome, including advertised tool names.
   */
  probeMcpServer(this: void, input: McpServerInput, signal?: AbortSignal): Promise<McpResult<McpServerProbe>>
}
const initial = (): ProductSnapshot => ({
  view: null,
  profile: null,
  profilePreviouslyVerified: false,
  initialized: false,
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
})

/** Each account generation owns its outstanding reads and actions. */
export class ProductModel {
  /**
   * Observable current-account state; invalidated on identity replacement.
   */
  readonly state = createSnapshotStore<ProductSnapshot>(initial())
  private generation = 0
  private profileRequest: Promise<void> | undefined
  private planRequest: Promise<void> | undefined
  private connectionRequest: Promise<void> | undefined
  private mcpRequest: Promise<void> | undefined
  /** Bumped by every MCP write, so a read that started before it never publishes. */
  private mcpRead = 0
  private initiated: SignInAttemptId | undefined
  private opened: SignInAttemptId | undefined
  private disposed = false
  constructor(
    private readonly api: ProductApi,
    private readonly handoffTimeoutMs: number,
  ) {}
  private planBeforeHandoff: string | undefined
  private pendingUntil = 0
  private initialization: Promise<void> | undefined
  private billingTarget: PlanId | null = null
  private readonly authorizations = new Map<
    string,
    { url: string; expiresAt: number; id: ConnectionId | null }
  >()
  private patch(value: Partial<ProductSnapshot>): void {
    if (!this.disposed)
      this.state.set({ ...this.state.getSnapshot(), ...value })
  }
  /**
   * Show an actionable browser navigation failure.
   * @param blocked - whether the browser rejected the popup.
   */
  reportNavigationFailure(blocked = false): void {
    this.patch({ navigationFailed: true, browserBlocked: blocked })
  }
  /**
   * Report a command failure owned by global feedback.
   */
  reportActionFailure(): void {
    this.patch({ actionFailed: 'global', feedback: null })
  }
  /**
   * Keep onboarding visible after account verification fails.
   */
  failAccount(): void {
    this.patch({ initialized: true, accountFailed: true })
  }
  /**
   * Discard data and pending response ownership when the account stream ends.
   */
  reset(): void {
    this.authorizations.clear()
    this.initialization = undefined
    this.planBeforeHandoff = undefined
    this.pendingUntil = 0
    this.generation++
    this.profileRequest = undefined
    this.planRequest = undefined
    this.connectionRequest = undefined
    this.mcpRequest = undefined
    this.state.set(initial())
  }
  /**
   * Apply a newer account observation without regressing an OAuth attempt.
   * @param view - Host-owned account state.
   */
  adopt(view: AccountView): void {
    const old = this.state.getSnapshot().view
    const phases: Record<string, number> = {
      initializing: 0,
      'waiting-browser': 1,
      exchanging: 2,
      committing: 3,
      succeeded: 4,
      cancelled: 4,
      expired: 4,
      failed: 4,
    }
    if (
      old?.attempt &&
      view.attempt?.id === old.attempt.id &&
      (phases[old.attempt.phase] ?? 0) > (phases[view.attempt.phase] ?? 0)
    )
      return
    const identityChanged =
      old?.status !== view.status ||
      old.attempt?.id !== view.attempt?.id ||
      old.credentialRevision !== view.credentialRevision
    if (identityChanged) {
      this.authorizations.clear()
      this.initialization = undefined
      this.planBeforeHandoff = undefined
      this.pendingUntil = 0
      this.generation++
      this.profileRequest = undefined
      this.planRequest = undefined
      this.connectionRequest = undefined
      this.mcpRequest = undefined
    }
    this.patch({
      view,
      initialized: true,
      starting: false,
      ...(identityChanged
        ? {
          profile: null,
          plans: null,
          connections: null,
          accountFailed: false,
          plansFailed: false,
          connectionsFailed: false,
          busy: null,
          handoff: null,
          connectedTarget: null,
          feedback: null,
          actionFailed: null,
          modelFailed: false,
          initializingModel: false,
          authorizationIds: [],
          navigationFailed: false,
          browserBlocked: false,
          mcpServers: null,
          loadingMcp: false,
          mcpFailed: false,
          mcpProbe: null,
          probingMcp: false,
          mcpError: null,
        }
        : {}),
    })
    if (view.status === 'credential-stored' && (identityChanged || (this.state.getSnapshot().profile === null && !this.state.getSnapshot().accountFailed))) void this.refreshProfile()
    if (
      view.attempt?.phase === 'waiting-browser' &&
      view.attempt.id === this.initiated
    )
      void this.openLogin(view)
  }
  private async openLogin(view: AccountView, again = false): Promise<void> {
    const attempt = view.attempt
    if (
      attempt?.authorizeUrl === undefined ||
      (!again && this.opened === attempt.id)
    )
      return
    this.opened = attempt.id
    const generation = this.generation
    try {
      await this.api.open(attempt.authorizeUrl)
    } catch (_error) {
      if (generation === this.generation)
        this.patch({ actionFailed: 'sign-in' })
    }
  }
  /**
   * Begin a browser login owned by the current account observation.
   * @returns after the login attempt and initial browser handoff settle.
   */
  async start(): Promise<void> {
    if (this.state.getSnapshot().starting) return
    const before = this.state.getSnapshot().view
    this.patch({ starting: true, actionFailed: null, feedback: null })
    try {
      const view = await this.api.start()
      const current = this.state.getSnapshot().view
      if (current !== before && current?.attempt?.id !== view.attempt?.id)
        return
      this.initiated = view.attempt?.id
      this.adopt(view)
      const adopted = this.state.getSnapshot().view
      if (adopted?.attempt?.phase === 'waiting-browser')
        await this.openLogin(adopted)
    } catch (_error) {
      if (this.state.getSnapshot().view === before)
        this.patch({ starting: false, actionFailed: 'sign-in' })
    }
  }
  /**
   * Reopen the current authorization without creating another attempt.
   * @returns after the browser handoff settles.
   */
  async reopen(): Promise<void> {
    const view = this.state.getSnapshot().view
    if (view) await this.openLogin(view, true)
  }
  /**
   * Cancel only the currently observed browser login attempt.
   * @returns after cancellation is confirmed or its local failure is shown.
   */
  async cancel(): Promise<void> {
    const generation = this.generation
    const attempt = this.state.getSnapshot().view?.attempt
    if (attempt)
      try {
        const view = await this.api.cancel(attempt.id)
        if (generation === this.generation) this.adopt(view)
      } catch (_error) {
        if (generation === this.generation)
          this.patch({ actionFailed: 'sign-in' })
      }
  }
  /**
   * Revoke the current login without overwriting a newer account.
   * @returns whether the Host confirmed sign-out.
   */
  async signOut(): Promise<boolean> {
    const generation = this.generation
    this.patch({ busy: 'signout', actionFailed: null, feedback: null })
    try {
      const view = await this.api.signOut()
      if (generation === this.generation) this.adopt(view)
      return view.status === 'signed-out'
    } catch (_error) {
      if (generation === this.generation)
        this.patch({ busy: null, actionFailed: 'sign-out' })
      return false
    }
  }
  /**
   * Join initialization of the account-authorized inference model.
   * @returns after the current initialization settles.
   */
  initializeModel(): Promise<void> {
    if (this.initialization) return this.initialization
    const generation = this.generation
    this.patch({ initializingModel: true, modelFailed: false })
    const task = (async () => {
      try {
        const ready = await this.api.initializeModel()
        if (generation === this.generation)
          this.patch({ modelFailed: !ready, initializingModel: false })
      } catch (_error) {
        if (generation === this.generation)
          this.patch({ modelFailed: true, initializingModel: false })
      }
    })().finally(() => {
      if (this.initialization === task) this.initialization = undefined
    })
    this.initialization = task
    return task
  }

  /**
   * Join account reads and ignore responses from an older login.
   * @returns after the current profile observation settles.
   */
  refreshProfile(): Promise<void> {
    if (this.profileRequest) return this.profileRequest
    const generation = this.generation
    const task = (async () => {
      try {
        const profile = await this.api.profile()
        if (generation !== this.generation) return
        if (profile === null) {
          this.patch({ accountFailed: true })
          return
        }
        const previous = this.state.getSnapshot().profile
        if (previous !== null && previous.id !== profile.id) {
          this.generation++
          this.planRequest = undefined
          this.connectionRequest = undefined
          this.mcpRequest = undefined
          this.patch({ plans: null, connections: null })
        }
        this.patch({ profile, profilePreviouslyVerified: true, accountFailed: false })
        void this.loadPlans()
        void this.loadConnections()
        void this.loadMcpServers()
        if (previous === null) void this.initializeModel()
      } catch (_error) {
        if (generation === this.generation) this.patch({ accountFailed: true })
      }
    })().finally(() => {
      if (this.profileRequest === task) this.profileRequest = undefined
    })
    this.profileRequest = task
    return task
  }
  /**
   * Refresh owned subscriptions while retaining the last valid projection.
   * @returns after the current account plan read settles.
   */
  loadPlans(): Promise<void> {
    if (this.planRequest) return this.planRequest
    const generation = this.generation
    this.patch({ loadingPlans: true, plansFailed: false })
    const task = (async () => {
      try {
        const result = await this.api.plans()
        if (generation !== this.generation) return
        if (result.ok) {
          const changed =
            this.planBeforeHandoff !== undefined &&
            this.planSignature(result.data, this.billingTarget) !==
              this.planBeforeHandoff
          this.patch({
            plans: result.data,
            loadingPlans: false,
            ...(changed ? { handoff: null } : {}),
          })
        } else this.patch({ plansFailed: true, loadingPlans: false })
      } catch (_error) {
        if (generation === this.generation)
          this.patch({ plansFailed: true, loadingPlans: false })
      }
    })().finally(() => {
      if (this.planRequest === task) this.planRequest = undefined
    })
    this.planRequest = task
    return task
  }
  /**
   * Reconcile exact authorization identities against server data.
   * @returns after the current account connection read settles.
   */
  loadConnections(): Promise<void> {
    if (this.connectionRequest) return this.connectionRequest
    const generation = this.generation
    this.patch({ loadingConnections: true, connectionsFailed: false })
    const task = (async () => {
      try {
        const result = await this.api.connections()
        if (generation !== this.generation) return
        if (result.ok) {
          const authorizationIds = result.data.accounts
            .filter((a) => {
              const link = this.authorizations.get(a.toolkit + '\0' + a.label)
              return link !== undefined && link.expiresAt > Date.now()
            })
            .map(a => a.id)
          const target = this.state.getSnapshot().connectedTarget
          const complete =
            target &&
            result.data.accounts.some(
              a =>
                (target.id
                  ? a.id === target.id
                  : a.toolkit === target.toolkit && a.label === target.label) &&
                a.status === 'connected',
            )
          if (
            this.pendingUntil === 0 &&
            result.data.accounts.some(a => a.status === 'pending')
          )
            this.pendingUntil = Date.now() + this.handoffTimeoutMs
          this.patch({
            connections: result.data,
            loadingConnections: false,
            authorizationIds,
            ...(complete
              ? {
                handoff: null,
                connectedTarget: null,
                feedback: 'connectionSuccess' as const,
              }
              : {}),
          })
        } else
          this.patch({ connectionsFailed: true, loadingConnections: false })
      } catch (_error) {
        if (generation === this.generation)
          this.patch({ connectionsFailed: true, loadingConnections: false })
      }
    })().finally(() => {
      if (this.connectionRequest === task) this.connectionRequest = undefined
    })
    this.connectionRequest = task
    return task
  }
  private planSignature(plans: Plans, target: PlanId | null): string {
    return JSON.stringify(
      plans.subscriptions.filter(s => s.planId === target),
    )
  }
  /**
   * Read the owned MCP definitions and join a read already in flight.
   * @returns after the current account's definition read settles.
   */
  loadMcpServers(): Promise<void> {
    if (this.mcpRequest) return this.mcpRequest
    const generation = this.generation
    const read = ++this.mcpRead
    this.patch({ loadingMcp: true, mcpFailed: false })
    const task = (async () => {
      try {
        const result = await this.api.mcpServers()
        if (generation !== this.generation || read !== this.mcpRead) return
        if (result.ok)
          this.patch({ mcpServers: result.data, loadingMcp: false, mcpError: null })
        else
          this.patch({ mcpFailed: true, loadingMcp: false, mcpError: result.message })
      } catch (_error) {
        if (generation === this.generation && read === this.mcpRead)
          this.patch({ mcpFailed: true, loadingMcp: false })
      }
    })().finally(() => {
      if (this.mcpRequest === task) this.mcpRequest = undefined
    })
    this.mcpRequest = task
    return task
  }
  /**
   * Re-read after a write. A read already in flight started before the write,
   * so it must not publish its stale answer.
   * @returns after the fresh read settles.
   */
  private reloadMcpServers(): Promise<void> {
    this.mcpRead += 1
    this.mcpRequest = undefined
    return this.loadMcpServers()
  }
  /**
   * Create or replace one definition, then reconcile the confirmed list.
   * @param input - complete definition; secret values are stored by the Host.
   * @returns whether the Host stored the definition.
   */
  async saveMcpServer(input: McpServerInput): Promise<boolean> {
    if (this.state.getSnapshot().busy !== null) return false
    const generation = this.generation
    this.patch({ busy: 'mcp:save', actionFailed: null, feedback: null, mcpProbe: null })
    try {
      const result = await this.api.saveMcpServer(input)
      if (generation !== this.generation) return false
      if (!result.ok) {
        this.patch({ actionFailed: 'mcp-save', mcpError: result.message })
        return false
      }
      this.patch({ feedback: 'mcpSaved', mcpProbe: null, mcpError: null })
      await this.reloadMcpServers()
      return true
    } catch (_error) {
      if (generation === this.generation) this.patch({ actionFailed: 'mcp-save' })
      return false
    } finally {
      if (generation === this.generation) this.patch({ busy: null })
    }
  }
  /**
   * Remove one definition and withdraw its tools.
   * @param name - server key.
   * @returns whether the Host confirmed removal.
   */
  async deleteMcpServer(name: string): Promise<boolean> {
    if (this.state.getSnapshot().busy !== null) return false
    const generation = this.generation
    this.patch({ busy: 'mcp:' + name, actionFailed: null, feedback: null })
    try {
      const result = await this.api.deleteMcpServer(name)
      if (generation !== this.generation) return false
      if (!result.ok) {
        this.patch({ actionFailed: 'mcp-delete', mcpError: result.message })
        return false
      }
      this.patch({ feedback: 'mcpDeleted', mcpProbe: null, mcpError: null })
      await this.reloadMcpServers()
      return true
    } catch (_error) {
      if (generation === this.generation) this.patch({ actionFailed: 'mcp-delete' })
      return false
    } finally {
      if (generation === this.generation) this.patch({ busy: null })
    }
  }
  /**
   * Connect or disconnect one stored definition without editing it.
   * @param name - server key.
   * @param enabled - whether the server should hold a live connection.
   * @returns whether the Host applied the change.
   */
  async setMcpEnabled(name: string, enabled: boolean): Promise<boolean> {
    if (this.state.getSnapshot().busy !== null) return false
    const generation = this.generation
    this.patch({ busy: 'mcp:' + name, actionFailed: null, feedback: null })
    try {
      const result = await this.api.setMcpEnabled(name, enabled)
      if (generation !== this.generation) return false
      if (!result.ok) {
        this.patch({ actionFailed: 'mcp-toggle', mcpError: result.message })
        return false
      }
      this.patch({ feedback: enabled ? 'mcpTick' : null, mcpError: null })
      await this.reloadMcpServers()
      return true
    } catch (_error) {
      if (generation === this.generation) this.patch({ actionFailed: 'mcp-toggle' })
      return false
    } finally {
      if (generation === this.generation) this.patch({ busy: null })
    }
  }
  /**
   * Test one definition without saving it.
   * @param input - complete definition to try.
   * @returns whether the probe ran; its outcome is published either way.
   */
  async probeMcpServer(input: McpServerInput): Promise<boolean> {
    if (this.state.getSnapshot().probingMcp) return false
    const generation = this.generation
    this.patch({ probingMcp: true, mcpProbe: null, mcpError: null })
    try {
      const result = await this.api.probeMcpServer(input)
      if (generation !== this.generation) return false
      this.patch(
        result.ok
          ? { probingMcp: false, mcpProbe: result.data, mcpError: null }
          : { probingMcp: false, mcpProbe: null, mcpError: result.message },
      )
      return result.ok
    } catch (_error) {
      if (generation === this.generation)
        this.patch({ probingMcp: false, mcpProbe: null, mcpError: null })
      return false
    }
  }
  /**
   * Drop the last probe outcome when the editor closes or its definition changes.
   */
  clearMcpProbe(): void {
    this.patch({ mcpProbe: null, mcpError: null })
  }
  /**
   * Expire completed browser handoff budgets before scheduling another read.
   * @param now - current wall-clock milliseconds.
   * @returns whether a bounded reconciliation is still active.
   */
  shouldPoll(now: number): boolean {
    const state = this.state.getSnapshot()
    if (state.handoff !== null && now >= state.handoffUntil)
      this.patch({ handoff: null, connectedTarget: null })
    return (
      this.state.getSnapshot().handoff !== null ||
      (now < this.pendingUntil &&
        state.connections?.accounts.some(a => a.status === 'pending') ===
          true) ||
      state.mcpServers?.some(
        server =>
          server.status.state === 'connecting' ||
          server.status.state === 'reconnecting',
      ) === true
    )
  }
  private async action(
    id: string,
    work: () => Promise<Result<string | null>>,
    handoff: 'connection' | 'billing' | null,
    failure: 'disconnect' | 'global',
  ): Promise<boolean> {
    if (this.state.getSnapshot().busy !== null) return false
    const generation = this.generation
    this.patch({ busy: id, actionFailed: null, feedback: null })
    try {
      const result = await work()
      if (generation !== this.generation) return false
      if (!result.ok) {
        this.patch({ actionFailed: failure })
        return false
      }
      if (result.data !== null) await this.api.open(result.data)
      if (generation !== this.generation) return false
      this.patch({ handoff, handoffUntil: Date.now() + this.handoffTimeoutMs })
      if (handoff !== 'billing') await this.loadConnections()
      return true
    } catch (_error) {
      if (generation === this.generation) this.patch({ actionFailed: failure })
      return false
    } finally {
      if (generation === this.generation) this.patch({ busy: null })
    }
  }
  /**
   * Authorize a labelled service account and reconcile its server-owned state.
   * @param slug - configured service toolkit.
   * @param label - name distinguishing this account from other connections.
   * @returns whether the authorization link was opened successfully.
   */
  async connect(slug: string, label: string): Promise<boolean> {
    if (this.state.getSnapshot().busy !== null) return false
    const generation = this.generation
    const key = slug + '\0' + label
    this.patch({
      busy: slug,
      actionFailed: null,
      feedback: null,
      navigationFailed: false,
      browserBlocked: false,
    })
    let created = false
    try {
      let link = this.authorizations.get(key)
      if (!link || link.expiresAt <= Date.now()) {
        const result = await this.api.connect(slug, label)
        if (generation !== this.generation) return false
        if (!result.ok) {
          this.patch({ actionFailed: 'connect' })
          return false
        }
        link = {
          url: result.data.url,
          expiresAt: Date.parse(result.data.expiresAt),
          id: result.data.id,
        }
        this.authorizations.set(key, link)
      }
      created = true
      this.patch({
        connectedTarget: { id: link.id, toolkit: slug, label },
        handoff: 'connection',
        handoffUntil: Math.min(
          link.expiresAt,
          Date.now() + this.handoffTimeoutMs,
        ),
      })
      try {
        await this.api.open(link.url)
      } catch (_error) {
        if (generation === this.generation)
          this.patch({ navigationFailed: true })
      }
      return true
    } catch (_error) {
      if (generation === this.generation)
        this.patch({ actionFailed: 'connect' })
      return false
    } finally {
      if (generation === this.generation) {
        await this.loadConnections()
        if (generation === this.generation)
          this.patch({ busy: null, ...(created ? {} : { handoff: null }) })
      }
    }
  }
  /**
   * Reopen a remembered link without repeating an authorization write.
   * @param id - current account’s connection identity.
   * @returns after browser navigation settles.
   */
  async reopenConnection(id: ConnectionId): Promise<void> {
    const account = this.state
      .getSnapshot()
      .connections?.accounts.find(a => a.id === id)
    const link = account
      ? this.authorizations.get(account.toolkit + '\0' + account.label)
      : undefined
    if (!link || link.expiresAt <= Date.now()) {
      this.patch({ actionFailed: 'global' })
      return
    }
    const generation = this.generation
    try {
      await this.api.open(link.url)
      if (generation === this.generation)
        this.patch({
          navigationFailed: false,
          browserBlocked: false,
          handoff: 'connection',
          handoffUntil: Math.min(
            link.expiresAt,
            Date.now() + this.handoffTimeoutMs,
          ),
        })
    } catch (_error) {
      if (generation === this.generation) this.patch({ navigationFailed: true })
    }
  }

  /**
   * Remove one connection and refresh the confirmed server-owned list.
   * @param id - opaque identity of the selected service account.
   * @returns whether disconnection was confirmed.
   */
  async disconnect(id: ConnectionId): Promise<boolean> {
    const success = await this.action(
      id,
      () => this.api.disconnect(id),
      null,
      'disconnect',
    )
    if (success) {
      const remaining = this.state.getSnapshot().connections?.accounts
      for (const [key, link] of this.authorizations)
        if (
          link.id === id ||
          !remaining?.some(a => a.toolkit + '\0' + a.label === key)
        )
          this.authorizations.delete(key)
      this.patch({
        feedback: 'disconnectSuccess',
        connectedTarget: null,
        handoff: null,
      })
    }
    return success
  }
  /**
   * Open official plan management and reconcile the selected subscription.
   * @param plan - selected plan, or null for the complete catalog.
   * @param purchase - begin the website subscription flow.
   * @returns whether the trusted website was opened successfully.
   */
  billing(plan: PlanId | null, purchase: boolean): Promise<boolean> {
    const plans = this.state.getSnapshot().plans
    this.billingTarget = plan
    this.planBeforeHandoff =
      plans && purchase ? this.planSignature(plans, plan) : undefined
    return this.action(
      plan ?? 'billing',
      () => this.api.billing(plan, purchase),
      purchase ? 'billing' : null,
      'global',
    )
  }
  /**
   * Dismiss feedback without cancelling resource reconciliation.
   */
  dismiss(): void {
    this.patch({
      actionFailed: null,
      feedback: null,
      navigationFailed: false,
      browserBlocked: false,
    })
  }
  /**
   * Invalidate pending work when the owning Client plugin unloads.
   */
  dispose(): void {
    this.disposed = true
    this.generation++
  }
}
