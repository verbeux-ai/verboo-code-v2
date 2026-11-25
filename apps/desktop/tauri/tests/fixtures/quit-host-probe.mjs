/** Deterministic private-protocol peer for native transport tests. */
import { createInterface } from 'node:readline'
const mode = process.argv[2]
const send = event => process.stdout.write(`VERBOO_HOST_V1\t${JSON.stringify(event)}\n`)
const input = createInterface({ input: process.stdin })
let reservedRequest
send({ type: 'ready', url: `http://127.0.0.1:12345/?token=${'x'.repeat(32)}` })
input.on('line', line => {
  const request = JSON.parse(line)
  const reply = (kind, lease) => send({ type: 'quit-response', requestId: request.requestId, kind, ...(lease === undefined ? {} : { lease }) })
  switch (request.type) {
    case 'quit-reserve':
      reservedRequest = request.requestId
      if (mode === 'busy') reply('busy')
      else if (mode !== 'lost-reserve') reply('reserved', 1)
      break
    case 'quit-commit': reply(mode === 'rejected' ? 'rejected' : 'committed'); break
    case 'quit-cancel':
      if (mode === 'lost-reserve') send({ type: 'quit-response', requestId: reservedRequest, kind: 'reserved', lease: 1 })
      reply('cancelled')
      break
    case 'quit-finalize':
      if (mode !== 'lost-finalize') { reply('finalized'); send({ type: 'stopped' }); input.close(); process.stdin.destroy() }
      break
    case 'shutdown': send({ type: 'stopped' }); input.close(); process.stdin.destroy(); break
  }
})
