/**
 * Dynamic connection tools: one search turns a provider's own tool definitions
 * into callable tools in the current conversation, so an integration task can
 * search and then act in the same request with the provider's real names and
 * argument schemas.
 *
 * Each registered tool keeps the connection and version its own search
 * resolved, so a later search cannot redirect an earlier call. The provider's
 * JSON Schema is projected onto the enforced tool-schema subset before
 * registration: keywords the harness does not enforce are dropped rather than
 * forwarded, so an upstream schema cannot change how arguments are validated. A
 * Oversized definitions lose annotations first; a definition still too large
 * keeps an unconstrained argument schema and stays callable.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One account or public service a search may query. */
export interface ConnectionTarget {
  /** Opaque account identity the product API accepts. */
  id: string
  /** Provider catalog slug; also the tool-name namespace. */
  toolkit: string
  /** User-facing account or service name. */
  label: string
}

/** The signed-in user's usable connections. */
export interface ConnectionCatalog {
  /** Whether the product API offers connections at all. */
  available: boolean
  /** Owned accounts whose reported status is connected. */
  accounts: ConnectionTarget[]
  /** Services that need no credentials. */
  publicServices: ConnectionTarget[]
}

/** One provider tool definition, as the product API returns it. */
export interface DiscoveredTool {
  /** Provider tool slug, unique within its toolkit. */
  slug: string
  /** Provider display name. */
  name: string
  /** Provider description of what the action does. */
  description: string
  /** Pinned provider tool version; every execution reuses it. */
  version: string
  /** Provider JSON Schema for the tool arguments. */
  parameters: unknown
}

/** The product methods dynamic discovery uses. */
export interface ConnectionProduct {
  /**
   * Read the account's connections.
   * @param signal - tool cancellation.
   * @returns JSON text with the available accounts and public services.
   */
  listAgentConnections(signal: AbortSignal): Promise<string>
  /**
   * Search one target's tools.
   * @param connectionId - opaque account identity.
   * @param query - capability description.
   * @param signal - tool cancellation.
   * @returns JSON text with the discovered definitions.
   */
  searchAgentConnections(connectionId: string, query: string, signal: AbortSignal): Promise<string>
  /**
   * Execute one discovered action.
   * @param input - pinned tool, owned connection, and arguments.
   * @param signal - tool cancellation.
   * @returns the provider's JSON text.
   */
  executeAgentConnection(
    input: { connectionId: string; slug: string; version: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<string>
}

/** Budgets that keep one search's model-visible surface bounded. */
export interface DiscoveryBudgets {
  /** Most tools one search registers. */
  maxTools: number
  /** Most connections one search queries. */
  maxTargets: number
  /** Largest argument schema, in bytes, declared to the model. */
  maxSchemaBytes: number
  /** Longest tool description declared to the model. */
  maxDescriptionChars: number
  /** Budget for one registered tool call. */
  timeoutMs: number
}

/** One tool that is callable after the search. */
export interface ReadyTool {
  /** Model-facing tool name to call. */
  tool: string
  /** Provider catalog slug. */
  toolkit: string
  /** Account or service name the call runs against. */
  account: string
  /** Pinned provider tool version. */
  version: string
  /** Whether this search added the tool, replaced an older version, or found it mounted. */
  status: 'added' | 'updated' | 'ready'
  /** Provider description, bounded for the transcript. */
  description: string
}

/** A toolkit this call did not search because several accounts could serve it. */
export interface AmbiguousToolkit {
  toolkit: string
  accounts: { id: string; label: string }[]
}

/** One target whose search failed. */
export interface FailedSearch {
  toolkit: string
  connectionId: string
  /** Bounded failure category; never an upstream body. */
  code: string
}

/** The model-facing outcome of one search. */
export interface DiscoveryOutcome {
  tools: ReadyTool[]
  ambiguous: AmbiguousToolkit[]
  failed: FailedSearch[]
  /** Toolkit slugs this call skipped because of its target budget. */
  notSearched: string[]
  /** One actionable sentence about the outcome. */
  note: string
}

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_NAME_LENGTH = 64
/** DeepSeek function-name contract: only these characters are accepted. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex characters of the identity hash appended on lossy normalization. */
const HASH_LENGTH = 12
/** Hex characters that separate two accounts of one toolkit. */
const ACCOUNT_HASH_LENGTH = 8
/** Deepest provider schema node this projection follows. */
const MAX_SCHEMA_DEPTH = 12
/** Types the enforced subset accepts. */
const SCHEMA_TYPES: readonly string[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
/** Types that may carry `enum` or `const`. */
const SCALAR_TYPES: readonly string[] = ['string', 'number', 'integer', 'boolean', 'null']
/** A scalar literal accepted by `enum` and `const`. */
type SchemaScalar = string | number | boolean | null

/** Narrow one JSON value to a plain string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read model-supplied arguments as a record; a non-object call sends no arguments. */
function asArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Whether a candidate is a finite JSON number the subset accepts. */
function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

/** Whether a value is valid for one declared scalar type. */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/** Keep the literal values that agree with one declared scalar type. */
function literals(value: unknown, type: string): SchemaScalar[] {
  if (!Array.isArray(value)) return []
  return value.filter(entry => matchesType(type, entry)) as SchemaScalar[]
}

/** Copy the annotations the subset keeps. */
function annotations(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if (typeof source.description === 'string') target.description = source.description
  if (typeof source.title === 'string') target.title = source.title
}

/** Project one provider property map; a non-record value yields no properties. */
function propertiesOf(value: unknown, depth: number, root: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).map(([key, schema]) => [key, projectNode(schema, depth + 1, root)]))
}

/** Resolve a local JSON pointer in the provider's schema. */
function resolveReference(root: unknown, reference: string): unknown {
  if (!reference.startsWith('#/')) return undefined
  let value = root
  for (const segment of reference.slice(2).split('/')) {
    if (!isRecord(value)) return undefined
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

/**
 * Project one provider schema node onto the enforced subset.
 * @param candidate - provider schema node of unknown shape.
 * @param depth - nesting already followed.
 * @returns the projected node; past the depth bound it constrains nothing.
 */
export function sanitizeNode(candidate: unknown, depth: number): Record<string, unknown> {
  return projectNode(candidate, depth, candidate)
}

/** Project a node while retaining the document used for local references. */
function projectNode(candidate: unknown, depth: number, root: unknown): Record<string, unknown> {
  if (!isRecord(candidate) || depth > MAX_SCHEMA_DEPTH) return {}
  if (typeof candidate.$ref === 'string') {
    const resolved = resolveReference(root, candidate.$ref)
    if (resolved !== undefined) {
      const node = projectNode(resolved, depth + 1, root)
      annotations(candidate, node)
      return node
    }
  }
  const node: Record<string, unknown> = {}
  annotations(candidate, node)
  if (Array.isArray(candidate.oneOf)) {
    const branches = candidate.oneOf.filter(entry => isRecord(entry)).map(entry => projectNode(entry, depth + 1, root))
    if (branches.length >= 2) {
      node.oneOf = branches
      return node
    }
  }
  if (Array.isArray(candidate.anyOf)) {
    const branches = candidate.anyOf.filter(entry => isRecord(entry)).map(entry => projectNode(entry, depth + 1, root))
    const types = branches.map(branch => branch.type)
    // Disjoint JSON types make anyOf equivalent to the supported oneOf.
    if (branches.length >= 2 && types.every(type => typeof type === 'string') && new Set(types).size === types.length &&
      !(types.includes('number') && types.includes('integer'))) {
      node.oneOf = branches
      return node
    }
  }
  const declared = typeof candidate.type === 'string' && SCHEMA_TYPES.includes(candidate.type)
    ? candidate.type
    : undefined
  if (declared === undefined) return node
  node.type = declared
  if (declared === 'object') {
    const properties = propertiesOf(candidate.properties, depth, root)
    if (properties !== undefined) node.properties = properties
    if (Array.isArray(candidate.required) && properties !== undefined) {
      const declaredKeys = new Set(Object.keys(properties))
      const required = [...new Set(candidate.required.filter(
        (key): key is string => typeof key === 'string' && declaredKeys.has(key),
      ))]
      if (required.length > 0) node.required = required
    }
    if (typeof candidate.additionalProperties === 'boolean') node.additionalProperties = candidate.additionalProperties
    return node
  }
  if (declared === 'array') {
    if (candidate.items !== undefined) node.items = projectNode(candidate.items, depth + 1, root)
    return node
  }
  if (SCALAR_TYPES.includes(declared)) {
    const values = literals(candidate.enum, declared)
    if (values.length > 0) node.enum = values
    if (matchesType(declared, candidate.const)) node.const = candidate.const
  }
  return node
}

/** Remove annotations before giving up on an oversized provider schema. */
function compactSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { description: _description, title: _title, ...compact } = schema
  if (isRecord(compact.properties)) {
    compact.properties = Object.fromEntries(Object.entries(compact.properties).map(([key, value]) =>
      [key, isRecord(value) ? compactSchema(value) : value]))
  }
  if (isRecord(compact.items)) compact.items = compactSchema(compact.items)
  if (Array.isArray(compact.oneOf)) {
    compact.oneOf = compact.oneOf.map((value: unknown) => isRecord(value) ? compactSchema(value) : value)
  }
  return compact
}

/**
 * Derive the model-facing name for one connection tool.
 *
 * The clean case is `connection__<toolkit>__<slug>`. Character replacement or
 * truncation to the function-name contract appends a hash of that identity, so
 * two provider tools never collapse into one name.
 * @param toolkit - provider catalog slug.
 * @param slug - provider tool slug, optionally carrying an account discriminator.
 * @returns the model-facing tool name.
 */
export function connectionToolName(toolkit: string, slug: string): string {
  const joined = `connection__${toolkit}__${slug}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${toolkit}\0${slug}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** A short stable discriminator for one account, used when a toolkit has several. */
function accountDiscriminator(connectionId: string): string {
  return createHash('sha256').update(connectionId).digest('hex').slice(0, ACCOUNT_HASH_LENGTH)
}

/** Compose the declaration description: provider identity first, then what the action does. */
function boundedDescription(tool: DiscoveredTool, toolkit: string, label: string, limit: number): string {
  const text = `[${toolkit} · ${label}] ${tool.name === '' ? tool.slug : tool.name}: ${tool.description}`.trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** One mounted registration and the account it serves. */
interface MountedTool {
  readonly connectionId: string
  readonly version: string
  readonly dispose: () => void
}

/**
 * Owns the tools one search registers in one Agent scope. A name that already
 * serves a different account is never reused, so a later search cannot redirect
 * an earlier tool call to another account.
 */
export class ConnectionToolRegistry {
  private readonly mounted = new Map<string, MountedTool>()
  private readonly scope: Context
  private readonly product: ConnectionProduct
  private readonly budgets: DiscoveryBudgets

  /**
   * @param scope - Agent scope whose tool registry receives the definitions.
   * @param product - product methods the registered tools execute through.
   * @param budgets - declaration and execution budgets.
   */
  constructor(scope: Context, product: ConnectionProduct, budgets: DiscoveryBudgets) {
    this.scope = scope
    this.product = product
    this.budgets = budgets
  }

  /** The name serving this account's tool, or a fresh one when another account holds it. */
  private nameFor(target: ConnectionTarget, tool: DiscoveredTool): string {
    const base = connectionToolName(target.toolkit, tool.slug)
    const held = this.mounted.get(base)
    if (held === undefined || held.connectionId === target.id) return base
    return connectionToolName(target.toolkit, `${tool.slug}_${accountDiscriminator(target.id)}`)
  }

  /**
   * Register one discovered tool, replacing an older version of the same action.
   * @param target - account or public service the tool runs against.
   * @param tool - provider definition to register.
   * @returns the model-facing name and how this call changed it.
   */
  install(target: ConnectionTarget, tool: DiscoveredTool): { tool: string; status: ReadyTool['status'] } {
    const name = this.nameFor(target, tool)
    const held = this.mounted.get(name)
    if (held !== undefined && held.connectionId !== target.id) {
      throw new Error(`connection tool name "${name}" already serves another account`)
    }
    if (held !== undefined) {
      if (held.version === tool.version) return { tool: name, status: 'ready' }
      held.dispose()
      this.mounted.delete(name)
    }
    const schema = this.declaredSchema(tool)
    const definition: ToolDefinition = {
      name,
      description: boundedDescription(tool, target.toolkit, target.label, this.budgets.maxDescriptionChars),
      parameters: schema,
      output: {
        schema: {},
        render: (_args: unknown, value: JsonValue) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
        ],
      },
      timeoutMs: this.budgets.timeoutMs,
      execute: async (args: unknown, exec) =>
        this.product.executeAgentConnection(
          { connectionId: target.id, slug: tool.slug, version: tool.version, arguments: asArguments(args) },
          exec.signal,
        ),
      presentCall: () => ({ card: 'generic', title: `${target.toolkit} · ${tool.name}`, kind: 'execute' }),
    }
    this.mounted.set(name, {
      connectionId: target.id,
      version: tool.version,
      dispose: this.scope.tools.register(definition),
    })
    return { tool: name, status: held === undefined ? 'added' : 'updated' }
  }

  /** Project the provider schema, dropping annotations before using an open argument schema. */
  private declaredSchema(tool: DiscoveredTool): Record<string, unknown> {
    let projected = sanitizeNode(tool.parameters, 0)
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > this.budgets.maxSchemaBytes) {
      projected = compactSchema(projected)
      if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > this.budgets.maxSchemaBytes) return {}
    }
    try {
      assertSupportedJsonSchema(projected)
      return projected
    } catch {
      return {}
    }
  }

  /** Withdraw every tool this registry registered. */
  dispose(): void {
    for (const held of this.mounted.values()) held.dispose()
    this.mounted.clear()
  }
}

/** Read the account listing. */
function parseCatalog(text: string): ConnectionCatalog {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error('the connection listing could not be read')
  const targets = (value: unknown): ConnectionTarget[] => {
    if (!Array.isArray(value)) return []
    const out: ConnectionTarget[] = []
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.toolkit !== 'string') continue
      if (entry.id === '' || entry.toolkit === '') continue
      out.push({
        id: entry.id,
        toolkit: entry.toolkit,
        label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.toolkit,
      })
    }
    return out
  }
  const connected = Array.isArray(parsed.accounts)
    ? parsed.accounts.filter(entry => isRecord(entry) && entry.status === 'connected')
    : []
  return {
    available: parsed.available !== false,
    accounts: targets(connected),
    publicServices: targets(parsed.publicServices),
  }
}

/** Read one search response, dropping entries that cannot be executed. */
function parseTools(text: string): DiscoveredTool[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('the tool search could not be read')
  const out: DiscoveredTool[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.slug !== 'string' || entry.slug === '') continue
    if (typeof entry.version !== 'string' || !/^[0-9]{8}_[0-9]{2}$/.test(entry.version)) continue
    out.push({
      slug: entry.slug,
      name: typeof entry.name === 'string' ? entry.name : entry.slug,
      description: typeof entry.description === 'string' ? entry.description : '',
      version: entry.version,
      parameters: entry.parameters,
    })
  }
  return out
}

/** The targets one search queries, plus the toolkits it must not guess between. */
interface TargetSelection {
  targets: ConnectionTarget[]
  ambiguous: AmbiguousToolkit[]
}

/** Pick which connections one search queries. */
function selectTargets(
  catalog: ConnectionCatalog,
  request: { connectionId?: string; toolkit?: string },
): TargetSelection {
  // Connected accounts take priority over the potentially large public catalog.
  // A public entry for the same toolkit must not make an owned account ambiguous.
  const connectedToolkits = new Set(catalog.accounts.map(target => target.toolkit))
  const all = [
    ...catalog.accounts,
    ...catalog.publicServices.filter(target => !connectedToolkits.has(target.toolkit)),
  ]
  if (request.connectionId !== undefined) {
    const chosen = [...catalog.accounts, ...catalog.publicServices].find(target => target.id === request.connectionId)
    if (chosen === undefined) {
      throw new Error('that connection is not available; call connections_list and use one of its IDs')
    }
    return { targets: [chosen], ambiguous: [] }
  }
  const candidates = request.toolkit === undefined
    ? all
    : all.filter(target => target.toolkit === request.toolkit)
  const byToolkit = new Map<string, ConnectionTarget[]>()
  for (const target of candidates) {
    byToolkit.set(target.toolkit, [...byToolkit.get(target.toolkit) ?? [], target])
  }
  const targets: ConnectionTarget[] = []
  const ambiguous: AmbiguousToolkit[] = []
  for (const [toolkit, group] of byToolkit) {
    // Several accounts for one service is the user's choice, never a guess.
    if (group.length > 1) {
      ambiguous.push({ toolkit, accounts: group.map(target => ({ id: target.id, label: target.label })) })
      continue
    }
    targets.push(group[0] as ConnectionTarget)
  }
  if (request.toolkit !== undefined && candidates.length === 0) {
    throw new Error(`no connected account or public service provides "${request.toolkit}"`)
  }
  return { targets, ambiguous }
}

/** Compose the sentence the model acts on after one search. */
function noteFor(outcome: Omit<DiscoveryOutcome, 'note'>): string {
  const parts: string[] = []
  if (outcome.tools.length > 0) parts.push('These tools are callable in this conversation now; call them directly.')
  if (outcome.ambiguous.length > 0) {
    parts.push('Several accounts provide one of these services: ask the user which account to use, then search again with that connectionId.')
  }
  if (outcome.failed.length > 0) parts.push('A service search failed; retry once, and tell the user if it fails again.')
  if (outcome.notSearched.length > 0) {
    parts.push(`Not searched within this call's budget: ${outcome.notSearched.join(', ')}. Search one of them by toolkit.`)
  }
  if (parts.length === 0) {
    parts.push('No tool matched that description. Rephrase the capability, or search another service.')
  }
  return parts.join(' ')
}

/**
 * Search the user's connections for a task's tools and make them callable in the
 * current conversation.
 * @param options - product methods, the owning registry, budgets, the request, and cancellation.
 * @returns the model-facing outcome, including every tool now callable.
 */
export async function discoverConnectionTools(options: {
  product: ConnectionProduct
  registry: ConnectionToolRegistry
  budgets: DiscoveryBudgets
  request: { query: string; connectionId?: string; toolkit?: string }
  signal: AbortSignal
}): Promise<DiscoveryOutcome> {
  const { product, registry, budgets, request, signal } = options
  const catalog = parseCatalog(await product.listAgentConnections(signal))
  if (!catalog.available) {
    throw new Error('No service connections are available for this account. Ask the user to connect one on the Connections page.')
  }
  const selection = selectTargets(catalog, request)
  const queried = selection.targets.slice(0, budgets.maxTargets)
  const notSearched = selection.targets.slice(budgets.maxTargets).map(target => target.toolkit)
  const settled = await Promise.allSettled(queried.map(async target => ({
    target,
    tools: parseTools(await product.searchAgentConnections(target.id, request.query, signal)),
  })))
  signal.throwIfAborted()
  const failed: FailedSearch[] = []
  const tools: ReadyTool[] = []
  const registered = new Set<string>()
  for (const [index, result] of settled.entries()) {
    const target = queried[index] as ConnectionTarget
    if (result.status === 'rejected') {
      const code = (result.reason as { code?: unknown } | null)?.code
      failed.push({ toolkit: target.toolkit, connectionId: target.id, code: typeof code === 'string' ? code : 'request_failed' })
      continue
    }
    for (const tool of result.value.tools) {
      if (tools.length >= budgets.maxTools) break
      const key = `${target.toolkit}\u0000${tool.slug}`
      if (registered.has(key)) continue
      let installed: { tool: string; status: ReadyTool['status'] }
      try {
        installed = registry.install(target, tool)
      } catch {
        failed.push({ toolkit: target.toolkit, connectionId: target.id, code: 'name_conflict' })
        continue
      }
      registered.add(key)
      tools.push({
        tool: installed.tool,
        toolkit: target.toolkit,
        account: target.label,
        version: tool.version,
        status: installed.status,
        description: boundedDescription(tool, target.toolkit, target.label, budgets.maxDescriptionChars),
      })
    }
  }
  const outcome = { tools, ambiguous: selection.ambiguous, failed, notSearched }
  return { ...outcome, note: noteFor(outcome) }
}
