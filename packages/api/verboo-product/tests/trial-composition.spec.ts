/** The shipped product service, composed by Loader from YAML, against an external HTTP fixture. */
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId } from '@deepseek-ai/dsh-deepseek-account/types'
import { VerbooProduct } from '../src/index.ts'
import type { PlanId, TrialId, TrialAttemptId } from '../src/types.ts'

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
