/**
 * The [OI] account plugin: one row that owns the credential service and the
 * sign-in surface a dialog addresses.
 *
 * Both are mounted together because the surface cannot answer anything without
 * the service it drives, and a composition that mounts one without the other is
 * a configuration mistake rather than a supported state.
 *
 * @module @deepseek-ai/dsh-openai-account
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config as ConfigShape } from './config.ts'
import { OpenAiAccount } from './account.ts'
import { OpenAiAccountLogin } from './remote.ts'

export { Config, deploymentOf } from './config.ts'
export type { Config as ConfigShape, Deployment } from './config.ts'
export { OpenAiAccount, SERVICE_KEY, claimsOf, pkcePair } from './account.ts'
export { OpenAiAccountLogin } from './remote.ts'
export { AccountHttp, AccountRequestError, operation } from './http.ts'
export type { JsonResponse, Operation as HttpOperation } from './http.ts'
export { GrantVault } from './vault.ts'
export type { SecretKeyStore } from './vault.ts'
export type { OpenAiAccountErrorCode, OpenAiAccountStatus, SignInStart } from './types.ts'

/** Cordis plugin name this package registers under. */
export const name = 'openai-account'

/** The credential store the account writes its sealed grant through. */
export const inject = ['credentials']

/**
 * Mount the account service and the sign-in surface that drives it.
 * @param ctx - owning Cordis context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  ctx.plugin(OpenAiAccount, config)
  ctx.plugin(OpenAiAccountLogin)
}
