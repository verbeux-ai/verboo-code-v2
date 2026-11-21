/** Verboo Code accounts and the account-authorized inference gateway. */
import type { Context } from '@deepseek-ai/cordis'
import { VerbooAccount } from './account.ts'
import * as Models from './models.ts'
import type { Config } from './config.ts'
import type { AccountSessionId, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A new local OAuth attempt is starting.
     * @param attemptId - opaque local attempt identity.
     * @mode emit
     */
    'verboo-account/login-started'(attemptId: SignInAttemptId): void
    /**
     * A local OAuth grant was committed; the opaque session ID stays in the Host.
     * @param sessionId - local login identity.
     * @param attemptId - local attempt identity.
     * @param startedAt - UTC timestamp when the user started OAuth, in milliseconds.
     * @param completedAt - UTC timestamp in milliseconds.
     * @mode emit
     */
    'verboo-account/login-completed'(sessionId: AccountSessionId, attemptId: SignInAttemptId, startedAt: number, completedAt: number): void
  }
}

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
