// Sign in, then exercise every offered model and its reasoning levels.
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { OpenAiAccount } from '@deepseek-ai/dsh-openai-account'
import Route from '@deepseek-ai/dsh-llm-openai-account'

const REDIRECT = 'http://localhost:1455/auth/callback'
const ctx = new Context()
await ctx.plugin(LlmRuntime)
ctx.provide('credentials', { resolve: async () => undefined, store: async () => undefined })
const account = new OpenAiAccount(ctx, {})
ctx.plugin(Route)
await new Promise(r => setTimeout(r, 300))
const signal = new AbortController().signal

let status = await account.status()
if (!status.signedIn) {
  const started = account.begin(REDIRECT, signal)
  console.log('URL_ABERTA ' + started.url)
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost:1455')
      const ok = OpenAiAccount.stateMatches(started.state, url.searchParams.get('state')) && url.searchParams.get('code') !== null
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(ok ? '<h2>Login concluido. Pode fechar esta aba.</h2>' : '<h2>Falhou</h2>')
      server.close()
      if (ok) resolve(url.searchParams.get('code')); else reject(new Error('state mismatch'))
    })
    server.listen(1455, '127.0.0.1', () => console.log('aguardando callback...'))
    setTimeout(() => { server.close(); reject(new Error('timeout')) }, 2_700_000)
  })
  status = await account.complete(code, started.verifier, REDIRECT, signal)
}
console.log('signedIn:', status.signedIn, '| plan:', status.planType)

const route = ctx.get('llmOpenaiAccount')
const sweep = await route.discoverModels()
console.log('descoberta: aceitos', sweep.supported.length, '| recusados', sweep.unsupported.length)

for (const model of await ctx.llm.listModels('openai-account')) {
  const info = await ctx.llm.resolveModelInfo('openai-account', model.id).catch(() => undefined)
  const efforts = info?.reasoning?.efforts?.map(e => e.id) ?? []
  let text = '', failure
  const t0 = Date.now()
  try {
    for await (const c of ctx.llm.stream({ provider: 'openai-account', model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      system: 'Answer with one word.' })) {
      if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
      if (c.type === 'finish' && c.reason?.kind === 'error') failure = c.reason.failure?.message
    }
  } catch (e) { failure = String(e?.message ?? e) }
  const verdict = failure === undefined ? `OK "${text}"` : `X ${String(failure).slice(0, 45)}`
  console.log(`${model.id.padEnd(20)} ${verdict.padEnd(22)} efforts=[${efforts.join(',')}] ${Date.now()-t0}ms`)
}
await ctx.fiber.dispose()
