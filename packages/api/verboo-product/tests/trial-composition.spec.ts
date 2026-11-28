/** The shipped product service, composed by Loader from YAML, against an external HTTP fixture. */
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { VerbooProduct } from '../src/index.ts'
import type { BillingSubscriptionId, PlanId, TrialId, TrialAttemptId } from '../src/types.ts'

class FixtureAccount extends DeepSeekAccount {
  getState = vi.fn<DeepSeekAccount['getState']>()
  getProfile = vi.fn<DeepSeekAccount['getProfile']>()
  getBalance = vi.fn<DeepSeekAccount['getBalance']>()
  getUnnotifiedBonuses = vi.fn<DeepSeekAccount['getUnnotifiedBonuses']>()
  ackBonusNotified = vi.fn<DeepSeekAccount['ackBonusNotified']>()
  startSignIn = vi.fn<DeepSeekAccount['startSignIn']>()
  cancelSignIn = vi.fn<DeepSeekAccount['cancelSignIn']>()
  signOut = vi.fn<DeepSeekAccount['signOut']>()
  watch = vi.fn<DeepSeekAccount['watch']>()
  resolveToken = vi.fn<DeepSeekAccount['resolveToken']>().mockResolvedValue('fixture-grant')
  rejectToken = vi.fn<DeepSeekAccount['rejectToken']>()
  getPlatformSession = vi.fn<DeepSeekAccount['getPlatformSession']>().mockResolvedValue({ sessionId: 'fixture' as AccountSessionId, origin: 'https://fixture.invalid', token: 'fixture-grant', userId: null })
  getDeviceIdentity = vi.fn<DeepSeekAccount['getDeviceIdentity']>()
}
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while(cleanup.length) await cleanup.pop()?.() })

it('composes native trial pricing and explicit Pix authorization, with one account-bound checkout',async()=>{
  const group='00000000-0000-4000-8000-000000000001' as PlanId
  const attempt='00000000-0000-4000-8000-000000000002' as TrialAttemptId
  const writes:unknown[]=[]
  const server=createServer((req,res)=>{
    void (async()=>{
      expect(req.headers.authorization).toBe('Bearer fixture-grant')
      let data:unknown
      if(req.url==='/api/me/subscriptions')data=[]
      else if(req.url?.startsWith('/api/marketplace'))data=[{ id:group,slug:'pro',name:'Pro',description:'Code every day',currency:'usd',priceCents:6900,billingInterval:'month' }]
      else if(req.url==='/api/me/trial-status')data={ asOf:new Date().toISOString(),trials:[{ id:'tokens:'+group,groupId:group,source:'free_tokens',state:'ended',tokensRemaining:0 }] }
      else if(req.url==='/api/me/checkout/quotes')data={ available:true,quoteId:'host-only-pix-authorization',expiresAt:new Date(Date.now()+300000).toISOString(),initialAmountMinor:36118,renewalAmountMinor:36118,currency:'brl',paymentMethods:['pix'],pixAvailable:true,pixMandateAmountMinor:37383,billingInterval:'month' }
      else if(req.url===`/api/me/groups/${group}/checkout`){
        let raw='';for await(const chunk of req)raw+=String(chunk)
        writes.push(JSON.parse(raw))
        expect(req.headers['x-verboo-operation-id']).toBe(attempt)
        data={ mode:'stripe',attemptId:attempt,url:'https://checkout.stripe.com/original' }
      }else{res.writeHead(404).end('{}');return}
      res.writeHead(200,{ 'content-type':'application/json' }).end(JSON.stringify({ data }))
    })().catch((error:unknown)=>{res.destroy(error instanceof Error?error:new Error('fixture failed'))})
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>{resolve()}))})
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture listener missing')
  const origin=`http://127.0.0.1:${address.port}`
  const home=await mkdtemp(join(tmpdir(),'verboo-trial-composition-'))
  cleanup.push(()=>rm(home,{ recursive:true,force:true }))
  const path=join(home,'cordis.yml')
  await writeFile(path,`- name: cordis:account\n- name: cordis:product\n  config:\n    apiOrigin: ${origin}\n    routerBaseURL: ${origin}/router/v1\n    allowLoopbackHttp: true\n`)
  const ctx=new Context();cleanup.push(()=>ctx.fiber.dispose());ctx.baseUrl=pathToFileURL(path).href
  await ctx.plugin(Loader);Object.assign(ctx.loader.builtins,{ include:Include,account:FixtureAccount,product:VerbooProduct })
  await ctx.loader.create({ name:'cordis:include',config:{ path:pathToFileURL(path).href } });await ctx.loader.await()
  const offered=await ctx.verbooProduct.trialOffer(('tokens:'+group) as TrialId,group,'pix')
  expect(offered.ok).toBe(true);if(!offered.ok)throw new Error('offer unavailable')
  expect(offered.data).toMatchObject({ currency:'BRL',amountMinor:36118,paymentMethod:'pix' })
  expect(JSON.stringify(offered.data)).not.toContain('host-only-pix-authorization')
  expect(writes).toHaveLength(0)
  const first=await ctx.verbooProduct.confirmTrialOffer(offered.data.id,'pix',attempt)
  expect(first).toMatchObject({ ok:true,data:{ status:'requires_action',attemptId:attempt } })
  await ctx.verbooProduct.confirmTrialOffer(offered.data.id,'pix',attempt)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ quotedPaymentMethod:'pix',requestId:attempt,subscribeNow:true })
  await ctx.fiber.dispose()
  expect(ctx.get('verbooProduct')).toBeUndefined()
})

it('reopens the Host and reconciles a lost card response to the original canonical attempt', async () => {
  const group = '00000000-0000-4000-8000-000000000011' as PlanId
  const canonical = '00000000-0000-4000-8000-000000000012'
  const account = '00000000-0000-4000-8000-000000000013' as AccountUserId
  let requestId = ''
  const checkoutBodies: string[] = []
  let allowLookup = true
  let rejectCheckout = false
  let cardFailed = false
  const writes: Array<{ path: string; identity: string[] }> = []
  const identity = (headers: Record<string, string | string[] | undefined>) =>
    ['x-verboo-journey-id', 'x-verboo-operation-id', 'x-request-id'].map(key => String(headers[key]))
  const subscription = '00000000-0000-4000-8000-000000000015' as BillingSubscriptionId
  const priorCancellation = '00000000-0000-4000-8000-000000000016'
  const newCancellation = '00000000-0000-4000-8000-000000000017'
  const lifecyclePath = '/api/me/subscriptions/' + subscription + '/'
  const accessUntil = '2027-01-04T12:00:00Z'
  let renewalStopped = false
  let cancellationOperation = priorCancellation
  let cancellationStatus = 'pending'
  let reactivated = false
  let cancellationReads = 0
  const cancelIdentity: string[][] = []

  const server = createServer((req, res) => {
    void (async () => {
      let data: unknown
      if (req.url === '/api/me/checkout/quotes') {
        data = {
          available: true, quoteId: 'private-card-quote', expiresAt: new Date(Date.now() + 30_000).toISOString(),
          initialAmountMinor: 5000, renewalAmountMinor: 6000, currency: 'usd', paymentMethods: ['card'],
          groupId: group, billingInterval: 'month', purchaseType: 'individual', offer: 'subscription', quantity: 1,
        }
      } else if (req.url === '/api/me/groups/' + group + '/checkout') {
        writes.push({ path: req.url, identity: identity(req.headers) })
        let raw = ''
        for await (const chunk of req) raw += String(chunk)
        checkoutBodies.push(raw)
        const request = JSON.parse(raw)
        requestId = request.requestId
        expect(req.headers['x-request-id']).toBe(requestId)
        expect(request.checkoutQuoteId).toBe('private-card-quote')
        expect(request.quotedPaymentMethod).toBe('card')
        if (rejectCheckout) {
          res.writeHead(422, { 'x-verboo-checkout-not-started': 'true' }).end('{}')
          return
        }
        if (checkoutBodies.length !== 3) {
          res.destroy()
          return
        }
        data = { mode: 'stripe', attemptId: canonical, url: 'https://checkout.stripe.com/resumed' }
      } else if (req.url === '/api/me/purchase-attempts/' + canonical + '/resume') {
        expect(identity(req.headers)).toEqual(writes.at(-1)?.identity)
        data = { mode: 'stripe', attemptId: canonical, url: 'https://checkout.stripe.com/resumed' }
      } else if (req.url === '/api/me/purchase-attempts/by-request/' + requestId + '/close-unstarted') {
        expect(identity(req.headers)).toEqual(writes.at(-1)?.identity)
        data = { requestId, closed: true }
      } else if (req.url === '/api/me/subscriptions') {
        data = [{
          id: subscription, status: 'active', cancelAtPeriodEnd: renewalStopped && !reactivated,
          management: { cancelSubscription: !renewalStopped, reactivateSubscription: renewalStopped && !reactivated },
          cancellation: renewalStopped ? { collectionStatus: 'stopped', localStatus: 'complete', accessUntil, operationId: newCancellation } :
            { collectionStatus: 'stopped', localStatus: 'complete', accessUntil, operationId: priorCancellation },
        }]
      } else if (req.url === lifecyclePath + 'cancel' || req.url === lifecyclePath + 'reactivate') {
        writes.push({ path: req.url, identity: identity(req.headers) })
        if (req.url.endsWith('/cancel')) {
          let raw = ''
          for await (const chunk of req) raw += String(chunk)
          expect(JSON.parse(raw)).toEqual({ locale: 'pt' })
        }
        res.destroy()
        return
      } else if (req.url === lifecyclePath + 'cancellation') {
        cancellationReads++
        cancelIdentity.push(identity(req.headers))
        data = { operationId: cancellationOperation, collectionStatus: cancellationStatus,
          localStatus: cancellationStatus === 'stopped' ? 'complete' : 'pending', accessUntil }
      } else if (allowLookup && requestId !== '' && (req.url === '/api/me/purchase-attempts/by-request/' + requestId ||
                 req.url === '/api/me/purchase-attempts/' + canonical)) {
        data = { id: canonical, groupId: group, billingInterval: 'month', kind: 'subscription', provider: 'stripe',
          status: cardFailed ? 'requires_action' : 'succeeded', ...(cardFailed ? { errorCode: 'invoice_payment_failed' } : {}) }
      } else {
        res.writeHead(404).end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    })().catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error('fixture failed')) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener missing')
  const origin = 'http://127.0.0.1:' + address.port
  const home = await mkdtemp(join(tmpdir(), 'verboo-card-composition-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'cordis.yml')
  await writeFile(path, [
    '- name: cordis:storage', '- name: cordis:storageJson', '  config:', '    root: ' + join(home, 'data'),
    '- name: cordis:storageDomain', '  config:', '    backend: json', '- name: cordis:account', '- name: cordis:product', '  config:',
    '    apiOrigin: ' + origin, '    routerBaseURL: ' + origin + '/router/v1', '    allowLoopbackHttp: true',
  ].join('\n'))
  const boot = async (userId: AccountUserId) => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    ctx.baseUrl = pathToFileURL(path).href
    await ctx.plugin(Loader)
    class Account extends FixtureAccount {
      override getPlatformSession = vi.fn<DeepSeekAccount['getPlatformSession']>()
        .mockResolvedValue({ sessionId: 'fixture' as AccountSessionId, origin, token: 'fixture-grant', userId })
    }
    Object.assign(ctx.loader.builtins, {
      include: Include, account: Account, product: VerbooProduct,
      storage: Storage, storageJson: StorageJson, storageDomain: StorageDomain,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    return ctx
  }
  const first = await boot(account)
  const quote = await first.verbooProduct.quotePurchase(group, 'month')
  if (!quote.ok) throw new Error('card quote unavailable')
  expect(JSON.stringify(quote.data)).not.toContain('private-card-quote')
  const started = await first.verbooProduct.confirmPurchase(quote.data.id)
  expect(started).toMatchObject({ ok: true, data: { status: 'unconfirmed' } })
  expect(checkoutBodies).toHaveLength(1)
  await first.fiber.dispose()

  const other = await boot('00000000-0000-4000-8000-000000000014' as AccountUserId)
  expect(await other.verbooProduct.currentPurchase(new AbortController().signal)).toEqual({ ok: true, data: null })
  await other.fiber.dispose()

  const restarted = await boot(account)
  const signal = new AbortController().signal
  const settled = await restarted.verbooProduct.currentPurchase(new AbortController().signal)
  expect(settled).toMatchObject({ ok: true, data: { id: canonical, status: 'succeeded' } })
  if (!settled.ok || !settled.data) throw new Error('recovered attempt was not available')
  expect(await restarted.verbooProduct.retryPurchase(settled.data.id))
    .toMatchObject({ ok: true, data: { status: 'succeeded' } })
  expect(checkoutBodies).toHaveLength(1)
  expect(await restarted.verbooProduct.dismissPurchase(settled.data.id)).toEqual({ ok: true, data: true })

  allowLookup = false
  const nextQuote = await restarted.verbooProduct.quotePurchase(group, 'month')
  if (!nextQuote.ok) throw new Error('second card quote unavailable')
  const unknown = await restarted.verbooProduct.confirmPurchase(nextQuote.data.id)
  if (!unknown.ok) throw new Error('second checkout was not submitted')
  expect(unknown.data.status).toBe('unconfirmed')
  expect(await restarted.verbooProduct.currentPurchase(new AbortController().signal))
    .toMatchObject({ ok: true, data: { status: 'unconfirmed', canRetry: true } })
  expect(await restarted.verbooProduct.retryPurchase(unknown.data.id))
    .toMatchObject({ ok: true, data: { id: canonical, status: 'requires_action' } })
  expect(checkoutBodies).toHaveLength(3)
  expect(checkoutBodies[2]).toBe(checkoutBodies[1])
  expect(writes[2]?.identity).toEqual(writes[1]?.identity)
  expect(await restarted.verbooProduct.resumePurchase(canonical as typeof unknown.data.id))
    .toEqual({ ok: true, data: 'https://checkout.stripe.com/resumed' })
  allowLookup = true
  cardFailed = true
  expect(await restarted.verbooProduct.currentPurchase(signal))
    .toMatchObject({ ok: true, data: { id: canonical, status: 'requires_action', declined: true } })
  cardFailed = false
  expect(await restarted.verbooProduct.dismissPurchase(canonical as typeof unknown.data.id)).toEqual({ ok: true, data: true })

  rejectCheckout = true
  const rejectedQuote = await restarted.verbooProduct.quotePurchase(group, 'month')
  if (!rejectedQuote.ok) throw new Error('review unavailable')
  expect(await restarted.verbooProduct.confirmPurchase(rejectedQuote.data.id)).toEqual({ ok: false, code: 'checkout_rejected' })
  expect(await restarted.verbooProduct.currentPurchase(signal)).toEqual({ ok: true, data: null })

  rejectCheckout = false
  allowLookup = false
  const expiredQuote = await restarted.verbooProduct.quotePurchase(group, 'month')
  if (!expiredQuote.ok) throw new Error('review unavailable')
  const unconfirmed = await restarted.verbooProduct.confirmPurchase(expiredQuote.data.id)
  if (!unconfirmed.ok) throw new Error('checkout unavailable')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiredQuote.data.expiresAt) + 1000)
  try {
    expect(await restarted.verbooProduct.currentPurchase(signal))
      .toMatchObject({ ok: true, data: { status: 'unconfirmed', canAbandon: true, canRetry: false } })
    expect(await restarted.verbooProduct.abandonPurchase(unconfirmed.data.id))
      .toMatchObject({ ok: true, data: { status: 'abandoned', closedUnstarted: true } })
    expect(await restarted.verbooProduct.dismissPurchase(unconfirmed.data.id)).toEqual({ ok: true, data: true })
  } finally {
    clock.mockRestore()
  }

  expect(await restarted.verbooProduct.updateSubscription(subscription, 'cancel', 'pt-BR'))
    .toMatchObject({ ok: true, data: { action: 'cancel', status: 'unconfirmed' } })
  expect(await restarted.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal))
    .toMatchObject({ ok: true, data: { status: 'unconfirmed' } })
  expect(cancellationReads).toBe(1)
  expect(cancelIdentity[0]).toEqual(writes.at(-1)?.identity)
  await restarted.fiber.dispose()

  const wrongOwner = await boot('00000000-0000-4000-8000-000000000014' as AccountUserId)
  expect(await wrongOwner.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal)).toEqual({ ok: true, data: null })
  expect(cancellationReads).toBe(1)
  await wrongOwner.fiber.dispose()

  const recovered = await boot(account)
  cancellationOperation = newCancellation
  expect(await recovered.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal))
    .toMatchObject({ ok: true, data: { status: 'pending', cancellation: { operationId: newCancellation, accessUntil } } })
  cancellationOperation = priorCancellation
  cancellationStatus = 'stopped'
  expect(await recovered.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal))
    .toMatchObject({ ok: true, data: { status: 'pending', cancellation: { operationId: newCancellation } } })
  cancellationOperation = newCancellation
  renewalStopped = true
  expect(await recovered.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal))
    .toMatchObject({ ok: true, data: { status: 'confirmed', cancellation: { operationId: newCancellation, accessUntil } } })
  expect(writes.filter(write => write.path.endsWith('/cancel'))).toHaveLength(1)

  expect(await recovered.verbooProduct.updateSubscription(subscription, 'reactivate'))
    .toMatchObject({ ok: true, data: { action: 'reactivate', status: 'unconfirmed' } })
  await recovered.verbooProduct.updateSubscription(subscription, 'reactivate')
  expect(await recovered.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal))
    .toMatchObject({ ok: true, data: { action: 'reactivate', status: 'unconfirmed' } })
  reactivated = true
  expect(await recovered.verbooProduct.currentSubscriptionLifecycle(subscription, false, signal))
    .toMatchObject({ ok: true, data: { action: 'reactivate', status: 'confirmed' } })
  expect(writes.filter(write => write.path.endsWith('/reactivate'))).toHaveLength(1)
})
