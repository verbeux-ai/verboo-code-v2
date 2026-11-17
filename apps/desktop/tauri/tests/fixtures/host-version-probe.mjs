// Used by the native HostProcess test to observe only the public app version.
const emit = payload => process.stdout.write(`VERBOO_HOST_V1\t${JSON.stringify(payload)}\n`)
emit({ type: 'ready', url: process.env.DSH_CLIENT_VERSION })
process.stdin.once('data', () => {
  emit({ type: 'stopped' })
  process.exit(0)
})
