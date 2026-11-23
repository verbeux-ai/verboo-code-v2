/** The OAuth provider surface and the begin/complete flows, over a mock authorization server. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginMcpOAuth, completeMcpOAuth, createMcpOAuthProvider } from '../src/oauth.ts'
import type { McpOAuthStore } from '../src/oauth.ts'

/** One in-memory store the provider reads and writes. */
function memoryStore(): McpOAuthStore {
  const slots = new Map<string, string>()
  return {
    read: async slot => slots.get(slot),
    write: async (slot, value) => { slots.set(slot, value) },
    clear: async slot => { slots.delete(slot) },
  }
}

/** One mock authorization server: discovery, registration, and token exchange. */
async function oauthServer(options: { tokenStatus?: number; registerStatus?: number } = {}): Promise<{ url: string; close: () => Promise<void>; tokens: () => number }> {
  let tokens = 0
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/'
    response.setHeader('content-type', 'application/json')
    if (url.includes('/.well-known/oauth-protected-resource')) {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      response.end(JSON.stringify({
        resource: `${base}/mcp`,
        authorization_servers: [base],
      }))
      return
    }
    if (url.startsWith('/.well-known/oauth-authorization-server')) {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      response.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      }))
      return
    }
    if (url.startsWith('/register')) {
      response.statusCode = options.registerStatus ?? 200
      response.end(JSON.stringify({
        client_id: 'fixture-client',
        client_secret: 'fixture-secret',
        client_id_issued_at: 1,
        redirect_uris: ['http://127.0.0.1:0/callback'],
      }))
      return
    }
    if (url.startsWith('/token')) {
      tokens += 1
      response.statusCode = options.tokenStatus ?? 200
      response.end(JSON.stringify({
        access_token: `access-${tokens}`,
        token_type: 'Bearer',
        refresh_token: `refresh-${tokens}`,
        expires_in: 3600,
      }))
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url,
    tokens: () => tokens,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('createMcpOAuthProvider', () => {
  it('mints an unguessable state and reports the last one', () => {
    const provider = createMcpOAuthProvider({ store: memoryStore(), clientName: 'Verboo Code' })
    const first = (provider.state as () => string)()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(provider.lastState()).toBe(first)
    expect((provider.state as () => string)()).not.toBe(first)
  })

  it('round-trips the client information, tokens, discovery state, and verifier', async () => {
    const provider = createMcpOAuthProvider({ store: memoryStore(), clientName: 'Verboo Code' })
    await provider.saveClientInformation?.({ client_id: 'c1', redirect_uris: [] })
    await expect(provider.clientInformation()).resolves.toMatchObject({ client_id: 'c1' })
    await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer' })
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'a1' })
    await expect(provider.storedTokens()).resolves.toMatchObject({ access_token: 'a1' })
    await provider.saveDiscoveryState?.({ authorizationServerUrl: 'https://auth.example', authorizationServerMetadata: {} as never })
    await expect(provider.discoveryState?.()).resolves.toMatchObject({ authorizationServerUrl: 'https://auth.example' })
    await provider.saveCodeVerifier('verifier-1')
    await expect(provider.codeVerifier()).resolves.toBe('verifier-1')
  })

  it('treats a corrupt record as absent and refuses a missing verifier', async () => {
    const store = memoryStore()
    await store.write('client', 'not json')
    const provider = createMcpOAuthProvider({ store, clientName: 'Verboo Code' })
    await expect(provider.clientInformation()).resolves.toBeUndefined()
    await expect(provider.codeVerifier()).rejects.toThrow('no PKCE verifier is stored')
  })

  it('buffers the authorization URL and hands it over once', () => {
    const provider = createMcpOAuthProvider({ store: memoryStore(), clientName: 'Verboo Code' })
    provider.redirectToAuthorization(new URL('https://auth.example/authorize?state=x'))
    expect(provider.takeRedirect()).toBe('https://auth.example/authorize?state=x')
    expect(provider.takeRedirect()).toBeUndefined()
  })

  it('declares a public client with the configured scope and redirect', () => {
    const provider = createMcpOAuthProvider({
      store: memoryStore(), clientName: 'Verboo Code',
      redirectUrl: 'http://127.0.0.1:0/callback', scope: 'mcp:read',
    })
    expect(provider.clientMetadata).toMatchObject({
      client_name: 'Verboo Code', scope: 'mcp:read',
      redirect_uris: ['http://127.0.0.1:0/callback'],
      token_endpoint_auth_method: 'none',
    })
    expect(provider.redirectUrl).toBe('http://127.0.0.1:0/callback')
  })

  it('clears every slot on forget', async () => {
    const store = memoryStore()
    const provider = createMcpOAuthProvider({ store, clientName: 'Verboo Code' })
    await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer' })
    await provider.saveClientInformation?.({ client_id: 'c1', redirect_uris: [] })
    await provider.saveCodeVerifier('v1')
    await provider.forget()
    await expect(provider.tokens()).resolves.toBeUndefined()
    await expect(provider.clientInformation()).resolves.toBeUndefined()
    await expect(provider.codeVerifier()).rejects.toThrow()
  })
})

describe('beginMcpOAuth', () => {
  it('authorizes against a working server and stores the tokens', async () => {
    const server = await oauthServer()
    try {
      const store = memoryStore()
      const provider = createMcpOAuthProvider({ store, clientName: 'Verboo Code', redirectUrl: 'http://127.0.0.1:0/callback' })
      // Seed a refreshable grant and the discovery state so begin refreshes it.
      await provider.saveTokens({ access_token: 'stale', token_type: 'Bearer', refresh_token: 'refresh-0' })
      await provider.saveDiscoveryState?.({ authorizationServerUrl: server.url, authorizationServerMetadata: {
        issuer: server.url,
        token_endpoint: `${server.url}/token`,
        registration_endpoint: `${server.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      } as never, resourceMetadata: { resource: `${server.url}/mcp`, authorization_servers: [server.url] } as never })
      const attempt = await beginMcpOAuth(provider, `${server.url}/mcp`)
      expect(attempt).toEqual({ status: 'authorized' })
      await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'access-1' })
    } finally {
      await server.close()
    }
  })

  it('reports the authorization URL when the flow needs a human', async () => {
    const server = await oauthServer({ tokenStatus: 400 })
    try {
      const provider = createMcpOAuthProvider({
        store: memoryStore(), clientName: 'Verboo Code',
        redirectUrl: 'http://127.0.0.1:0/callback',
      })
      const attempt = await beginMcpOAuth(provider, `${server.url}/mcp`)
      expect(attempt.status).toBe('redirect')
      if (attempt.status === 'redirect') {
        expect(attempt.url).toContain('/authorize')
        expect(attempt.url).toContain('state=')
      }
    } finally {
      await server.close()
    }
  })
})

describe('completeMcpOAuth', () => {
  it('redeems the authorization code and stores the tokens', async () => {
    const server = await oauthServer()
    try {
      const provider = createMcpOAuthProvider({
        store: memoryStore(), clientName: 'Verboo Code',
        redirectUrl: 'http://127.0.0.1:0/callback',
      })
      const attempt = await beginMcpOAuth(provider, `${server.url}/mcp`)
      expect(attempt.status).toBe('redirect')
      if (attempt.status !== 'redirect') throw new Error('expected a redirect')
      const url = new URL(attempt.url)
      const state = url.searchParams.get('state') ?? ''
      const verifier = await provider.codeVerifier()
      expect(verifier.length).toBeGreaterThan(0)
      await expect(completeMcpOAuth(provider, `${server.url}/mcp`, 'the-code')).resolves.toBeUndefined()
      await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'access-1' })
      void state
    } finally {
      await server.close()
    }
  })

  it('carries the issuer parameter through the exchange', async () => {
    const server = await oauthServer()
    try {
      const provider = createMcpOAuthProvider({
        store: memoryStore(), clientName: 'Verboo Code',
        redirectUrl: 'http://127.0.0.1:0/callback',
      })
      const attempt = await beginMcpOAuth(provider, `${server.url}/mcp`)
      if (attempt.status !== 'redirect') throw new Error('expected a redirect')
      await expect(completeMcpOAuth(provider, `${server.url}/mcp`, 'the-code', server.url)).resolves.toBeUndefined()
      await expect(provider.tokens()).resolves.toMatchObject({ issuer: server.url })
    } finally {
      await server.close()
    }
  })
})
