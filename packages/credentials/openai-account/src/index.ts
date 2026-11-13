/**
 * The [OI] account plugin: a Cordis service that owns the browser login, the
 * stored grant, and the plan facts the Client reads.
 *
 * The service key is `openaiAccount`, which the route and the Client both
 * address. Nothing here reads or logs a token; the surface reports plan facts
 * and hands a usable token only to the caller that asks for one.
 *
 * @module @deepseek-ai/dsh-openai-account
 */

export { Config, deploymentOf } from './config.ts'
export type { Config as ConfigShape, Deployment } from './config.ts'
export { OpenAiAccount, SERVICE_KEY, claimsOf, pkcePair } from './account.ts'
export { AccountHttp, AccountRequestError, operation } from './http.ts'
export type { JsonResponse, Operation as HttpOperation } from './http.ts'
export { GrantVault } from './vault.ts'
export { OpenAiAccountLogin } from './remote.ts'
export type { SignInStart } from './types.ts'
export type { SecretKeyStore } from './vault.ts'
export type { OpenAiAccountErrorCode, OpenAiAccountStatus } from './types.ts'

export { OpenAiAccount as default } from './account.ts'
