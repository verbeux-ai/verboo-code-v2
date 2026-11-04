/** Test-only account provider; grants are fake and never leave the loopback fixture. */
export function apply(ctx, config) {
  let account = config.accountId
  const watchers = new Set()
  const getState = async () => ({
    status: 'credential-stored', credentialRevision: `stamina-fixture:${account}`,
    attempt: null, links: { usageUrl: `${config.apiOrigin}/dashboard`, topUpUrl: `${config.apiOrigin}/plans` },
  })
  const provider = {
    getState,
    async getProfile() {
      return { status: 'ready', value: { id: account, name: 'Stamina fixture', contact: null } }
    },
    async getBalance() { return null },
    async getUnnotifiedBonuses() { return null },
    async ackBonusNotified() { return false },
    async startSignIn() { return getState() },
    async cancelSignIn() { return getState() },
    async signOut() { throw new Error('This fixture does not sign out') },
    async resolveToken() { return `stamina-fixture:${account}` },
    async rejectToken() {},
    async getDeviceIdentity() { return { osVersion: 'fixture' } },
    async getPlatformSession() {
      return { origin: config.apiOrigin, token: `stamina-fixture:${account}`, userId: account, sessionId: `stamina-login:${account}` }
    },
    setFixtureAccount(id) {
      account = id
      for (const changed of watchers) changed()
    },
    async *watch(signal) {
      let dirty = true
      let wake
      const changed = () => { dirty = true; wake?.() }
      watchers.add(changed)
      signal.addEventListener('abort', changed)
      try {
        while (!signal.aborted) {
          if (!dirty) await new Promise(resolve => { wake = resolve })
          wake = undefined
          if (signal.aborted) return
          dirty = false
          yield await getState()
        }
      } finally {
        watchers.delete(changed)
        signal.removeEventListener('abort', changed)
      }
    },
  }
  const release = ctx.reflect.provide('deepseekAccount', provider)
  ctx.effect(() => () => release(), 'stamina fixture account')
}
