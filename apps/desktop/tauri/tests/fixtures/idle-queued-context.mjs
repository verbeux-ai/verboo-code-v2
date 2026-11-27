/** Create a real conversation whose next step has saved context but no running turn. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const inject = ['agentLoop', 'agents', 'workingDirectory']

export async function apply(ctx) {
  const { agent } = await ctx.agents.create({
    sessionId: crypto.randomUUID(),
    meta: { cwd: process.cwd() },
  })
  const home = process.env.DSH_HOME
  await ctx.workingDirectory.set(agent, home)
  assert.equal(agent.status, 'idle')
  assert.equal(agent.inbox.nextStep.length, 1)
  agent.ctx.effect(() => () =>
    writeFile(join(home, 'idle-context-after-stop'), String(agent.inbox.nextStep.length)))
  await writeFile(join(home, 'idle-context-ready'), 'ready')
}
