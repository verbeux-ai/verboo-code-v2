/** Verboo Code accounts and the account-authorized inference gateway. */
import type { Context } from '@deepseek-ai/cordis'
import { VerbooAccount } from './account.ts'
import * as Models from './models.ts'
import type { Config } from './config.ts'

export { Config } from './config.ts'
export const name = 'verboo-account'
export const inject = ['credentials', 'authorization', 'llm']

/**
 * Mount the Verboo OAuth account provider and its shared OpenAI-compatible model transport.
 * @param ctx - owning product context.
 * @param config - public account and gateway deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(VerbooAccount, config)
  ctx.plugin(Models, config)
}

export { VerbooHttp, AccountRequestError, operation, observe } from './http.ts'
export { deploymentOf } from './config.ts'
