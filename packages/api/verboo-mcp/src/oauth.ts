/**
 * OAuth 2.1 sign-in for remote user-defined MCP servers. The MCP SDK drives
 * discovery, dynamic client registration, PKCE and token exchange; this module
 * supplies the persistence (the credential store), the loopback redirect the
 * Host's web server answers, and the `Authorization` header value a mounted
 * definition presents.
 *
 * Tokens never enter a stored definition. The complete header value lives as
 * one credential, and the definition holds only the `${credential:REF}`
 * template that names it, so a definition stays safe to display and the
 * transport resolves the value at connect time.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { beginMcpOAuth, completeMcpOAuth, createMcpOAuthProvider } from '@deepseek-ai/dsh-mcp-client'
import type { McpOAuthProvider, McpOAuthStore } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { mcpCredentialRef, mcpOAuthSlotRef } from './store.ts'

/** Loopback path the authorization server redirects to; the `state` identifies the attempt. */
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback'

/** Client name an authorization server shows on its consent screen. */
const CLIENT_NAME = 'Verboo Code'

/** One sign-in the Host started and is waiting to receive a code for. */
interface PendingLogin {
  /** Server the attempt belongs to. */
  server: string
  /** Endpoint the flow authorizes against. */
  url: string
  /** Provider holding the PKCE verifier this attempt saved. */
  provider: McpOAuthProvider
  /** Redirects the browser back here once the user finishes. */
  redirectUrl: string
}

/**
 * The credential store as one server's OAuth persistence: each slot is a
 * credential reference, so the values inherit the store's at-rest protection
 * and never reach a definition or a log.
 */
function credentialStore(ctx: Context, server: string): McpOAuthStore {
  return {
    async read(slot) {
      const value = await ctx.credentials.resolve(credentialRef(mcpOAuthSlotRef(server, slot)))
      return value?.value
    },
    async write(slot, value) {
      await ctx.credentials.set(credentialRef(mcpOAuthSlotRef(server, slot)), value)
    },
    async clear(slot) {
      await ctx.credentials.unset(credentialRef(mcpOAuthSlotRef(server, slot)))
    },
  }
}

/**
 * Build the provider one server's flow runs through.
 * @param ctx - Host context providing the credential store.
 * @param server - server name the values belong to.
 * @param redirectUrl - loopback callback, or `undefined` for a silent refresh.
 * @returns the provider.
 */
export function oauthProvider(
  ctx: Context,
  server: string,
  redirectUrl?: string,
): McpOAuthProvider {
  return createMcpOAuthProvider({
    store: credentialStore(ctx, server),
    clientName: CLIENT_NAME,
    ...(redirectUrl === undefined ? {} : { redirectUrl }),
  })
}

/** Sign-ins in flight, keyed by the CSRF `state` the authorization server echoes. */
const pending = new Map<string, PendingLogin>()

/**
 * Forget every sign-in that was started but never finished.
 * @param server - server whose attempts to drop.
 * @returns nothing.
 */
export function dropPending(server: string): void {
  for (const [state, login] of pending) if (login.server === server) pending.delete(state)
}

/**
 * Refresh the stored grant when possible and report the header value the
 * transport should send. A grant that cannot be refreshed silently keeps its
 * current token: the server then answers 401 and the surface offers a sign-in
 * instead of the mount failing with an unexplained error.
 * @param ctx - Host context providing the credential store.
 * @param server - server name.
 * @param url - the server's endpoint.
 * @returns the complete `Authorization` header value.
 * @throws when the definition holds no grant at all.
 */
export async function authorizationHeader(ctx: Context, server: string, url: string): Promise<string> {
  const provider = oauthProvider(ctx, server)
  const stored = await provider.storedTokens()
  if (stored === undefined) {
    throw new Error(`"${server}" has no stored OAuth grant — sign in first`)
  }
  try {
    await beginMcpOAuth(provider, url)
  } catch {
    // A refresh that needs a human cannot run while mounting; the stored token
    // stays in place and the connection reports the refusal instead.
  }
  const tokens = (await provider.storedTokens()) ?? stored
  return `${tokens.token_type || 'Bearer'} ${tokens.access_token}`
}

/**
 * Write the header credential one server presents, so its stored definition
 * resolves it at connect time.
 * @param ctx - Host context providing the credential store.
 * @param server - server name.
 * @param header - complete `Authorization` header value.
 * @returns after the credential store committed it.
 */
export async function storeAuthorizationHeader(ctx: Context, server: string, header: string): Promise<void> {
  await ctx.credentials.set(credentialRef(mcpCredentialRef(server, 'Authorization')), header)
}

/**
 * Drop one server's grant and header credential.
 * @param ctx - Host context providing the credential store.
 * @param server - server name.
 * @returns after every value is gone.
 */
export async function forgetAuthorization(ctx: Context, server: string): Promise<void> {
  dropPending(server)
  await oauthProvider(ctx, server).forget()
  await ctx.credentials.unset(credentialRef(mcpCredentialRef(server, 'Authorization')))
}

/**
 * Whether one server holds a credential it can present, whichever way the user
 * supplied it: a completed browser sign-in or a pasted token both end as the
 * same stored header value.
 * @param ctx - Host context providing the credential store.
 * @param server - server name.
 * @returns whether the definition can authenticate right now.
 */
export async function hasAuthorization(ctx: Context, server: string): Promise<boolean> {
  const header = await ctx.credentials.describe(credentialRef(mcpCredentialRef(server, 'Authorization')))
  return header.configured
}

/**
 * Start a sign-in and report the page the user must open.
 * @param ctx - Host context providing the credential store and web server.
 * @param server - server name.
 * @param url - the server's endpoint.
 * @returns the authorization page URL.
 * @throws when the web server is unavailable, the flow already has valid
 *   tokens, or the authorization server produced no page.
 */
export async function beginAuthorization(ctx: Context, server: string, url: string): Promise<string> {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) throw new Error('the Host web server is not available')
  const redirectUrl = `${webServer.getOrigin()}${OAUTH_CALLBACK_PATH}`
  const provider = oauthProvider(ctx, server, redirectUrl)
  const attempt = await beginMcpOAuth(provider, url)
  if (attempt.status === 'authorized') {
    // The stored refresh grant was still good: no human step is needed.
    await storeAuthorizationHeader(ctx, server, await authorizationHeader(ctx, server, url))
    return ''
  }
  const state = provider.lastState()
  /* v8 ignore next -- beginMcpOAuth always mints a state before redirecting */
  if (state === undefined) throw new Error('mcp-oauth: the sign-in recorded no state value')
  pending.set(state, { server, url, provider, redirectUrl })
  return attempt.url
}


/**
 * Redeem the code a loopback callback carried and store the resulting header.
 * @param ctx - Host context providing the credential store.
 * @param state - CSRF `state` echoed by the authorization server.
 * @param code - authorization code.
 * @param iss - RFC 9207 `iss` parameter, when the server sent one.
 * @returns the server the code belonged to.
 * @throws when the state matches no started sign-in or the exchange fails.
 */
export async function completeAuthorization(
  ctx: Context,
  state: string,
  code: string,
  iss?: string,
): Promise<string> {
  const login = pending.get(state)
  if (login === undefined) throw new Error('mcp-oauth: no sign-in is waiting for this response')
  pending.delete(state)
  await completeMcpOAuth(login.provider, login.url, code, iss)
  await storeAuthorizationHeader(ctx, login.server, await authorizationHeader(ctx, login.server, login.url))
  return login.server
}

/**
 * Answer one loopback callback request.
 * @param ctx - Host context providing the credential store.
 * @param query - the callback's parsed query parameters.
 * @returns the HTTP status and a short body to render in the browser.
 */
export async function answerCallback(
  ctx: Context,
  query: URLSearchParams,
): Promise<{ status: number; body: string }> {
  const denied = query.get('error')
  const state = query.get('state') ?? ''
  if (denied !== null) {
    pending.delete(state)
    return { status: 400, body: 'The authorization was declined. You can close this window.' }
  }
  const code = query.get('code')
  if (code === null || code === '' || state === '') {
    return { status: 400, body: 'This response is incomplete. Start the sign-in again.' }
  }
  try {
    const server = await completeAuthorization(ctx, state, code, query.get('iss') ?? undefined)
    return { status: 200, body: `Connected "${server}". You can close this window.` }
  } catch (error: unknown) {
    return {
      status: 400,
      body: `The sign-in could not be completed: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
}
