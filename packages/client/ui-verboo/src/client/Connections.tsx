/**
 * Connections page: owned service accounts, user-defined MCP servers, and the
 * service catalog. Every section reports its own live state; destructive
 * actions are confirmed, and definition secrets never return to the browser.
 *
 * @module
 */
import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageProps, ProductProps } from './contracts.ts'
import type { Connection, Toolkit } from '@deepseek-ai/dsh-api-verboo-product/types'
import type {
  CustomMcpServerView,
  CustomMcpStatus,
  McpServerInput,
  McpServerProbe,
  McpTransport,
} from '@deepseek-ai/dsh-api-verboo-mcp/types'
import type { Key } from './locales.ts'
import { Glyph } from './Glyph.tsx'
import { PageHead, Notice, Busy } from './PageParts.tsx'
import { CATEGORY_ORDER, categoryOf } from './categories.ts'
import type { CategoryId } from './categories.ts'
import css from './Product.module.css'

type GlyphName = Parameters<typeof Glyph>[0]['name']
type Tone = 'success' | 'pending' | 'danger' | 'muted'

/** Stable empty catalog used before the first read settles. */
const noToolkits: readonly Toolkit[] = []
/** Service marks reuse one glyph family; unknown toolkits fall back to a cable. */
const serviceGlyphs: Record<string, GlyphName> = {
  github: 'git-branch',
  gitlab: 'git-branch',
  bitbucket: 'git-branch',
  googledrive: 'folder',
  dropbox: 'folder',
  box: 'folder',
  onedrive: 'folder',
  notion: 'file-code-2',
  confluence: 'file-code-2',
  slack: 'workflow',
  teams: 'users-round',
  discord: 'workflow',
  gmail: 'mail',
  outlook: 'mail',
  googlecalendar: 'calendar-days',
  calendly: 'calendar-days',
  linear: 'kanban',
  jira: 'kanban',
  trello: 'kanban',
  asana: 'list-checks',
  clickup: 'list-checks',
  figma: 'figma',
  canva: 'figma',
  miro: 'layout-grid',
  airtable: 'database',
  postgres: 'database',
  mysql: 'database',
  mongodb: 'database',
  snowflake: 'database',
  bigquery: 'database',
  datadog: 'gauge',
  grafana: 'chart-no-axes-combined',
  hubspot: 'users-round',
  salesforce: 'users-round',
  stripe: 'credit-card',
  paypal: 'credit-card',
  quickbooks: 'credit-card',
  zendesk: 'circle-help',
  intercom: 'circle-help',
  vercel: 'globe',
  netlify: 'globe',
  aws: 'globe',
  sentry: 'circle-alert',
}

/** Service mark with a stable square so catalog rows and account rows align. */
/**
 * Show the catalog's brand mark for one service, falling back to the product
 * glyph when the catalog carries no mark or it fails to load. The adjacent
 * service name is the accessible label, so the mark is decorative.
 */
function ServiceIcon({ slug, logo }: { slug: string; logo?: string | undefined }) {
  const [unavailable, setUnavailable] = useState(false)
  if (logo === undefined || logo === '' || unavailable) {
    return (
      <span className={css.serviceIcon}>
        <Glyph name={serviceGlyphs[slug] ?? 'cable'} size={22} />
      </span>
    )
  }
  return (
    <span className={css.serviceIcon}>
      <img
        className={css.serviceLogo}
        src={logo}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => { setUnavailable(true) }}
      />
    </span>
  )
}

const accountTones: Record<Connection['status'], Tone> = {
  connected: 'success',
  pending: 'pending',
  expired: 'danger',
  failed: 'danger',
  disconnected: 'muted',
  unknown: 'muted',
}

const mcpStateKeys: Record<CustomMcpStatus['state'], Key> = {
  connected: 'mcpStateConnected',
  connecting: 'mcpStateConnecting',
  reconnecting: 'mcpStateReconnecting',
  'waiting-credentials': 'mcpStateWaitingCredentials',
  disabled: 'mcpStateDisabled',
  failed: 'mcpStateFailed',
  unknown: 'mcpStateUnknown',
}

const mcpStateTones: Record<CustomMcpStatus['state'], Tone> = {
  connected: 'success',
  connecting: 'pending',
  reconnecting: 'pending',
  'waiting-credentials': 'pending',
  disabled: 'muted',
  failed: 'danger',
  unknown: 'muted',
}

const categoryGlyphs: Record<CategoryId, GlyphName> = {
  development: 'braces',
  communication: 'mail',
  productivity: 'list-checks',
  files: 'folders',
  design: 'layout-grid',
  data: 'database',
  crm: 'chart-no-axes-combined',
  support: 'users-round',
  finance: 'credit-card',
  others: 'blocks',
}

const categoryKeys: Record<CategoryId, Key> = {
  development: 'categoryDevelopment',
  communication: 'categoryCommunication',
  productivity: 'categoryProductivity',
  files: 'categoryFiles',
  design: 'categoryDesign',
  data: 'categoryData',
  crm: 'categoryCrm',
  support: 'categorySupport',
  finance: 'categoryFinance',
  others: 'categoryOthers',
}

/** One status word with a colored dot; the tone carries the meaning, not color alone. */
function StatusPill({ tone, text }: { tone: Tone; text: string }) {
  return (
    <span className={css.statusPill} data-tone={tone}>
      <i />
      {text}
    </span>
  )
}

/**
 * Resolve a class name the stylesheet declares.
 * @param value - the CSS-module lookup for a declared class.
 * @returns the class name, or an empty string when the sheet omits it.
 */
function cls(value: string | undefined): string {
  /* v8 ignore next -- every class passed here is declared in the module sheet */
  return value ?? ''
}

/** Pick the singular or plural form of a count label. */
function countKey(key: 'catalogCount' | 'accountCount' | 'mcpCount' | 'mcpTools' | 'mcpSummaryHeaders' | 'mcpSummaryEnv' | 'mcpProbeToolCount' | 'catalogSearchResults', count: number): Key {
  return `${key}.${count === 1 ? 'one' : 'other'}`
}

/** Toolkit authorization wording shared by catalog rows. */
function authKey(authType: Toolkit['authType']): Key {
  if (authType === 'oauth') return 'authOAuth'
  /* v8 ignore next -- a public service renders a badge instead of asking for a label */
  if (authType === 'none') return 'authNone'
  if (authType === 'credentials') return 'authCredentials'
  return 'authSetup'
}

const transportKey = (transport: McpTransport): Key =>
  transport === 'stdio' ? 'mcpTransportStdio' : 'mcpTransportHttp'

/** Endpoint or command line the user stored for one definition. */
function definitionTarget(server: CustomMcpServerView): string {
  if (server.transport === 'stdio')
    return [server.command, ...server.args].join(' ')
  return server.url
}

const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/
const httpUrlPattern = /^https?:\/\//i

/** One editable header or environment pair; `stored` marks a saved secret. */
interface DraftSetting {
  id: string
  key: string
  value: string
  stored: boolean
}

/** Editor state for one definition; `editing` locks the stored key name. */
interface McpDraft {
  name: string
  transport: McpTransport
  url: string
  headers: DraftSetting[]
  command: string
  args: string
  env: DraftSetting[]
  enabled: boolean
  editing: boolean
}

/** Field-level validation result; each entry is a locale key, never copy. */
interface DraftErrors {
  name: Key | null
  url: Key | null
  command: Key | null
}

/**
 * Validate one draft before Save is enabled.
 * @param draft - current editor content.
 * @param servers - stored definitions, used for the duplicate-name check.
 * @returns the first error of each field, or null when the field is valid.
 */
function draftErrors(draft: McpDraft, servers: readonly CustomMcpServerView[]): DraftErrors {
  const name = draft.name.trim()
  const duplicate = !draft.editing && servers.some(
    server => server.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  )
  const errors: DraftErrors = {
    name: name === ''
      ? 'mcpNameRequired'
      : !serverNamePattern.test(name)
        ? 'mcpNameInvalid'
        : duplicate ? 'mcpNameTaken' : null,
    url: null,
    command: null,
  }
  if (draft.transport === 'streamable-http') {
    const url = draft.url.trim()
    errors.url = url === '' ? 'mcpUrlRequired' : !httpUrlPattern.test(url) ? 'mcpUrlInvalid' : null
  } else if (draft.command.trim() === '') {
    errors.command = 'mcpCommandRequired'
  }
  return errors
}

/**
 * Project the editor draft onto the submitted definition. Blank values keep the
 * stored secret for that key; keys the user removed are simply omitted.
 * @param draft - current editor content.
 * @returns the definition to save or probe.
 */
function draftInput(draft: McpDraft): McpServerInput {
  const pairs = (rows: readonly DraftSetting[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const row of rows) {
      const key = row.key.trim()
      // A blank value keeps a stored secret; a blank new row contributes nothing.
      if (key !== '' && (row.value !== '' || row.stored)) out[key] = row.value
    }
    return out
  }
  const stdio = draft.transport === 'stdio'
  return {
    name: draft.name.trim(),
    transport: draft.transport,
    url: stdio ? '' : draft.url.trim(),
    headers: stdio ? {} : pairs(draft.headers),
    command: stdio ? draft.command.trim() : '',
    args: stdio ? draft.args.split(/\s+/).filter(part => part !== '') : [],
    env: stdio ? pairs(draft.env) : {},
    enabled: draft.enabled,
  }
}

/**
 * Stored definition as a probe input: saved keys travel with blank values, so
 * the Host resolves the credentials it already holds.
 * @param server - stored definition to test.
 * @returns the definition to probe without saving.
 */
/** Saved keys carrying a blank value, which the Host reads as "keep the secret". */
function blankValues(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) out[name] = ''
  return out
}

function storedInput(server: CustomMcpServerView): McpServerInput {
  return {
    name: server.name,
    transport: server.transport,
    url: server.url,
    headers: blankValues(server.headerNames),
    command: server.command,
    args: server.args,
    env: blankValues(server.envNames),
    enabled: server.enabled,
  }
}

/** Probe outcome: success names the server and its tools, failure names the stage. */
function ProbeResult({ probe, t }: { probe: McpServerProbe; t: ProductProps['t'] }) {
  if (probe.ok) {
    const shown = probe.toolNames.slice(0, 8)
    const hidden = probe.toolNames.length - shown.length
    return (
      <div className={css.probeResult} data-ok="true" role="status">
        <p className={css.probeLine}>
          <Glyph name="circle-check" size={15} />
          {t('mcpProbeSuccess', { ms: probe.durationMs })}
        </p>
        {(probe.serverName !== null || probe.serverVersion !== null) && (
          <p className={css.probeMeta}>
            <span>{t('mcpProbeServer')}</span>
            {probe.serverName !== null && <span>{probe.serverName}</span>}
            {probe.serverVersion !== null && (
              <span className={css.probeVersion}>{probe.serverVersion}</span>
            )}
          </p>
        )}
        <p className={css.probeMeta}>
          {probe.toolNames.length === 0
            ? t('mcpProbeNoTools')
            : t(countKey('mcpProbeToolCount', probe.toolNames.length), { count: probe.toolNames.length })}
        </p>
        {shown.length > 0 && (
          <ul className={css.probeTools}>
            {shown.map(name => <li key={name}>{name}</li>)}
            {hidden > 0 && <li>+{hidden}</li>}
          </ul>
        )}
        {probe.truncated && <p className={css.probeMeta}>{t('mcpProbeToolsTruncated')}</p>}
      </div>
    )
  }
  return (
    <div className={css.probeResult} data-ok="false" role="alert">
      <p className={css.probeLine}>
        <Glyph name="triangle-alert" size={15} />
        {t(probe.stage === 'list' ? 'mcpProbeListFailed' : 'mcpProbeConnectFailed')}
      </p>
      {probe.message !== null && <p className={css.probeDiagnostic}>{probe.message}</p>}
    </div>
  )
}

/**
 * One header or environment table. Saved keys stay visible while their values
 * remain write-only, so a stored secret can be replaced but never read back.
 * @param props.kind - which table this is, selecting its labels.
 * @param props.t - locale seat for the table labels.
 * @param props.rows - editable pairs in definition order.
 * @param props.revealed - row ids whose value field currently shows plain text.
 * @param props.onChange - apply one edit to one row.
 * @param props.onRemove - drop one row, which withdraws its stored secret.
 * @param props.onAdd - append one empty row.
 * @param props.onReveal - toggle plain-text display for one row.
 * @returns the labelled table and its add action.
 */
function SettingRows({
  kind,
  t,
  rows,
  revealed,
  onChange,
  onRemove,
  onAdd,
  onReveal,
}: {
  kind: 'headers' | 'env'
  t: ProductProps['t']
  rows: readonly DraftSetting[]
  revealed: Record<string, boolean>
  onChange: (id: string, patch: Partial<DraftSetting>) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onReveal: (id: string) => void
}) {
  const fieldKeys: Record<'field' | 'key' | 'value' | 'add', Key> = kind === 'headers'
    ? { field: 'mcpHeaders', key: 'mcpHeaderKey', value: 'mcpHeaderValue', add: 'mcpAddHeader' }
    : { field: 'mcpEnv', key: 'mcpEnvKey', value: 'mcpEnvValue', add: 'mcpAddEnv' }
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{t(fieldKeys.field)}</span>
      <div className={css.pairList}>
        {rows.map(row => (
          <div className={css.pairRow} key={row.id}>
            <input
              className={css.pairKey}
              value={row.key}
              readOnly={row.stored}
              placeholder={t(fieldKeys.key)}
              aria-label={t(fieldKeys.key)}
              onChange={(event) => { onChange(row.id, { key: event.target.value }) }}
            />
            <input
              className={css.pairValue}
              type={revealed[row.id] === true ? 'text' : 'password'}
              value={row.value}
              autoComplete="off"
              placeholder={row.stored ? t('mcpValueStored') : t(fieldKeys.value)}
              aria-label={t(fieldKeys.value)}
              onChange={(event) => { onChange(row.id, { value: event.target.value }) }}
            />
            <button
              type="button"
              className={css.iconButton}
              aria-label={t(revealed[row.id] === true ? 'mcpHide' : 'mcpReveal')}
              aria-pressed={revealed[row.id] === true}
              onClick={() => { onReveal(row.id) }}
            >
              <Glyph name={revealed[row.id] === true ? 'x' : 'scan-search'} size={15} />
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('mcpRemoveRow', {
                name: row.key === '' ? t(fieldKeys.key) : row.key,
              })}
              onClick={() => { onRemove(row.id) }}
            >
              <Glyph name="x" size={15} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className={css.secondary} onClick={onAdd}>
        <Glyph name="plus" size={15} />
        {t(fieldKeys.add)}
      </button>
    </div>
  )
}

/**
 * Render the connections page with its three data sections.
 * @param props - product snapshot hook, commands, and the locale seat.
 * @returns the page, its confirmation dialogs, and its transient failure toast.
 */
export function ConnectionsPage(props: PageProps) {
  const state = props.useProduct(s => s)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(40)
  const [category, setCategory] = useState<CategoryId | null>(null)
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null)
  const [connecting, setConnecting] = useState<Toolkit | null>(null)
  const [label, setLabel] = useState('')
  const [authorizing, setAuthorizing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState<McpDraft | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<CustomMcpServerView | null>(null)
  const [removingBusy, setRemovingBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testTarget, setTestTarget] = useState<string | null>(null)
  const rowIds = useRef(0)
  const accountsRef = useRef<HTMLElement | null>(null)
  const mcpRef = useRef<HTMLElement | null>(null)
  const catalogRef = useRef<HTMLElement | null>(null)

  const data = state.connections
  const servers = state.mcpServers
  const busy = state.busy !== null
  const t = props.t

  const accountCount = data?.accounts.filter(account => account.status === 'connected').length ?? 0
  const activeMcp = servers?.filter(server => server.enabled).length ?? 0
  const catalogSize = data?.toolkits.length ?? 0

  const toolkits: readonly Toolkit[] = data?.toolkits ?? noToolkits
  // One index serves every account row, which otherwise searches the whole
  // catalog for its name and brand mark.
  const toolkitsBySlug = useMemo(
    () => new Map(toolkits.map(toolkit => [toolkit.slug, toolkit] as const)),
    [toolkits],
  )
  const categoryCounts = useMemo(() => {
    const counts = new Map<CategoryId, number>()
    for (const toolkit of toolkits) {
      const id = categoryOf(toolkit.slug)
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [toolkits])
  const searching = query.trim() !== ''
  /** Nothing is listed until a category is chosen; a search looks across all of them. */
  const visibleToolkits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle !== '') {
      return toolkits.filter(toolkit =>
        `${toolkit.name} ${toolkit.slug}`.toLocaleLowerCase().includes(needle))
    }
    if (category === null) return []
    return toolkits.filter(toolkit => categoryOf(toolkit.slug) === category)
  }, [toolkits, query, category])
  const categories = useMemo(
    () => CATEGORY_ORDER.filter(id => (categoryCounts.get(id) ?? 0) > 0),
    [categoryCounts],
  )

  const duplicateLabel =
    data?.accounts.some(
      account =>
        account.toolkit === connecting?.slug
        && account.label.toLocaleLowerCase() === label.trim().toLocaleLowerCase(),
    ) ?? false

  const errors = draft === null ? null : draftErrors(draft, servers ?? [])
  const draftValid = errors !== null
    && errors.name === null && errors.url === null && errors.command === null
  const mcpBusy = state.busy === 'mcp:save'
  const editorProbe = draft !== null ? state.mcpProbe : null

  const refresh = () => {
    props.loadConnections()
    props.loadMcpServers()
  }

  const nextRowId = (): string => {
    rowIds.current += 1
    return `row-${rowIds.current}`
  }

  const emptyRow = (): DraftSetting => ({ id: nextRowId(), key: '', value: '', stored: false })

  const updateDraft = (patch: Partial<McpDraft>) => {
    /* v8 ignore next -- every caller is a control inside the open dialog */
    setDraft(current => (current === null ? null : { ...current, ...patch }))
  }

  const patchRows = (
    kind: 'headers' | 'env',
    change: (rows: DraftSetting[]) => DraftSetting[],
  ) => {
    setDraft((current) => {
      /* v8 ignore next -- every caller runs from a control inside the open dialog */
      if (current === null) return null
      return kind === 'headers'
        ? { ...current, headers: change(current.headers) }
        : { ...current, env: change(current.env) }
    })
  }

  const updateRow = (kind: 'headers' | 'env', id: string, patch: Partial<DraftSetting>) => {
    patchRows(kind, rows => rows.map(row => (row.id === id ? { ...row, ...patch } : row)))
  }

  const addRow = (kind: 'headers' | 'env') => {
    // Allocate the row id outside the updater so a double-invoked update reuses one id.
    const row = emptyRow()
    patchRows(kind, rows => [...rows, row])
  }

  const removeRow = (kind: 'headers' | 'env', id: string) => {
    patchRows(kind, rows => rows.filter(row => row.id !== id))
  }

  const openCreate = () => {
    props.dismiss()
    props.clearMcpProbe()
    setTestTarget(null)
    setDraft({
      name: '',
      transport: 'streamable-http',
      url: '',
      headers: [emptyRow()],
      command: '',
      args: '',
      env: [],
      enabled: true,
      editing: false,
    })
  }

  const openEdit = (server: CustomMcpServerView) => {
    props.dismiss()
    props.clearMcpProbe()
    setTestTarget(null)
    setDraft({
      name: server.name,
      transport: server.transport,
      url: server.url,
      headers: server.headerNames.map(name => ({
        id: nextRowId(),
        key: name,
        value: '',
        stored: true,
      })),
      command: server.command,
      args: server.args.join(' '),
      env: server.envNames.map(name => ({
        id: nextRowId(),
        key: name,
        value: '',
        stored: true,
      })),
      enabled: server.enabled,
      editing: true,
    })
  }

  const toggleReveal = (id: string) => {
    setRevealed(current => ({ ...current, [id]: current[id] !== true }))
  }

  const closeDraft = () => {
    if (saving) return
    setDraft(null)
    setRevealed({})
    props.clearMcpProbe()
  }

  const probeDraft = async () => {
    /* v8 ignore next -- its button is disabled unless the draft is valid and idle */
    if (draft === null || !draftValid || state.probingMcp) return
    await props.probeMcpServer(draftInput(draft))
  }

  const saveDraft = async () => {
    /* v8 ignore next -- its button is disabled unless the draft is valid and idle */
    if (draft === null || !draftValid || saving) return
    setSaving(true)
    try {
      if (await props.saveMcpServer(draftInput(draft))) {
        setDraft(null)
        setRevealed({})
      }
    } finally {
      setSaving(false)
    }
  }

  const testServer = async (server: CustomMcpServerView) => {
    props.dismiss()
    setTestTarget(server.name)
    await props.probeMcpServer(storedInput(server))
  }

  const toggleServer = async (server: CustomMcpServerView) => {
    props.dismiss()
    await props.setMcpEnabled(server.name, !server.enabled)
  }

  const removeServer = async () => {
    /* v8 ignore next -- the confirm button belongs to the dialog that sets it */
    if (removing === null) return
    setRemovingBusy(true)
    try {
      if (await props.deleteMcpServer(removing.name)) setRemoving(null)
    } finally {
      setRemovingBusy(false)
    }
  }

  const authorize = async () => {
    /* v8 ignore next -- the authorize button belongs to the dialog that sets it */
    if (connecting === null) return
    setAuthorizing(true)
    try {
      if (await props.connect(connecting.slug, label.trim())) setConnecting(null)
    } finally {
      setAuthorizing(false)
    }
  }

  const disconnect = async () => {
    /* v8 ignore next -- the confirm button belongs to the dialog that sets it */
    if (disconnecting === null) return
    setConfirming(true)
    try {
      if (await props.disconnect(disconnecting.id)) setDisconnecting(null)
    } finally {
      setConfirming(false)
    }
  }

  /** Enter in a text field tests the definition; the footer keeps Save explicit. */
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.key !== 'Enter') return
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.type === 'checkbox') return
    event.preventDefault()
    void probeDraft()
  }

  const clearFilters = () => {
    setQuery('')
    setCategory(null)
    setVisibleCount(40)
  }

  return (
    <main className={css.page} data-verboo-page="connections">
      <PageHead
        title={t('connections')}
        description={t('connectionsDescription')}
        t={t}
        onRefresh={refresh}
        loading={state.loadingConnections || state.loadingMcp}
      />
      {state.connectionsFailed && (
        <Notice
          error
          text={t('connectionUnavailable')}
          retry={refresh}
          label={t('retry')}
        />
      )}
      {state.handoff === 'connection' && (
        <Notice
          text={t('connectionWebsite')}
          retry={props.loadConnections}
          label={t('refresh')}
        />
      )}
      {data === null && state.loadingConnections && <Busy label={t('loading')} />}
      {data !== null && !data.available && <Notice text={t('connectionUnavailable')} />}

      {data !== null && (
        <div className={css.summary}>
          <button
            type="button"
            className={css.summaryItem}
            onClick={() => accountsRef.current?.scrollIntoView({ block: 'start' })}
          >
            <span className={css.summaryValue}>{accountCount}</span>
            <span className={css.summaryLabel}>{t('summaryAccounts')}</span>
          </button>
          <button
            type="button"
            className={css.summaryItem}
            onClick={() => mcpRef.current?.scrollIntoView({ block: 'start' })}
          >
            <span className={css.summaryValue}>{activeMcp}</span>
            <span className={css.summaryLabel}>{t('summaryMcp')}</span>
          </button>
          <button
            type="button"
            className={css.summaryItem}
            onClick={() => catalogRef.current?.scrollIntoView({ block: 'start' })}
          >
            <span className={css.summaryValue}>{catalogSize}</span>
            <span className={css.summaryLabel}>{t('summaryCatalog')}</span>
          </button>
        </div>
      )}
      {/* One polite announcement covers the three tallies without nesting live regions in buttons. */}
      {data !== null && (
        <p className={css.srOnly} role="status">
          {t('summaryStatus', {
            accounts: accountCount,
            mcp: activeMcp,
            catalog: catalogSize,
          })}
        </p>
      )}

      {data !== null && data.accounts.length > 0 && (
        <section className={css.connectedSection} ref={accountsRef}>
          <div className={css.sectionHead}>
            <h2>{t('connectedAccounts')}</h2>
            <span className={css.sectionMeta}>
              {t(countKey('accountCount', data.accounts.length), { count: data.accounts.length })}
            </span>
          </div>
          <div className={css.connectedList}>
            {data.accounts.map(account => (
              <div className={css.connectedRow} key={account.id}>
                <ServiceIcon slug={account.toolkit} logo={toolkitsBySlug.get(account.toolkit)?.logo} />
                <div className={css.connectionIdentity}>
                  <span>{account.label}</span>
                  <span className={css.connectionService}>
                    {toolkitsBySlug.get(account.toolkit)?.name ?? account.toolkit}
                  </span>
                  <StatusPill
                    tone={accountTones[account.status]}
                    text={t(account.status)}
                  />
                </div>
                {state.authorizationIds.includes(account.id)
                  && account.status !== 'connected' && (
                  <button
                    className={css.textButton}
                    onClick={() => { props.reopenConnection(account.id) }}
                  >
                    {t('reopen')}
                  </button>
                )}
                <button
                  className={css.textButton}
                  disabled={busy}
                  onClick={() => {
                    props.dismiss()
                    setDisconnecting(account)
                  }}
                >
                  {t('disconnect')}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={css.mcpSection} ref={mcpRef}>
        <div className={css.sectionHead}>
          <div className={css.sectionTitle}>
            <h2>
              {t('mcpSectionTitle')}
              {servers !== null && servers.length > 0 && (
                <span className={css.sectionMeta}>
                  {t(countKey('mcpCount', servers.length), { count: servers.length })}
                </span>
              )}
            </h2>
            <p>{t('mcpSectionDescription')}</p>
          </div>
          <div className={css.sectionTools}>
            <button className={css.primary} disabled={mcpBusy} onClick={openCreate}>
              <Glyph name="plus" size={15} />
              {t('mcpAdd')}
            </button>
          </div>
        </div>

        {state.mcpFailed && (
          <>
            <Notice
              error
              text={t('mcpFailed')}
              retry={props.loadMcpServers}
              label={t('retry')}
            />
            {state.mcpError !== null && (
              <p className={css.detailText} role="alert">{state.mcpError}</p>
            )}
          </>
        )}

        {servers === null && state.loadingMcp && <Busy label={t('loading')} />}

        {servers !== null && servers.length === 0 && (
          <div className={css.mcpEmpty}>
            <Glyph name="cable" size={20} />
            <div>
              <p>{t('mcpEmpty')}</p>
              <p className={css.mcpEmptyHint}>{t('mcpEmptyHint')}</p>
            </div>
          </div>
        )}

        {servers !== null && servers.length > 0 && (
          <div className={css.mcpList}>
            {servers.map((server) => {
              const targeted = testTarget === server.name
              const probing = state.probingMcp && targeted
              const toggling = state.busy === `mcp:${server.name}`
              return (
                <article className={css.mcpCard} key={server.name}>
                  <div className={css.mcpHead}>
                    <div className={css.mcpIdentity}>
                      <h3>{server.name}</h3>
                      <span className={css.mcpBadge}>
                        {t(transportKey(server.transport))}
                      </span>
                    </div>
                    <div className={css.mcpActions}>
                      <button
                        className={css.secondary}
                        disabled={state.probingMcp || busy}
                        onClick={() => { void testServer(server) }}
                      >
                        {probing
                          ? <Glyph name="loader-circle" className={css.spin} size={15} />
                          : <Glyph name="play" size={15} />}
                        {probing ? t('mcpTesting') : t('mcpTest')}
                      </button>
                      <button
                        className={css.secondary}
                        disabled={busy}
                        onClick={() => { void toggleServer(server) }}
                        aria-label={server.enabled
                          ? `${t('mcpDisable')} ${server.name}`
                          : `${t('mcpEnable')} ${server.name}`}
                      >
                        {toggling
                          ? <Glyph name="loader-circle" className={css.spin} size={15} />
                          : <Glyph name={server.enabled ? 'pause' : 'play'} size={15} />}
                        {server.enabled ? t('mcpDisable') : t('mcpEnable')}
                      </button>
                      <button
                        className={css.textButton}
                        disabled={busy}
                        onClick={() => { openEdit(server) }}
                      >
                        {t('mcpEdit')}
                      </button>
                      <button
                        className={css.textButton}
                        data-tone="danger"
                        disabled={busy}
                        onClick={() => {
                          props.dismiss()
                          setRemoving(server)
                        }}
                      >
                        {t('mcpRemove')}
                      </button>
                    </div>
                  </div>
                  {definitionTarget(server) !== '' && (
                    <p className={css.mcpTarget}>{definitionTarget(server)}</p>
                  )}
                  <div className={css.mcpMetaRow} aria-live="polite">
                    <StatusPill
                      tone={mcpStateTones[server.status.state]}
                      text={t(mcpStateKeys[server.status.state])}
                    />
                    {server.status.state === 'connected' && server.status.toolCount > 0 && (
                      <span className={css.mcpToolCount}>
                        {t(countKey('mcpTools', server.status.toolCount), { count: server.status.toolCount })}
                      </span>
                    )}
                    {server.headerNames.length > 0 && (
                      <span className={css.mcpToolCount}>
                        {t(countKey('mcpSummaryHeaders', server.headerNames.length), { count: server.headerNames.length })}
                      </span>
                    )}
                    {server.envNames.length > 0 && (
                      <span className={css.mcpToolCount}>
                        {t(countKey('mcpSummaryEnv', server.envNames.length), { count: server.envNames.length })}
                      </span>
                    )}
                  </div>
                  {server.status.missing.length > 0 && (
                    <p className={css.mcpMissing} role="status">
                      <Glyph name="circle-alert" size={14} />
                      {t('mcpMissing', { names: server.status.missing.join(', ') })}
                    </p>
                  )}
                  {server.status.state === 'failed' && server.status.lastError !== '' && (
                    <p className={css.mcpDiagnostic}>{server.status.lastError}</p>
                  )}
                  {targeted && !state.probingMcp && state.mcpProbe !== null && (
                    <ProbeResult probe={state.mcpProbe} t={t} />
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {data !== null && (
        <section className={css.catalogSection} ref={catalogRef}>
          <div className={css.catalogHead}>
            <div className={css.catalogTitle}>
              <h2>{t('allTools')}</h2>
              <span>{t(countKey('catalogCount', data.toolkits.length), { count: data.toolkits.length })}</span>
            </div>
            <label className={css.search}>
              <Glyph name="search" size={16} />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setVisibleCount(40)
                }}
                placeholder={t('searchConnections')}
                aria-label={t('searchConnections')}
              />
            </label>
          </div>

          {searching ? (
            <p className={css.catalogHint}>
              {t(countKey('catalogSearchResults', visibleToolkits.length), { count: visibleToolkits.length })}
            </p>
          ) : category === null ? (
            <p className={css.catalogHint}>{t('catalogPickCategory')}</p>
          ) : (
            <div className={css.catalogBreadcrumb}>
              <button type="button" className={css.backButton} onClick={() => { setCategory(null); setVisibleCount(40) }}>
                <Glyph name="chevron-left" size={15} />
                {t('catalogBackToCategories')}
              </button>
              <span className={css.catalogBreadcrumbName}>{t(categoryKeys[category])}</span>
            </div>
          )}

          {!searching && category === null && (
            <div className={css.categoryGrid} role="group" aria-label={t('catalogCategories')}>
              {categories.map((id) => {
                /* v8 ignore next -- the list is filtered to ids the counts already carry */
                const count = categoryCounts.get(id) ?? 0
                return (
                  <button
                    type="button"
                    key={id}
                    className={css.categoryCard}
                    onClick={() => { setCategory(id); setVisibleCount(40) }}
                  >
                    <span className={css.categoryIcon}>
                      <Glyph name={categoryGlyphs[id]} size={18} />
                    </span>
                    <span className={css.categoryText}>
                      <strong>{t(categoryKeys[id])}</strong>
                      <span>{t(countKey('catalogCount', count), { count })}</span>
                    </span>
                    <Glyph name="arrow-right" className={css.categoryArrow} size={15} />
                  </button>
                )
              })}
            </div>
          )}

          <div className={css.serviceGrid}>
            {visibleToolkits.slice(0, visibleCount).map(toolkit => (
              <article className={css.serviceCard} key={toolkit.slug}>
                <div className={css.serviceCardHead}>
                  <ServiceIcon slug={toolkit.slug} logo={toolkit.logo} />
                  <div className={css.serviceIdentity}>
                    <h3>{toolkit.name}</h3>
                    <p>{t(categoryKeys[categoryOf(toolkit.slug)])}</p>
                  </div>
                </div>
                <div className={css.serviceCardFoot}>
                  {toolkit.authType === 'none'
                    ? <span className={css.badge}>{t('publicAvailable')}</span>
                    : (
                      <span className={css.authLabel}>
                        {t(authKey(toolkit.authType))}
                      </span>
                    )}
                  {toolkit.authType === 'none'
                    ? null
                    : (
                      <button
                        className={css.secondary}
                        disabled={!toolkit.available || busy}
                        onClick={() => {
                          props.dismiss()
                          setConnecting(toolkit)
                          setLabel('')
                        }}
                        aria-label={`${t('connect')} ${toolkit.name}`}
                      >
                        {state.busy === toolkit.slug
                          ? <Glyph name="loader-circle" className={css.spin} size={15} />
                          : <Glyph name="plus" size={15} />}
                        {t(toolkit.available ? 'connect' : 'authSetup')}
                      </button>
                    )}
                </div>
              </article>
            ))}
          </div>

          {visibleToolkits.length > 0 && (
            <div className={css.catalogFooter}>
              <span aria-live="polite">
                {t('catalogShowing', {
                  shown: Math.min(visibleCount, visibleToolkits.length),
                  total: visibleToolkits.length,
                })}
              </span>
              {visibleCount < visibleToolkits.length && (
                <button
                  className={css.secondary}
                  onClick={() => { setVisibleCount(count => count + 40) }}
                >
                  {t('showMore')}
                </button>
              )}
            </div>
          )}

          {/* "No results" belongs to a chosen category or a search, never to the closed catalog. */}
          {visibleToolkits.length === 0 && (searching || category !== null) && (
            <div className={css.emptyState}>
              <p className={css.emptyText}>{t('noResults')}</p>
              <button className={css.secondary} onClick={clearFilters}>
                {t('clearFilters')}
              </button>
            </div>
          )}
        </section>
      )}

      <p className={css.privacy}>
        <Glyph name="shield-check" size={16} />
        {t('connectionsPrivacy')}
      </p>

      <Modal
        open={draft !== null}
        onClose={closeDraft}
        title={t(draft?.editing === true ? 'mcpEditTitle' : 'mcpCreateTitle')}
        description={t(draft?.editing === true ? 'mcpEditDescription' : 'mcpCreateDescription')}
        closeLabel={t('close')}
        className={cls(css.mcpDialog)}
        contentClassName={cls(css.mcpContent)}
        onKeyDownCapture={onDialogKeyDown}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={saving}
              onClick={closeDraft}
            >
              {t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={!draftValid || saving || state.probingMcp}
              onClick={() => { void saveDraft() }}
            >
              {t('save')}
            </button>
          </>
        }
      >
        {draft !== null && errors !== null && (
          <div className={css.mcpForm}>
            <div className={css.field}>
              <label htmlFor="verboo-mcp-name">{t('mcpName')}</label>
              <input
                id="verboo-mcp-name"
                value={draft.name}
                readOnly={draft.editing}
                maxLength={32}
                placeholder={t('mcpNamePlaceholder')}
                onChange={(event) => { updateDraft({ name: event.target.value }) }}
                aria-describedby={errors.name === null
                  ? 'verboo-mcp-name-hint'
                  : 'verboo-mcp-name-hint verboo-mcp-name-error'}
                aria-invalid={errors.name !== null}
                data-modal-autofocus
              />
              <p className={css.fieldHint} id="verboo-mcp-name-hint">
                {t(draft.editing ? 'mcpNameLocked' : 'mcpNameHint')}
              </p>
              {errors.name !== null && (
                <p className={css.fieldError} id="verboo-mcp-name-error" role="alert">
                  {t(errors.name)}
                </p>
              )}
            </div>

            <div className={css.field}>
              <span className={css.fieldLabel} id="verboo-mcp-transport-label">
                {t('mcpTransport')}
              </span>
              <div
                className={css.segmentGroup}
                role="group"
                aria-labelledby="verboo-mcp-transport-label"
              >
                {(['streamable-http', 'stdio'] as const).map(transport => (
                  <button
                    type="button"
                    key={transport}
                    className={css.segment}
                    data-active={draft.transport === transport}
                    aria-pressed={draft.transport === transport}
                    onClick={() => {
                      updateDraft({ transport })
                      props.clearMcpProbe()
                    }}
                  >
                    {t(transportKey(transport))}
                  </button>
                ))}
              </div>
            </div>

            {draft.transport === 'streamable-http' ? (
              <>
                <div className={css.field}>
                  <label htmlFor="verboo-mcp-url">{t('mcpHttpUrl')}</label>
                  <input
                    id="verboo-mcp-url"
                    value={draft.url}
                    inputMode="url"
                    placeholder={t('mcpHttpUrlPlaceholder')}
                    onChange={(event) => { updateDraft({ url: event.target.value }) }}
                    aria-describedby={errors.url === null
                      ? 'verboo-mcp-url-hint'
                      : 'verboo-mcp-url-hint verboo-mcp-url-error'}
                    aria-invalid={errors.url !== null}
                  />
                  <p className={css.fieldHint} id="verboo-mcp-url-hint">
                    {t('mcpHttpUrlHint')}
                  </p>
                  {errors.url !== null && (
                    <p className={css.fieldError} id="verboo-mcp-url-error" role="alert">
                      {t(errors.url)}
                    </p>
                  )}
                </div>
                <SettingRows
                  kind="headers"
                  t={t}
                  rows={draft.headers}
                  revealed={revealed}
                  onChange={(id, patch) => { updateRow('headers', id, patch) }}
                  onRemove={(id) => { removeRow('headers', id) }}
                  onAdd={() => { addRow('headers') }}
                  onReveal={toggleReveal}
                />
              </>
            ) : (
              <>
                <div className={css.field}>
                  <label htmlFor="verboo-mcp-command">{t('mcpCommand')}</label>
                  <input
                    id="verboo-mcp-command"
                    value={draft.command}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('mcpCommandPlaceholder')}
                    onChange={(event) => { updateDraft({ command: event.target.value }) }}
                    aria-describedby={errors.command === null
                      ? 'verboo-mcp-command-hint'
                      : 'verboo-mcp-command-hint verboo-mcp-command-error'}
                    aria-invalid={errors.command !== null}
                  />
                  <p className={css.fieldHint} id="verboo-mcp-command-hint">
                    {t('mcpCommandHint')}
                  </p>
                  {errors.command !== null && (
                    <p className={css.fieldError} id="verboo-mcp-command-error" role="alert">
                      {t(errors.command)}
                    </p>
                  )}
                </div>
                <div className={css.field}>
                  <label htmlFor="verboo-mcp-args">{t('mcpArgs')}</label>
                  <input
                    id="verboo-mcp-args"
                    value={draft.args}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('mcpArgsPlaceholder')}
                    onChange={(event) => { updateDraft({ args: event.target.value }) }}
                    aria-describedby="verboo-mcp-args-hint"
                  />
                  <p className={css.fieldHint} id="verboo-mcp-args-hint">
                    {t('mcpArgsHint')}
                  </p>
                </div>
                <SettingRows
                  kind="env"
                  t={t}
                  rows={draft.env}
                  revealed={revealed}
                  onChange={(id, patch) => { updateRow('env', id, patch) }}
                  onRemove={(id) => { removeRow('env', id) }}
                  onAdd={() => { addRow('env') }}
                  onReveal={toggleReveal}
                />
              </>
            )}

            <label className={css.checkboxRow}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => { updateDraft({ enabled: event.target.checked }) }}
              />
              <span>{t('mcpConnectNow')}</span>
            </label>

            <div className={css.field}>
              <button
                type="button"
                className={css.secondary}
                disabled={!draftValid || state.probingMcp}
                onClick={() => { void probeDraft() }}
              >
                {state.probingMcp
                  ? <Glyph name="loader-circle" className={css.spin} size={15} />
                  : <Glyph name="play" size={15} />}
                {state.probingMcp ? t('mcpTesting') : t('mcpProbe')}
              </button>
              {editorProbe !== null && <ProbeResult probe={editorProbe} t={t} />}
            </div>

            <p className={css.secretsNote}>
              <Glyph name="shield-check" size={14} />
              {t('mcpSecretsNote')}
            </p>

            {state.actionFailed === 'mcp-save' && (
              <p className={css.error} role="alert">
                {t('mcpSaveFailed')}
                {state.mcpError !== null && <span className={css.errorDetail}>{state.mcpError}</span>}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => { if (!removingBusy) setRemoving(null) }}
        title={t('mcpDeleteTitle')}
        description={t('mcpDeleteDescription')}
        closeLabel={t('close')}
        className={cls(css.confirmDialog)}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={removingBusy}
              onClick={() => { setRemoving(null) }}
            >
              {t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={removingBusy}
              onClick={() => { void removeServer() }}
            >
              {t('mcpConfirmDelete')}
            </button>
          </>
        }
      >
        {removing !== null && (
          <p className={css.confirmIdentity}>{removing.name}</p>
        )}
        {state.actionFailed === 'mcp-delete' && (
          <p className={css.error} role="alert">
            {t('mcpDeleteFailed')}
            {state.mcpError !== null && <span className={css.errorDetail}>{state.mcpError}</span>}
          </p>
        )}
      </Modal>

      <Modal
        open={disconnecting !== null
          && data?.accounts.some(account => account.id === disconnecting.id) === true}
        onClose={() => { if (!confirming) setDisconnecting(null) }}
        title={t('disconnectTitle')}
        description={t('disconnectDescription')}
        closeLabel={t('close')}
        className={cls(css.confirmDialog)}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={confirming}
              onClick={() => { setDisconnecting(null) }}
            >
              {t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={confirming}
              onClick={() => { void disconnect() }}
            >
              {t('confirmDisconnect')}
            </button>
          </>
        }
      >
        {disconnecting !== null && (
          <p className={css.confirmIdentity}>{disconnecting.label}</p>
        )}
        {state.actionFailed === 'disconnect' && (
          <p className={css.error} role="alert">
            {t('disconnectFailed')}
          </p>
        )}
      </Modal>

      <Modal
        open={connecting !== null}
        onClose={() => { if (!authorizing) setConnecting(null) }}
        title={t('connectTitle')}
        description={t('connectDescription')}
        closeLabel={t('close')}
        className={cls(css.confirmDialog)}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={authorizing}
              onClick={() => { setConnecting(null) }}
            >
              {t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={authorizing || label.trim() === '' || duplicateLabel}
              onClick={() => { void authorize() }}
            >
              {t('authorize')}
              <Glyph name="arrow-up-right" size={16} />
            </button>
          </>
        }
      >
        <div className={css.connectForm}>
          <p className={css.confirmIdentity}>{connecting?.name}</p>
          <label htmlFor="verboo-connection-name">{t('connectionName')}</label>
          <input
            id="verboo-connection-name"
            value={label}
            maxLength={64}
            placeholder={t('connectionNamePlaceholder')}
            onChange={(event) => { setLabel(event.target.value) }}
            data-modal-autofocus
          />
          {duplicateLabel && (
            <p className={css.error} role="alert">
              {t('connectionNameUsed')}
            </p>
          )}
          {state.actionFailed === 'connect' && (
            <p className={css.error} role="alert">
              {t('connectFailed')}
            </p>
          )}
        </div>
      </Modal>

      {state.actionFailed === 'mcp-toggle' && (
        <Toast
          icon={<Glyph name="triangle-alert" size={18} />}
          text={state.mcpError === null ? t('mcpToggleFailed') : `${t('mcpToggleFailed')} ${state.mcpError}`}
          onDone={props.dismiss}
        />
      )}
    </main>
  )
}
