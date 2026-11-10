/** Real Loader composition of Verboo login, encrypted credentials and the shared model transport. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Authorization from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { VerbooAccount } from '../src/account.ts'
import { GrantVault } from '../src/vault.ts'
import { Config, deploymentOf } from '../src/config.ts'
import * as Models from '../src/models.ts'

const metadata = { version: 'fixture', locale: 'pt', timezoneOffsetSeconds: 0 }
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await delay(10)
  }
  throw new Error('Fixture state did not settle')
}

async function fixture(
  options: { expiresIn?: number; attemptTimeoutMs?: number } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'verboo-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const requests: Array<{
    path: string
    authorization?: string | undefined
    body: string
    journey?: string
    operation?: string
    requestId?: string
  }> = []
  const state = {
    exchanges: 0,
    refreshes: 0,
    inferences: 0,
    inferenceMalformed: false,
    inferenceStatus: 200,
    profileStatus: 200,
    rejectRefresh: false,
    collectionDown: false,
    catalogFailures: 0,
  }
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body = ''
    for await (const part of req) body += String(part)
    requests.push({
      path: req.url ?? '/',
      authorization: req.headers.authorization,
      body,
      journey: String(req.headers['x-verboo-journey-id'] ?? ''),
      operation: String(req.headers['x-verboo-operation-id'] ?? ''),
      requestId: String(req.headers['x-request-id'] ?? ''),
    })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/oauth/token') {
      const form = new URLSearchParams(body)
      const refresh = form.get('grant_type') === 'refresh_token'
      if (refresh) state.refreshes++
      else state.exchanges++
      if (refresh && state.rejectRefresh) {
        res.writeHead(400).end('{"error":"invalid_grant"}')
        return
      }
      res.end(
        JSON.stringify({
          access_token: `fixture-access-${state.exchanges}-${state.refreshes}`,
          refresh_token: `fixture-refresh-${state.exchanges}-${state.refreshes}`,
          token_type: 'Bearer',
          expires_in: refresh ? 3600 : (options.expiresIn ?? 3600),
        }),
      )
    } else if (req.url === '/api/me') {
      if (state.profileStatus !== 200) {
        res.writeHead(state.profileStatus).end('{}')
        return
      }
      res.end(
        JSON.stringify({
          data: {
            id: '9cc3776a-84bf-4ea8-ac35-0916d7ed57f1',
            name: 'Fixture account',
            email: 'fixture@example.invalid',
          },
        }),
      )
    } else if (req.url === '/api/me/token-wallet') {
      res.end(
        JSON.stringify({ data: { currency: 'usd', balanceUsd: '12.340000' } }),
      )
    } else if (req.url === '/router/v1/models') {
      if (state.catalogFailures-- > 0) {
        res.writeHead(503).end('{}')
        return
      }
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'max/qwen3.6-27b',
              display_name: 'Qwen fixture',
              context_length: 65536,
              max_output_tokens: 4096,
            },
          ],
        }),
      )
    } else if (req.url === '/router/v1/chat/completions') {
      state.inferences++
      if (state.inferenceStatus !== 200) {
        res
          .writeHead(state.inferenceStatus)
          .end('{"error":{"message":"fixture rejection"}}')
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      for (const chunk of state.inferenceMalformed ? [
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
          { index: 0, id: 'duplicate', type: 'function', function: { name: 'count', arguments: '{}' } },
          { index: 1, id: 'duplicate', type: 'function', function: { name: 'count', arguments: '{}' } },
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
      ] : [
        {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Olá Verboo' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'max/qwen3.6-27b', ...chunk })}\n\n`,
        )
      res.end('data: [DONE]\n\n')
    } else if (req.url === '/api/journey/events') {
      if (state.collectionDown) {
        res.writeHead(503).end('{}')
        return
      }
      const data = JSON.parse(body) as {
        schemaVersion: number
        events: Array<{ eventId: string; journeyId: string }>
      }
      res.writeHead(202).end(
        JSON.stringify({
          data: {
            receipts: data.events.map(event => ({
              eventId: event.eventId,
              journeyId: event.journeyId,
              clientApp: '',
              payloadSha256: createHash('sha256')
                .update(`${data.schemaVersion}:${JSON.stringify(event)}`)
                .digest('hex'),
            })),
          },
        }),
      )
    } else if (req.url === '/oauth/revoke') res.writeHead(200).end()
    else res.writeHead(404).end('{}')
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error('fixture request failed')) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() =>{  resolve() }))
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Fixture listener unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  let secret: number[] | null = null
  const vault = new GrantVault(origin, home, {
    async getSecret() {
      return secret
    },
    async setSecret(value) {
      secret = [...value]
    },
  })
  class FixtureAccount extends VerbooAccount {
    constructor(ctx: Context, config: Config) {
      super(ctx, config, vault)
    }
  }
  const credentialsPath = join(home, 'credentials.yaml')
  const configPath = join(home, 'cordis.yml')
  await writeFile(
    configPath,
    [
      '- name: cordis:credentials',
      '  config:',
      `    path: ${JSON.stringify(credentialsPath)}`,
      '    watch: false',
      '- name: cordis:authorization',
      '- name: cordis:llm',
      '- name: cordis:web',
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '- name: cordis:account',
      '  config:',
      `    apiOrigin: ${origin}`,
      `    routerBaseURL: ${origin}/router/v1`,
      '    allowLoopbackHttp: true',
      `    attemptTimeoutMs: ${options.attemptTimeoutMs ?? 5000}`,
      '    requestTimeoutMs: 1000',
      '- name: cordis:models',
      '  config:',
      `    apiOrigin: ${origin}`,
      `    routerBaseURL: ${origin}/router/v1`,
      '    allowLoopbackHttp: true',
      '    requestTimeoutMs: 1000',
      '',
    ].join('\n'),
  )
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(configPath).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    credentials: LocalCredentialProvider,
    authorization: Authorization,
    llm: LlmRuntime,
    web: WebServer,
    account: FixtureAccount,
    models: Models,
  })
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  async function begin() {
    await ctx.deepseekAccount.startSignIn(metadata, callbackOrigin, 'desktop')
    await until(
      async () =>
        (await ctx.deepseekAccount.getState()).attempt?.phase ===
        'waiting-browser',
    )
    const view = await ctx.deepseekAccount.getState()
    if (!view.attempt?.authorizeUrl)
      throw new Error('Fixture authorization URL missing')
    return { view, authorize: new URL(view.attempt.authorizeUrl) }
  }
  async function login() {
    const attempt = await begin()
    const callback = new URL('/callback', callbackOrigin)
    callback.searchParams.set(
      'state',
      attempt.authorize.searchParams.get('state') ?? '',
    )
    callback.searchParams.set('code', 'fixture-code')
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Verboo Code')
    await until(
      async () =>
        (await ctx.deepseekAccount.getState()).attempt?.phase === 'succeeded',
    )
    return attempt
  }
  return {
    ctx,
    home,
    origin,
    requests,
    state,
    vault,
    credentialsPath,
    callbackOrigin,
    begin,
    login,
  }
}

it('composes PKCE login, encrypted storage, exact account models and streaming through cordis.yml', async () => {
  const app = await fixture()
  const { authorize } = await app.login()
  expect(authorize.origin).toBe(app.origin)
  expect(authorize.pathname).toBe('/oauth/authorize')
  expect(authorize.searchParams.get('client_id')).toBe('verboo-code-cli')
  expect(authorize.searchParams.get('scope')).toBe(
    'user:profile user:inference',
  )
  const exchange = new URLSearchParams(
    app.requests.find(value => value.path === '/oauth/token')?.body,
  )
  expect(
    createHash('sha256')
      .update(exchange.get('code_verifier') ?? '')
      .digest('base64url'),
  ).toBe(authorize.searchParams.get('code_challenge'))
  expect(exchange.get('redirect_uri')).toBe(`${app.callbackOrigin}/callback`)
  const publicView = JSON.stringify(await app.ctx.deepseekAccount.getState())
  expect(publicView).not.toContain('fixture-access')
  expect(publicView).not.toContain('fixture-refresh')
  expect(publicView).not.toContain(exchange.get('code_verifier'))
  const file = await readFile(app.credentialsPath, 'utf8')
  expect(file).not.toContain('fixture-access')
  expect(file).not.toContain('fixture-refresh')
  expect(file).toContain('ciphertext')
  expect(await app.ctx.deepseekAccount.getProfile(metadata)).toMatchObject({
    status: 'ready',
    value: { name: 'Fixture account' },
  })
  expect(await app.ctx.deepseekAccount.getBalance(metadata)).toBeNull()
  expect(
    app.requests.some(request => request.path === '/api/me/token-wallet'),
  ).toBe(false)
  const models = await app.ctx.llm.listModels('deepseek-account')
  expect(models.map(model => model.id)).toEqual(['max/qwen3.6-27b'])
  expect(app.ctx.llm.providerRetryPolicy('deepseek-account')).toMatchObject({
    mode: 'normal', maxRetries: 5, maxRetriesByCode: { MALFORMED_RESPONSE: 1 },
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of app.ctx.llm.stream({
    provider: 'deepseek-account',
    model: models[0]!.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Olá' }] }],
  }))
    chunks.push(chunk)
  const text = chunks
    .flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.text] : []))
    .join('')
  expect(text).toBe('Olá Verboo')
  expect(app.state.inferences).toBe(1)
  const inference = app.requests.find(
    value => value.path === '/router/v1/chat/completions',
  )
  expect(inference?.authorization).toBe('Bearer fixture-access-1-0')
  expect(inference?.requestId).toMatch(/^[0-9a-f-]{36}$/)
  expect(JSON.parse(inference?.body ?? '{}')).toMatchObject({ model:'max/qwen3.6-27b' })
  expect({
    phase: (await app.ctx.deepseekAccount.getState()).attempt?.phase,
    provider: app.ctx.llm
      .listProviders()
      .find(provider => provider.id === 'deepseek-account')?.name,
    models: models.map(model => model.id),
    text,
  }).toMatchInlineSnapshot(`
    {
      "models": [
        "max/qwen3.6-27b",
      ],
      "phase": "succeeded",
      "provider": "Verboo Code",
      "text": "Olá Verboo",
    }
  `)
})

it('reports a malformed account response without exposing tool arguments', async () => {
  const app = await fixture()
  await app.login()
  await app.ctx.llm.listModels('deepseek-account')
  app.state.inferenceMalformed = true
  const chunks: StreamChunk[] = []
  for await (const chunk of app.ctx.llm.stream({ provider: 'deepseek-account', model: 'max/qwen3.6-27b', messages: [] })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: {
    code: 'MALFORMED_RESPONSE', message: 'O modelo retornou uma chamada de ferramenta inválida. Tente novamente.',
    requestId: 'fixture-completion',
  } } })
  expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
  expect(app.state.inferences).toBe(1)
})

it('rejects forged callbacks and removes only the cancelled attempt route', async () => {
  const app = await fixture()
  const { view } = await app.begin()
  const invalid = await fetch(
    `${app.callbackOrigin}/callback?code=fixture-code&state=forged`,
  )
  expect(invalid.status).toBe(400)
  expect(app.state.exchanges).toBe(0)
  await app.ctx.deepseekAccount.cancelSignIn(view.attempt!.id)
  expect((await app.ctx.deepseekAccount.getState()).attempt?.phase).toBe(
    'cancelled',
  )
  expect(
    (
      await fetch(
        `${app.callbackOrigin}/callback?code=fixture-code&state=forged`,
      )
    ).status,
  ).toBe(404)
  expect((await app.ctx.deepseekAccount.getState()).status).toBe('signed-out')
})

it('distinguishes explicit denial from a technical authorization expiry', async () => {
  const app = await fixture({ attemptTimeoutMs: 300 })
  const { authorize } = await app.begin()
  await fetch(
    `${app.callbackOrigin}/callback?error=access_denied&state=${authorize.searchParams.get('state')}`,
  )
  expect((await app.ctx.deepseekAccount.getState()).attempt?.phase).toBe(
    'cancelled',
  )
  await app.begin()
  await until(
    async () =>
      (await app.ctx.deepseekAccount.getState()).attempt?.phase === 'expired',
  )
  expect(app.state.exchanges).toBe(0)
})

it('serializes refresh rotation and refuses credentials outside the configured gateway', async () => {
  const app = await fixture({ expiresIn: 30 })
  await app.login()
  const tokens = await Promise.all(
    [1, 2, 3].map(() =>
      app.ctx.deepseekAccount.resolveToken(
        `${app.origin}/router/v1/chat/completions`,
      ),
    ),
  )
  expect(new Set(tokens)).toEqual(new Set(['fixture-access-1-1']))
  expect(app.state.refreshes).toBe(1)
  expect(
    await app.ctx.deepseekAccount.resolveToken(
      'https://api.deepseek.com/anthropic',
    ),
  ).toBeUndefined()
  expect(
    await app.ctx.deepseekAccount.resolveToken(`${app.origin}/unrelated`),
  ).toBeUndefined()
})

it('expires an invalid refresh grant without deleting a later login', async () => {
  const app = await fixture({ expiresIn: 30 })
  await app.login()
  app.state.rejectRefresh = true
  expect(
    await app.ctx.deepseekAccount.resolveToken(`${app.origin}/router/v1`),
  ).toBeUndefined()
  expect((await app.ctx.deepseekAccount.getState()).status).toBe('signed-out')
  app.state.rejectRefresh = false
  await app.login()
  await app.ctx.deepseekAccount.rejectToken('fixture-access-1-0')
  expect((await app.ctx.deepseekAccount.getState()).status).toBe(
    'credential-stored',
  )
})

it('does not send a previously prepared prompt using a different login', async () => {
  const app = await fixture()
  await app.login()
  const prepared = await app.ctx.llm.prepareCall({
    provider: 'deepseek-account',
    model: 'max/qwen3.6-27b',
  })
  await app.login()
  const stream = async () => {
    for await (const _chunk of prepared.stream({
      provider: 'deepseek-account',
      model: 'max/qwen3.6-27b',
      messages: [],
    })) {
      /* Drain until identity admission fails. */
    }
  }
  await expect(stream()).rejects.toMatchObject({
    code: 'INVALID_PREPARED_CALL',
  })
  expect(app.state.inferences).toBe(0)
})

it('keeps immutable anonymous observations during collector failure and confirms their exact replay', async () => {
  const app = await fixture()
  app.state.collectionDown = true
  await app.login()
  const key = credentialKey('verboo-account', 'observations')
  await until(
    async () =>
      app.requests.filter(value => value.path === '/api/journey/events')
        .length >= 3,
  )
  await until(async () =>
    JSON.stringify(await app.ctx.credentials.readRecord(key)).includes(
      'succeeded',
    ),
  )
  const before = await app.ctx.credentials.readRecord(key)
  expect(before?.kind).toBe('grant')
  expect(JSON.stringify(before)).toContain('succeeded')
  expect(JSON.stringify(before)).not.toContain('fixture-access')
  const original =
    before?.kind === 'grant' ? JSON.stringify(before.payload) : ''
  expect(
    app.requests
      .filter(value => value.path === '/api/journey/events')
      .every(value => value.authorization === undefined),
  ).toBe(true)
  app.state.collectionDown = false
  await app.login()
  await until(async () => {
    const current = await app.ctx.credentials.readRecord(key)
    return (
      current?.kind === 'grant' &&
      JSON.stringify(current.payload).includes('"pending":[]')
    )
  })
  expect(original).toContain('schemaVersion')
})

it('retains operation identity across safe catalog retries and never retries code exchange', async () => {
  const app = await fixture()
  await app.login()
  app.state.catalogFailures = 2
  expect(await app.ctx.llm.listModels('deepseek-account')).toHaveLength(1)
  const catalog = app.requests.filter(
    value => value.path === '/router/v1/models',
  )
  expect(catalog).toHaveLength(3)
  expect(new Set(catalog.map(value => value.journey)).size).toBe(1)
  expect(new Set(catalog.map(value => value.operation)).size).toBe(1)
  expect(app.state.exchanges).toBe(1)
})

it('signs out locally and revokes the refresh grant with an empty success response', async () => {
  const app = await fixture()
  await app.login()
  expect((await app.ctx.deepseekAccount.signOut(metadata)).status).toBe(
    'signed-out',
  )
  await until(async () =>
    app.requests.some(value => value.path === '/oauth/revoke'),
  )
  expect(
    await app.ctx.deepseekAccount.resolveToken(`${app.origin}/router/v1`),
  ).toBeUndefined()
})

it('expires an inference credential only after the account server confirms revocation', async () => {
  const app = await fixture()
  await app.login()
  app.state.inferenceStatus = 401
  app.state.profileStatus = 401
  const chunks: StreamChunk[] = []
  for await (const chunk of app.ctx.llm.stream({
    provider: 'deepseek-account',
    model: 'max/qwen3.6-27b',
    messages: [],
  }))
    chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'error' },
  })
  expect((await app.ctx.deepseekAccount.getState()).status).toBe('signed-out')
  expect(app.state.inferences).toBe(1)
})

it('preserves a valid account when the gateway rejects an entitlement', async () => {
  const app = await fixture()
  await app.login()
  app.state.inferenceStatus = 403
  for await (const _chunk of app.ctx.llm.stream({
    provider: 'deepseek-account',
    model: 'max/qwen3.6-27b',
    messages: [],
  })) {
    /* consume terminal failure */
  }
  expect((await app.ctx.deepseekAccount.getState()).status).toBe(
    'credential-stored',
  )
})

it('authenticates ciphertext and keeps issuer or installation keys separate', async () => {
  const app = await fixture()
  await app.vault.prepare()
  const sealed = await app.vault.seal({ fixture: 'private grant' })
  expect(await app.vault.open(sealed)).toEqual({ fixture: 'private grant' })
  await expect(
    app.vault.open({
      ...sealed,
      ciphertext: Buffer.from('changed').toString('base64'),
    }),
  ).rejects.toThrow()
  const other = new GrantVault(
    'https://other.example.invalid',
    join(app.home, randomUUID()),
    { getSecret: async () => null, setSecret: async () => undefined },
  )
  await expect(other.open(sealed)).rejects.toThrow()
  expect(() =>
    deploymentOf({ apiOrigin: 'http://remote.example.invalid' }),
  ).toThrow()
})
