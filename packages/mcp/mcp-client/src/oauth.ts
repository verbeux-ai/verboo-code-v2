/**
 * OAuth 2.1 for remote MCP servers: the client-side provider the SDK drives,
 * backed by a caller-supplied store, plus the operations a product surface
 * needs — refresh or begin, redeem a callback code, and forget.
 *
 * The store is the only persistence seam. It holds five values per server:
 * the token set, the dynamically registered client information, the PKCE code
 * verifier, the authorization `state` value, and the discovery state. The
 * discovery state is what binds the callback leg to the authorization server
 * discovery found, so a mix-up response cannot be redeemed (SEP-2352). Their
 * contents are secrets; this module never logs them and never returns the
 * verifier.
 *
 * @module
 */
import { auth } from '@modelcontextprotocol/client'
import type {
  OAuthClientMetadata,
  OAuthDiscoveryState,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'

/** The values one server's OAuth state is persisted as. */
export type McpOAuthSlot = 'tokens' | 'client' | 'verifier' | 'state' | 'discovery'

/**
 * Persistence for one server's OAuth state. A store instance is already scoped
 * to one server, so the slot name alone identifies the value.
 */
export interface McpOAuthStore {
  /**
   * Read one stored value.
   * @param slot - which value to read.
   * @returns the stored string, or `undefined` when absent.
   */
  read(slot: McpOAuthSlot): Promise<string | undefined>
  /**
   * Write one value, replacing any previous one.
   * @param slot - which value to write.
   * @param value - serialized value; never logged by this module.
   * @returns after the store accepted it.
   */
  write(slot: McpOAuthSlot, value: string): Promise<void>
  /**
   * Drop one value.
   * @param slot - which value to drop.
   * @returns after the store accepted it.
   */
  clear(slot: McpOAuthSlot): Promise<void>
}

/** Options for {@link createMcpOAuthProvider}. */
export interface McpOAuthProviderOptions {
  /** Per-server persistence for tokens, client registration, verifier and state. */
  store: McpOAuthStore
  /** Client name the authorization server shows on its consent screen. */
  clientName: string
  /**
   * Loopback redirect the authorization server sends the code to. Omitted when
   * mounting a server that already holds a grant: without it the SDK never
   * starts an interactive flow.
   */
  redirectUrl?: string
  /** Scope to request when the resource metadata advertises none. */
  scope?: string
  /** Mints the CSRF `state` value; defaults to 32 random bytes as hex. */
  createState?: () => string
}

/** An OAuth provider this module owns, with the extra reads a surface needs. */
export interface McpOAuthProvider extends OAuthClientProvider {
  /** Client metadata this provider registers with an authorization server. */
  readonly metadata: OAuthClientMetadata
  /**
   * Read the stored token set without contacting any server.
   * @returns the tokens, or `undefined` when the user never authorized.
   */
  storedTokens(): Promise<StoredOAuthTokens | undefined>
  /**
   * Read and clear the URL the authorization server asked the user agent to
   * open during the last attempt.
   * @returns the URL, or `undefined` when the attempt did not redirect.
   */
  takeRedirect(): string | undefined
  /**
   * The CSRF `state` value this provider minted for its current attempt. A
   * loopback callback matches the echoed value back to the attempt through it.
   * @returns the value, or `undefined` when no flow has started.
   */
  lastState(): string | undefined
  /**
   * Drop every stored value, so the next attempt starts from discovery.
   * @returns after the store accepted every removal.
   */
  forget(): Promise<void>
}

/** Read one slot as JSON, treating an unreadable value as absent. */
async function readJson<T>(store: McpOAuthStore, slot: McpOAuthSlot): Promise<T | undefined> {
  const raw = await store.read(slot)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupt record means "not registered yet", exactly like an absent one:
    // discovery rewrites it, and refusing to continue would strand the server.
    return undefined
  }
}

/** Mints an unguessable `state` value. */
function defaultState(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Build the provider one server's OAuth flow runs through.
 * @param options - store, client name, optional loopback redirect and scope.
 * @returns a provider the SDK's `auth()` accepts.
 */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): McpOAuthProvider {
  const { store, clientName, redirectUrl, scope } = options
  const createState = options.createState ?? defaultState
  const metadata: OAuthClientMetadata = {
    client_name: clientName,
    ...(scope === undefined ? {} : { scope }),
    redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // A desktop application cannot keep a client secret: it is a public client.
    token_endpoint_auth_method: 'none',
  }
  /** URL the authorization server asked the user agent to open, per attempt. */
  let pending: string | undefined
  /** CSRF value the last attempt minted. */
  let mintedState: string | undefined
  const provider: McpOAuthProvider = {
    metadata,
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      return metadata
    },
    state() {
      mintedState = createState()
      return mintedState
    },
    async clientInformation() {
      return readJson<StoredOAuthClientInformation>(store, 'client')
    },
    async saveClientInformation(info: StoredOAuthClientInformation) {
      await store.write('client', JSON.stringify(info))
    },
    async tokens() {
      return readJson<StoredOAuthTokens>(store, 'tokens')
    },
    async saveTokens(tokens: StoredOAuthTokens) {
      await store.write('tokens', JSON.stringify(tokens))
    },
    redirectToAuthorization(url: URL) {
      // The caller owns the browser: the URL travels back to the surface that
      // asked for the login, so the Host never launches an application itself.
      pending = url.href
    },
    async saveDiscoveryState(state: OAuthDiscoveryState) {
      await store.write('discovery', JSON.stringify(state))
    },
    async discoveryState() {
      return readJson<OAuthDiscoveryState>(store, 'discovery')
    },
    async saveCodeVerifier(verifier: string) {
      await store.write('verifier', verifier)
    },
    async codeVerifier() {
      const verifier = await store.read('verifier')
      if (verifier === undefined) {
        throw new Error('mcp-oauth: no PKCE verifier is stored for this authorization')
      }
      return verifier
    },
    storedTokens: async () => readJson<StoredOAuthTokens>(store, 'tokens'),
    takeRedirect() {
      const url = pending
      pending = undefined
      return url
    },
    lastState() {
      return mintedState
    },
    async forget() {
      for (const slot of ['tokens', 'client', 'verifier', 'state', 'discovery'] as const) await store.clear(slot)
    },
  }
  return provider
}

/**
 * One authorization outcome: either the server is usable, or a human must open
 * the returned URL.
 */
export type McpOAuthAttempt =
  | { status: 'authorized' }
  | { status: 'redirect'; url: string }

/**
 * Obtain usable tokens: refresh a stored grant when possible, otherwise start
 * an authorization and report the URL the human must open.
 * @param provider - provider built by {@link createMcpOAuthProvider}.
 * @param serverUrl - the protected MCP endpoint the flow authorizes against.
 * @returns `authorized` with fresh tokens stored, or `redirect` with the URL.
 * @throws when discovery, registration or the refresh grant fails, and when a
 *   flow would need a human but the provider has no redirect URL.
 */
export async function beginMcpOAuth(
  provider: McpOAuthProvider,
  serverUrl: string,
): Promise<McpOAuthAttempt> {
  provider.takeRedirect()
  const result = await auth(provider, { serverUrl })
  if (result === 'AUTHORIZED') return { status: 'authorized' }
  const url = provider.takeRedirect()
  /* v8 ignore next -- the SDK's nonInteractiveFlow throws before a redirect can be produced without a redirect URL. */
  if (url === undefined) {
    // Interactive flow without a loopback: the caller asked to refresh, and a
    // refresh that needs a human cannot be satisfied silently.
    throw new Error('mcp-oauth: this server needs a new sign-in, but no redirect URL was supplied')
  }
  return { status: 'redirect', url }
}

/**
 * Redeem the authorization code a loopback callback received.
 * @param provider - the same provider instance that began the attempt.
 * @param serverUrl - the protected MCP endpoint.
 * @param code - authorization code from the callback.
 * @param iss - RFC 9207 `iss` parameter from the callback, when the server sent one.
 * @returns after the token set is stored.
 * @throws when the exchange fails or the issuer does not match the recorded one.
 */
export async function completeMcpOAuth(
  provider: McpOAuthProvider,
  serverUrl: string,
  code: string,
  iss?: string,
): Promise<void> {
  const result = await auth(provider, {
    serverUrl,
    authorizationCode: code,
    ...(iss === undefined ? {} : { iss }),
  })
  /* v8 ignore next -- redeeming a code ends authorized or throws */
  if (result !== 'AUTHORIZED') throw new Error('mcp-oauth: the authorization code was not redeemed')
}
