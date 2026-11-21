/**
 * OAuth for user-defined MCP servers: the write-time rules that keep a bearer
 * value out of a definition, the pasted-token fallback, sign-out, and the
 * loopback callback the Host's web server answers.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import VerbooMcpServers from '../src/index.ts'
import { answerCallback, hasAuthorization, OAUTH_CALLBACK_PATH } from '../src/oauth.ts'
import type { McpServerInput } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** In-memory credential store: the seam the OAuth slots and header value live in. */
class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<string, string>()
  get writable(): boolean { return true }
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(String(ref))
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }
  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(String(ref)) } as CredentialInfo)
  }
  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(String(ref), value)
    return Promise.resolve()
  }
  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(String(ref))
    return Promise.resolve()
  }
  list(): Promise<CredentialRecordInfo[]> { return Promise.resolve([]) }
  read(): Promise<CredentialRecordEntry[]> { return Promise.resolve([]) }
  write(): Promise<void> { return Promise.resolve() }
  remove(): Promise<void> { return Promise.resolve() }
  getRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  putRecord(_key: CredentialKey, _record: CredentialRecord): Promise<void> { return Promise.resolve() }
  readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true } as CredentialRecordInfo)
  }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }
  deleteRecord(_key: CredentialKey): Promise<void> { return Promise.resolve() }
}

/** Mount the service with an optional web server double. */
async function mount(options: { webServer?: { origin: string } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verboo-mcp-oauth-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await (await ctx.plugin(McpServerManager, {})).await()
  if (options.webServer !== undefined) {
    // The service reads the web server through ctx.get, so the double only has
    // to expose the origin and the registration seam it uses.
    ctx.provide('webServer', {
      getOrigin: () => options.webServer?.origin ?? '',
      register: vi.fn(() => () => {}),
    })
  }
  await (await ctx.plugin(VerbooMcpServers, {})).await()
  onTestFinished(() => undefined)
  return { ctx, service: ctx.verbooMcp, credentials: ctx.get('credentials') as MemoryCredentials }
}

const oauthInput = (overrides: Partial<McpServerInput> = {}): McpServerInput => ({
  name: 'remote',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headers: {},
  command: '',
  args: [],
  env: {},
  auth: 'oauth',
  enabled: true,
  ...overrides,
})

describe('write-time rules', () => {
  it('refuses OAuth on a stdio server, which has no redirect to complete', async () => {
    const { service } = await mount()
    const result = await service.saveFromClient(oauthInput({
      transport: 'stdio', url: '', command: 'npx', args: ['-y', 'server'],
    }))
    expect(result).toEqual({
      ok: false,
      code: 'invalid_input',
      message: 'auth: OAuth needs a browser redirect, which a stdio server cannot complete — use streamable-http',
    })
  })

  it('refuses static headers on an OAuth server, which would outrank the grant', async () => {
    const { service } = await mount()
    const result = await service.saveFromClient(oauthInput({ headers: { Authorization: 'Bearer typed' } }))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('takes no static headers')
  })

  it('stores only the template, and reports the definition as not yet signed in', async () => {
    const { service, credentials } = await mount()
    const saved = await service.saveFromClient(oauthInput())
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.data.auth).toBe('oauth')
    expect(saved.data.oauthSignedIn).toBe(false)
    expect(saved.data.headerNames).toEqual(['Authorization'])
    // The typed value never reached the definition: no bearer text is stored.
    expect([...credentials.values.values()]).not.toContain('Bearer typed')
  })

  it('derives the header mode for a definition that carries header values', async () => {
    const { service } = await mount()
    const saved = await service.saveFromClient(oauthInput({
      auth: undefined, headers: { 'X-Key': 'secret' },
    }))
    expect(saved.ok && saved.data.auth).toBe('headers')
  })
})

describe('pasted token fallback', () => {
  it('writes a bare token as the bearer value and reports the definition signed in', async () => {
    const { service, credentials } = await mount()
    await service.saveFromClient(oauthInput())
    const result = await service.setTokenFromClient('remote', 'abc123')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.oauthSignedIn).toBe(true)
    expect([...credentials.values.values()]).toContain('Bearer abc123')
  })

  it('keeps a whole header value verbatim, so an unusual scheme survives', async () => {
    const { service, credentials } = await mount()
    await service.saveFromClient(oauthInput())
    await service.setTokenFromClient('remote', 'DPoP opaque-token')
    expect([...credentials.values.values()]).toContain('DPoP opaque-token')
  })

  it('refuses an empty token and an over-long one', async () => {
    const { service } = await mount()
    await service.saveFromClient(oauthInput())
    expect(await service.setTokenFromClient('remote', '   ')).toEqual({
      ok: false, code: 'invalid_input', message: 'token: a token is required',
    })
    const long = await service.setTokenFromClient('remote', 'x'.repeat(8193))
    expect(long.ok ? '' : long.message).toContain('longer than 8192')
  })

  it('refuses a token for a definition that does not use OAuth', async () => {
    const { service } = await mount()
    await service.saveFromClient(oauthInput({ auth: 'headers', headers: { 'X-Key': 'v' } }))
    const result = await service.setTokenFromClient('remote', 'abc')
    expect(result.ok ? '' : result.message).toContain('does not use OAuth')
  })

  it('reports an unknown server', async () => {
    const { service } = await mount()
    expect(await service.setTokenFromClient('missing', 'abc')).toEqual({
      ok: false, code: 'not_found', message: 'no MCP server named "missing"',
    })
  })
})

describe('sign-out', () => {
  it('drops the grant and the header value, and reports the definition signed out', async () => {
    const { service, ctx, credentials } = await mount()
    await service.saveFromClient(oauthInput())
    await service.setTokenFromClient('remote', 'abc123')
    expect(await hasAuthorization(ctx, 'remote')).toBe(true)
    const result = await service.signOutFromClient('remote')
    expect(result.ok && result.data.oauthSignedIn).toBe(false)
    expect([...credentials.values.values()]).not.toContain('Bearer abc123')
  })
})

describe('browser sign-in', () => {
  it('reports a Host without a web server instead of pretending to start', async () => {
    const { service } = await mount()
    await service.saveFromClient(oauthInput())
    const result = await service.signInFromClient('remote')
    expect(result.ok ? '' : result.message).toBe('the Host web server is not available')
  })

  it('refuses a sign-in for a definition that does not use OAuth', async () => {
    const { service } = await mount({ webServer: { origin: 'http://127.0.0.1:9' } })
    await service.saveFromClient(oauthInput({ auth: 'headers', headers: { 'X-Key': 'v' } }))
    const result = await service.signInFromClient('remote')
    expect(result.ok ? '' : result.message).toContain('does not use OAuth')
  })

  it('reports an unknown server', async () => {
    const { service } = await mount({ webServer: { origin: 'http://127.0.0.1:9' } })
    const result = await service.signInFromClient('missing')
    expect(result.ok ? '' : result.message).toBe('no MCP server named "missing"')
  })
})

describe('loopback callback', () => {
  it('reports a declined authorization', async () => {
    const { ctx } = await mount()
    const answer = await answerCallback(ctx, new URLSearchParams({ error: 'access_denied', state: 'x' }))
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('declined')
  })

  it('reports an incomplete response', async () => {
    const { ctx } = await mount()
    expect((await answerCallback(ctx, new URLSearchParams({ state: 'x' }))).body).toContain('incomplete')
    expect((await answerCallback(ctx, new URLSearchParams({ code: 'c' }))).body).toContain('incomplete')
  })

  it('refuses a response no started sign-in is waiting for', async () => {
    const { ctx } = await mount()
    const answer = await answerCallback(ctx, new URLSearchParams({ code: 'c', state: 'unknown' }))
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('no sign-in is waiting')
  })

  it('serves the callback path the redirect URL names', () => {
    expect(OAUTH_CALLBACK_PATH).toBe('/mcp/oauth/callback')
  })
})
