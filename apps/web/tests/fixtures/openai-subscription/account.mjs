/** Production account and encrypted vault with an isolated in-memory key store. */
import {
  Config, GrantVault, OpenAiAccount, OpenAiAccountLogin,
} from '../../../../../packages/credentials/openai-account/lib/index.js'

export { Config }
export const inject = ['credentials']

/** Mount the production account and login services with a fixture-only keyring. */
export function apply(ctx, config) {
  let key = null
  const store = {
    async getSecret() { return key },
    async setSecret(secret) { key = [...secret] },
  }
  const vault = new GrantVault(config.tokenUrl, 'openai-subscription-e2e', store)
  new OpenAiAccount(ctx, config, vault)
  ctx.plugin(OpenAiAccountLogin)
}
