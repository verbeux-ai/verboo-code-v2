import { auth } from '@modelcontextprotocol/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { beginMcpOAuth, completeMcpOAuth, createMcpOAuthProvider } from '../src/oauth.ts'
import type { McpOAuthSlot } from '../src/oauth.ts'

vi.mock('@modelcontextprotocol/client', () => ({ auth: vi.fn() }))

const serverUrl = 'http://127.0.0.1:3000/mcp'

function provider() {
  const values = new Map<McpOAuthSlot, string>()
  const client = createMcpOAuthProvider({
    clientName: 'Test client',
    scope: 'mcp:read',
    store: {
      read: async slot => values.get(slot),
      write: async (slot, value) => { values.set(slot, value) },
      clear: async (slot) => { values.delete(slot) },
    },
  })
  return { client, values }
}

beforeEach(() => { vi.mocked(auth).mockReset() })

describe('stored MCP authorization', () => {
  it('treats corrupt records as absent and requires the stored PKCE verifier', async () => {
    const { client, values } = provider()
    values.set('client', '{interrupted write')
    values.set('tokens', '{interrupted write')
    expect(await client.clientInformation()).toBeUndefined()
    expect(await client.storedTokens()).toBeUndefined()
    await expect(client.codeVerifier()).rejects.toThrow('no PKCE verifier is stored')
    await client.saveCodeVerifier('synthetic-verifier')
    expect(await client.codeVerifier()).toBe('synthetic-verifier')
    expect(client.metadata.redirect_uris).toEqual([])
    expect(client.metadata.scope).toBe('mcp:read')
  })

  it('accepts a renewed authorization and reports a new sign-in without reusing an old redirect', async () => {
    const { client } = provider()
    vi.mocked(auth).mockResolvedValueOnce('AUTHORIZED').mockResolvedValueOnce('REDIRECT')
    expect(await beginMcpOAuth(client, serverUrl)).toEqual({ status: 'authorized' })
    client.redirectToAuthorization(new URL('http://127.0.0.1:3000/old-consent'))
    await expect(beginMcpOAuth(client, serverUrl)).rejects.toThrow('needs a new sign-in')
    expect(client.takeRedirect()).toBeUndefined()
  })

  it('passes the declared callback issuer to the SDK for validation', async () => {
    const { client } = provider()
    vi.mocked(auth).mockResolvedValue('AUTHORIZED')
    const issuer = 'http://127.0.0.1:3000'
    await completeMcpOAuth(client, serverUrl, 'synthetic-code', issuer)
    expect(auth).toHaveBeenCalledExactlyOnceWith(client, {
      serverUrl, authorizationCode: 'synthetic-code', iss: issuer,
    })
  })
})
