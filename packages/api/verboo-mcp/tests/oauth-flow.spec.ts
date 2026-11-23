/**
 * The OAuth sign-in end to end against a real authorization server: discovery,
 * dynamic client registration, PKCE, the redirect the Host answers, the token
 * exchange, and the header the definition then presents. Only the browser
 * itself is simulated — the callback travels through the same handler the
 * Host's web server mounts.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
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
import { answerCallback, authorizationHeader, oauthProvider, OAUTH_CALLBACK_PATH } from '../src/oauth.ts'
import { mcpCredentialRef, mcpOAuthSlotRef } from '../src/store.ts'
import type { McpServerInput } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** In-memory credential store: where the OAuth slots and header value land. */
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

/** What the fake authorization server issued and what it was asked for. */
interface Authority {
  origin: string
  /** The PKCE challenge the authorization request carried. */
  challenge: string
  /** The `state` the authorization request carried. */
  state: string
  /** The redirect the authorization request asked for. */
  redirectUri: string
  /** Access token the token endpoint issued. */
  token: string
  /** PKCE verifier the token exchange submitted. */
  verifier: string
  /** How many times each well-known document was fetched. */
  reads: { resource: number; server: number }
  /** Grant types submitted to the fixture token endpoint. */
  exchanges: string[]
}

/**
 * One HTTP server that is both the protected MCP resource and its
 * authorization server. It answers the two well-known documents, registers
 * clients, authorizes, exchanges the code, and refuses the resource without the
 * bearer it issued.
 */
async function authority(): Promise<Authority> {
  const issued: Authority = {
    origin: '', challenge: '', state: '', redirectUri: '', token: 'tok-abc-123', verifier: '',
    reads: { resource: 0, server: 0 }, exchanges: [],
  }
  let clientId = ''
  let code = ''
  const body = async (request: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  }
  const json = (response: ServerResponse, value: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issued.origin)
    switch (`${request.method ?? ''} ${url.pathname}`) {
      case 'GET /.well-known/oauth-protected-resource':
        issued.reads.resource += 1
        json(response, {
          resource: `${issued.origin}/mcp`,
          authorization_servers: [issued.origin],
          bearer_methods_supported: ['header'],
        })
        return
      case 'GET /.well-known/oauth-authorization-server':
        issued.reads.server += 1
        json(response, {
          issuer: issued.origin,
          authorization_endpoint: `${issued.origin}/authorize`,
          token_endpoint: `${issued.origin}/token`,
          registration_endpoint: `${issued.origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
        return
      case 'POST /register':
        // Echo the redirect the client registered: registration precedes the
        // authorization request that names it.
        void body(request).then((params) => {
          clientId = 'client-1'
          json(response, {
            client_id: clientId,
            client_name: 'Verboo Code',
            redirect_uris: JSON.parse(params.get('redirect_uris') ?? '[]') as string[],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          })
        })
        return
      case 'GET /authorize':
        issued.challenge = url.searchParams.get('code_challenge') ?? ''
        issued.state = url.searchParams.get('state') ?? ''
        issued.redirectUri = url.searchParams.get('redirect_uri') ?? ''
        code = 'code-1'
        response.writeHead(302, {
          location: `${issued.redirectUri}?code=${code}&state=${encodeURIComponent(issued.state)}`,
          'cache-control': 'no-store',
        })
        response.end()
        return
      case 'POST /token':
        void body(request).then((params) => {
          issued.exchanges.push(params.get('grant_type') ?? '')
          issued.verifier = params.get('code_verifier') ?? ''
          json(response, {
            access_token: issued.token,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-1',
            scope: 'mcp',
          })
        })
        return
      case 'POST /mcp': {
        const authorization = request.headers.authorization ?? ''
        if (authorization !== `Bearer ${issued.token}`) {
          response.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${issued.origin}/.well-known/oauth-protected-resource"`,
            'content-type': 'application/json',
          })
          response.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        json(response, { jsonrpc: '2.0', id: 1, result: { ok: true } })
        return
      }
      default:
        response.writeHead(404).end()
    }
  })
  issued.origin = await listen(server)
  return issued
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture server did not bind a port')
  return `http://127.0.0.1:${String(address.port)}`
}

type CallbackRoute = { path: string; handler: (request: IncomingMessage, response: ServerResponse) => void }

/** Mount the service and serve its registered callback on loopback. */
async function mount(options: { omitRequestUrl?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verboo-mcp-flow-'))
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
  let callback: CallbackRoute | undefined
  const origin = await listen(createServer((request, response) => {
    if (callback === undefined || request.url?.split('?')[0] !== callback.path) {
      response.writeHead(404).end()
      return
    }
    if (options.omitRequestUrl) delete request.url
    callback.handler(request, response)
  }))
  ctx.provide('webServer', {
    getOrigin: () => origin,
    register: (route: CallbackRoute) => {
      callback = route
      return () => { callback = undefined }
    },
  })
  await (await ctx.plugin(VerbooMcpServers, {})).await()
  onTestFinished(() => undefined)
  return { ctx, origin, service: ctx.verbooMcp, credentials: ctx.get('credentials') as MemoryCredentials }
}

const oauthInput = (origin: string): McpServerInput => ({
  name: 'remote',
  transport: 'streamable-http',
  url: `${origin}/mcp`,
  headers: {},
  command: '',
  args: [],
  env: {},
  auth: 'oauth',
  enabled: true,
})

describe('browser sign-in against a real authorization server', () => {
  it('discovers, registers, authorizes, exchanges the code and stores the header', async () => {
    const issued = await authority()
    const { service, credentials } = await mount()
    await service.saveFromClient(oauthInput(issued.origin))

    const started = await service.signInFromClient('remote')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    // The flow reported a page for the human, not a completed authorization.
    expect(started.data).toContain(`${issued.origin}/authorize`)
    expect(started.data).toContain('code_challenge_method=S256')

    // The browser would open that page; here the redirect is read directly and
    // handed to the same handler the Host's web server mounts.
    const authorized = await fetch(started.data, { redirect: 'manual' })
    expect(authorized.status).toBe(302)
    const callback = new URL(authorized.headers.get('location') ?? '')
    expect(callback.pathname).toBe(OAUTH_CALLBACK_PATH)

    const rejectedMethod = await fetch(callback, { method: 'POST' })
    expect(rejectedMethod.status).toBe(405)
    expect(rejectedMethod.headers.get('cache-control')).toBe('no-store')
    const answered = await fetch(callback)
    expect(answered.status).toBe(200)
    expect(answered.headers.get('cache-control')).toBe('no-store')
    expect(await answered.text()).toContain('remote')

    // The definition now presents the issued bearer, and the token itself never
    // reached the stored record.
    expect([...credentials.values.values()]).toContain(`Bearer ${issued.token}`)
    const listed = await service.listFromClient()
    expect(listed.ok && listed.data[0]?.oauthSignedIn).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(issued.token)

    // PKCE: the challenge the request carried is the SHA-256 of the verifier the
    // exchange submitted, never the verifier itself.
    expect(issued.challenge).not.toBe('')
    const { verifier } = issued
    expect(verifier).not.toBe('')
    expect(issued.challenge).not.toBe(verifier)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    expect(issued.challenge).toBe(expected)
  })

  it('reuses the persisted discovery state instead of probing the well-known documents again', async () => {
    const issued = await authority()
    const { service } = await mount()
    await service.saveFromClient(oauthInput(issued.origin))
    const first = await service.signInFromClient('remote')
    expect(first.ok).toBe(true)
    const afterFirst = { ...issued.reads }
    expect(afterFirst.resource).toBeGreaterThan(0)
    expect(afterFirst.server).toBeGreaterThan(0)
    // A second attempt starts from the stored discovery state.
    await service.signInFromClient('remote')
    expect(issued.reads).toEqual(afterFirst)
  })

  it('refuses a second response for the same state, so a replay cannot re-authorize', async () => {
    const issued = await authority()
    const { ctx, service } = await mount()
    await service.saveFromClient(oauthInput(issued.origin))
    const started = await service.signInFromClient('remote')
    if (!started.ok) throw new Error(started.message)
    const authorized = await fetch(started.data, { redirect: 'manual' })
    const callback = new URL(authorized.headers.get('location') ?? '')
    expect((await answerCallback(ctx, callback.searchParams)).status).toBe(200)
    const replay = await answerCallback(ctx, callback.searchParams)
    expect(replay.status).toBe(400)
    expect(replay.body).toContain('no sign-in is waiting')
  })

  it('renews a valid stored refresh grant without another browser page', async () => {
    const issued = await authority()
    const { ctx, service, credentials } = await mount()
    await service.saveFromClient(oauthInput(issued.origin))
    const started = await service.signInFromClient('remote')
    if (!started.ok) throw new Error(started.message)
    const authorized = await fetch(started.data, { redirect: 'manual' })
    const callback = new URL(authorized.headers.get('location') ?? '')
    expect((await answerCallback(ctx, callback.searchParams)).status).toBe(200)
    expect(await service.signInFromClient('remote')).toMatchObject({ ok: true, data: '' })
    expect(issued.exchanges).toEqual(['authorization_code', 'refresh_token'])
    expect([...credentials.values.values()]).toContain(`Bearer ${issued.token}`)
  })

  it('drops only the pending attempt for the signed-out server', async () => {
    const issued = await authority()
    const { ctx, service } = await mount()
    await service.saveFromClient(oauthInput(issued.origin))
    await service.saveFromClient({ ...oauthInput(issued.origin), name: 'other' })
    const first = await service.signInFromClient('remote')
    const second = await service.signInFromClient('other')
    if (!first.ok || !second.ok) throw new Error('Fixture sign-in was unavailable')
    const callback = async (url: string) => {
      const response = await fetch(url, { redirect: 'manual' })
      return new URL(response.headers.get('location') ?? '').searchParams
    }
    const firstParams = await callback(first.data)
    const secondParams = await callback(second.data)
    expect((await service.signOutFromClient('remote')).ok).toBe(true)
    expect(await answerCallback(ctx, firstParams)).toMatchObject({ status: 400 })
    expect(await answerCallback(ctx, secondParams)).toMatchObject({ status: 200, body: expect.stringContaining('"other"') })
  })

  it('uses the previously read grant when a token read is temporarily unavailable after refresh', async () => {
    const issued = await authority()
    const { ctx, credentials } = await mount()
    const serverUrl = `${issued.origin}/mcp`
    await expect(authorizationHeader(ctx, 'remote', serverUrl)).rejects.toThrow('no stored OAuth grant')
    await oauthProvider(ctx, 'remote').saveTokens({ access_token: 'fixture-stored', token_type: '' })
    const tokenSlot = mcpOAuthSlotRef('remote', 'tokens')
    const resolve = credentials.resolve.bind(credentials)
    let reads = 0
    vi.spyOn(credentials, 'resolve').mockImplementation((ref) => {
      if (String(ref) === tokenSlot && ++reads > 1) return Promise.resolve(undefined)
      return resolve(ref)
    })
    try {
      await expect(authorizationHeader(ctx, 'remote', serverUrl)).resolves.toBe('Bearer fixture-stored')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reports an untyped credential-store failure without returning its value', async () => {
    const issued = await authority()
    const { ctx, service, credentials } = await mount()
    await service.saveFromClient(oauthInput(issued.origin))
    const started = await service.signInFromClient('remote')
    if (!started.ok) throw new Error(started.message)
    const authorized = await fetch(started.data, { redirect: 'manual' })
    const callback = new URL(authorized.headers.get('location') ?? '')
    const set = credentials.set.bind(credentials)
    vi.spyOn(credentials, 'set').mockImplementation((ref, value) => String(ref) === mcpCredentialRef('remote', 'Authorization')
      ? Promise.reject('fixture error containing a private value') : set(ref, value))
    try {
      expect(await answerCallback(ctx, callback.searchParams)).toEqual({
        status: 400, body: 'The sign-in could not be completed: unknown error',
      })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reports an incomplete request URL and a missing definition without changing state', async () => {
    const { origin, service } = await mount({ omitRequestUrl: true })
    const callback = await fetch(`${origin}${OAUTH_CALLBACK_PATH}?code=fixture&state=fixture`)
    expect(callback.status).toBe(400)
    expect(await callback.text()).toContain('response is incomplete')
    expect(await service.signOutFromClient('missing')).toMatchObject({ ok: false, code: 'not_found' })
  })
})
