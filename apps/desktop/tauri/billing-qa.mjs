/** Deterministic inference and billing fixture shared by Browser and native conversation checks. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/**
 * Keep one synthetic subscription, signed preview and operation in the loopback test server.
 * @param {{ subscriptionId: string, targetPlanId: string, native?: boolean }} ids - stable synthetic identities and test carrier.
 */
export function billingConversationFixture({ subscriptionId, targetPlanId, native = false }) {
  let preview
  let operation
  let cancellation
  const periodEnd = new Date(Date.now() + 30 * 86400_000).toISOString()
  const writes = []
  const reads = []

  function project(row) {
    if (row.id !== subscriptionId) return row
    return {
      ...row, currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: cancellation !== undefined,
      management: { ...row.management, cancelSubscription: cancellation === undefined },
      ...(operation?.status === 'scheduled' && !cancellation ? { activePlanChangeId: operation.operationId } : {}),
      ...(cancellation ? { cancellation } : {}),
    }
  }

  function route(req, res, url, body) {
    const base = '/api/me/subscriptions/' + subscriptionId
    const path = url.pathname
    const method = req.method
    if (!path.startsWith(base + '/') && !path.startsWith('/api/me/plan-changes/')) return false
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
      return true
    }
    const identity = {
      journey: req.headers['x-verboo-journey-id'],
      operation: req.headers['x-verboo-operation-id'],
      request: req.headers['x-request-id'],
    }
    if (path === base + '/change-plan/preview' && method === 'POST') {
      const target = JSON.parse(body)
      assert.equal(target.targetGroupId, targetPlanId)
      assert.equal(target.targetBillingInterval, 'month')
      assert.equal(target.removeConcurrencyTier, false)
      preview = { operationId: randomUUID(), token: 'qa-signed-preview-never-model', journey: identity.journey }
      return reply({
        policyVersion: 2, operationId: preview.operationId, previewToken: preview.token,
        billingInterval: 'month', currency: 'BRL', amountDueNowCents: 19000, creditNowCents: 0,
        nextRenewalAmountCents: 29900, nextRenewalAt: periodEnd, effectiveAt: periodEnd,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        undoesCancellation: false, removesConcurrencyTier: false, pixAuthorizationRequired: false,
      })
    }
    if (path === base + '/change-plan' && method === 'POST') {
      const target = JSON.parse(body)
      assert.equal(target.previewToken, preview?.token)
      assert.equal(target.targetGroupId, targetPlanId)
      assert.equal(identity.operation, preview.operationId)
      assert.equal(identity.journey, preview.journey)
      assert.ok(identity.request)
      assert.equal(writes.filter(write => write.kind === 'change').length, 0)
      writes.push({ kind: 'change', ...identity })
      operation = { operationId: preview.operationId, effectiveAt: periodEnd, status: 'scheduled' }
      // The server committed the operation; the application has to recover by GET.
      res.destroy()
      return true
    }
    if (path.startsWith('/api/me/plan-changes/') && method === 'GET') {
      if (!operation || path.split('/').at(-1) !== operation.operationId) return reply(null, 404)
      const original = writes.find(write => write.kind === 'change')
      assert.equal(identity.operation, original.operation)
      assert.equal(identity.request, original.request)
      assert.equal(identity.journey, original.journey)
      reads.push('plan_change')
      return reply(operation)
    }
    if (path === base + '/cancel' && method === 'POST') {
      assert.equal(cancellation, undefined)
      assert.ok(identity.operation && identity.journey && identity.request)
      writes.push({ kind: 'cancel', ...identity })
      cancellation = {
        operationId: randomUUID(), collectionStatus: 'stopped', localStatus: 'complete', accessUntil: periodEnd,
      }
      if (operation) operation = { ...operation, status: 'canceled' }
      return reply(cancellation)
    }
    if (path === base + '/cancellation' && method === 'GET') {
      if (!cancellation) return reply(null, 404)
      reads.push('cancellation')
      return reply(cancellation)
    }
    return false
  }

  function model(input, chunk, finish, res) {
    const start = input.messages.findLastIndex(message => message.role === 'user' &&
      (!native || /\bQA_NATIVE\b/.test(JSON.stringify(message.content))))
    const author = input.messages[start]?.content
    const text = typeof author === 'string' ? author : JSON.stringify(author ?? '')
    const command = text.match(/\bQA_PLAN_[A-Z]+\b/)?.[0]
    if (!command) return false
    const results = input.messages.slice(start + 1).filter(message => message.role === 'tool')
    const toolContent = results.map(message => typeof message.content === 'string' ? message.content : message.content[0].text)
    assert.ok(!JSON.stringify(input).match(/qa-signed-preview-never-model|checkout\.stripe\.com|stamina-fixture:|qa-access-only-/))
    for (const name of ['verboo_plan_status', 'verboo_plan_change_preview', 'verboo_plan_change_request',
      'verboo_plan_cancel', 'verboo_plan_operation']) {
      assert.ok(input.tools.some(tool => tool.function?.name === name), 'Missing declaration ' + name)
    }
    function call(name, args) {
      chunk({ tool_calls: [{ index: 0, id: 'call_' + command + (native ? '_native_' : '_') + results.length,
        type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
      res.end('data: [DONE]\n\n')
      return true
    }
    const read = index => JSON.parse(toolContent[index])
    const done = () => {
      finish(command + (native ? '_NATIVE_OK' : '_OK'))
      return true
    }
    if (command === 'QA_PLAN_STATUS') {
      if (!results.length) return call('verboo_plan_status', {})
      assert.ok(read(0).subscriptions.some(row => row.subscriptionId === subscriptionId && row.status === 'active'))
      return done()
    }
    if (command === 'QA_PLAN_FOREIGN') {
      if (!results.length) return call('verboo_plan_cancel', { subscriptionId: '00000000-0000-4000-8000-000000000099', approved: true })
      assert.equal(read(0).code, 'not_allowed')
      return done()
    }
    if (command === 'QA_PLAN_CANCEL') {
      if (!results.length) return call('verboo_plan_cancel', { subscriptionId, approved: true })
      assert.equal(read(0).operation?.status, 'confirmed')
      if (results.length === 1) return call('verboo_plan_operation', {
        subscriptionId, kind: 'cancellation', operationId: read(0).operation.operationId,
      })
      assert.deepEqual(read(0).operation, read(1).operation)
      return done()
    }
    if (!results.length) return call('verboo_plan_change_preview', { subscriptionId, targetPlanId, billingInterval: 'month' })
    const quote = read(0)
    assert.equal(quote.amountDueNowMinor, 19000)
    assert.equal(quote.currency, 'BRL')
    if (command === 'QA_PLAN_PREVIEW') return done()
    if (results.length === 1) return call('verboo_plan_change_request', { quoteId: quote.quoteId, approved: true })
    if (command === 'QA_PLAN_DENY') {
      assert.equal(read(1).code, 'not_approved')
      return done()
    }
    assert.equal(read(1).operation?.status, 'unconfirmed')
    if (results.length === 2) return call('verboo_plan_operation', {
      subscriptionId, kind: 'plan_change', operationId: read(1).operation.operationId,
    })
    assert.equal(read(2).operation?.operationId, read(1).operation.operationId)
    assert.equal(read(2).operation?.status, 'scheduled')
    if (results.length === 3) return call('verboo_plan_change_request', { quoteId: quote.quoteId })
    assert.equal(read(3).code, 'quote_changed')
    return done()
  }

  return { route, project, model, writes, reads }
}
