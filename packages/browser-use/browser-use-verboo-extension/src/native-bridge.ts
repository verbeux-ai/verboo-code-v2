/** Authenticated local IPC between the Verboo Host and Chrome Native Messaging. @module */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const PROTOCOL_VERSION = 1
const MAX_LINE_BYTES = 1024 * 1024
const MAX_PENDING_REQUESTS = 64
const NATIVE_HOST_NAME = 'ai.verbeux.verboo_code.browser_bridge'

type BrowserOperation =
  | 'task.start'
  | 'task.finish'
  | 'tabs.list'
  | 'tabs.open'
  | 'page.observe'
  | 'page.act'
  | 'history.search'
  | 'downloads.search'
  | 'attention.raise'

interface Peer {
  readonly socket: Socket
  buffer: Buffer
  authenticated: boolean
  ready: boolean
  instanceId?: string
}

interface PendingRequest {
  readonly peer: Peer
  readonly operation: BrowserOperation
  readonly taskId: string
  readonly resolve: (value: JsonValue) => void
  readonly reject: (reason: Error) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
  settled: boolean
}

interface AttentionWaiter {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

interface ReadyWaiter {
  readonly instanceId?: string
  readonly resolve: (peer: Peer) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly timer: ReturnType<typeof setTimeout>
  readonly onAbort?: () => void
}

interface BridgeConfig {
  readonly connectionTimeoutMs: number
  readonly recoveryRetries: number
}

interface BootstrapFile {
  version: number
  port: number
  token: string
}

/** Own the loopback server and route extension commands to the right Chrome profile. */
export class BrowserExtensionBridge {
  private readonly peers = new Set<Peer>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly readyWaiters = new Set<ReadyWaiter>()
  private readonly taskInstances = new Map<string, string>()
  private readonly attentionWaiters = new Map<string, AttentionWaiter>()
  private readonly attentionRuns = new Map<string, Promise<JsonValue>>()
  private server: Server | undefined
  private bootstrapPath: string | undefined
  private token: string | undefined
  private disposed = false

  /** Create an instance-owned local bridge.
   * @param ctx - Host context used for non-sensitive startup and lifecycle diagnostics.
   * @param config - Validated connection and recovery settings.
   */
  constructor(private readonly ctx: Context, private readonly config: BridgeConfig) {}

  /** Start the local server and atomically publish its private connection details.
   * @returns completion after the bootstrap file is ready for Chrome.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('browser extension bridge has already been disposed')
    if (this.server !== undefined) throw new Error('browser extension bridge is already running')
    const path = bootstrapFilePath()
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    const server = createServer(socket => this.accept(socket))
    this.server = server
    server.on('error', (error) => {
      this.ctx.logger.error(`${NATIVE_HOST_NAME}: loopback server failed: ${error.message}`)
      this.failAll(error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('browser extension bridge did not bind a TCP port')
      const port = address.port
      const token = randomBytes(32).toString('hex')
      await publishBootstrap(path, { version: PROTOCOL_VERSION, port, token })
      this.bootstrapPath = path
      this.token = token
    } catch (error) {
      this.server = undefined
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
  }

  /** Start a Chrome task and pin it to the extension instance that created its tab group.
   * @param taskId - Opaque task identifier shared with the extension.
   * @param args - Task title, objective, and optional initial URL.
   * @param signal - Cancellation signal for the tool call.
   * @returns the extension's task-start result.
   */
  async startTask(taskId: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const peer = await this.waitForReadyPeer(undefined, signal)
    const instanceId = requiredInstanceId(peer)
    this.taskInstances.set(taskId, instanceId)
    try {
      return await this.send(instanceId, 'task.start', taskId, args, signal)
    } catch (error) {
      if (!(error instanceof BrowserCommandError) || !error.outcomeUnknown) this.taskInstances.delete(taskId)
      throw error
    }
  }

  /** Finish a task while leaving its Chrome tab group open.
   * @param taskId - Opaque task identifier owned by this Host.
   * @param signal - Optional cancellation signal for the tool call.
   * @returns the extension's task-finish result.
   */
  async finishTask(taskId: string, signal?: AbortSignal): Promise<JsonValue> {
    const result = await this.command(taskId, 'task.finish', {}, signal)
    this.forgetTask(taskId, new Error('browser task finished'))
    return result
  }

  /** Bound conversation teardown while leaving the Chrome task group intact.
   * @param taskId - Opaque task identifier owned by the disposed conversation.
   * @returns completion after Chrome acknowledges finish or the configured wait expires.
   */
  async cleanupTask(taskId: string): Promise<void> {
    try {
      await this.finishTask(taskId, AbortSignal.timeout(this.config.connectionTimeoutMs))
    } finally {
      this.forgetTask(taskId)
    }
  }

  /** Release Host-side task routing after its owning conversation is disposed.
   * @param taskId - Opaque task identifier to forget.
   * @param reason - Error used to reject a pending challenge wait.
   * @returns nothing.
   */
  forgetTask(taskId: string, reason = new Error('browser task owner was disposed')): void {
    this.taskInstances.delete(taskId)
    this.clearAttention(taskId, reason)
  }

  /** Send a versioned browser operation to the Chrome profile that owns a task.
   * @param taskId - Opaque task identifier owned by this Host.
   * @param operation - Typed browser operation name.
   * @param args - JSON arguments for that operation.
   * @param signal - Optional cancellation signal for the tool call.
   * @returns the extension's JSON result.
   */
  command(
    taskId: string,
    operation: Exclude<BrowserOperation, 'task.start'>,
    args: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const instanceId = this.taskInstances.get(taskId)
    if (instanceId === undefined) throw new Error('browser task is not attached to this Verboo Host')
    return this.send(instanceId, operation, taskId, args, signal)
  }

  /** Raise a verified challenge tab and wait until Chrome reports that it cleared.
   * @param taskId - Opaque task identifier owned by this Host.
   * @param tabRef - Task-scoped reference to the challenge tab.
   * @param reason - Verified challenge category.
   * @param signal - Optional cancellation signal for the tool call.
   * @returns the extension's attention result.
   */
  async raiseAttention(
    taskId: string,
    tabRef: string,
    reason: 'login' | 'mfa' | 'captcha',
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const key = attentionKey(taskId, tabRef)
    let operation = this.attentionRuns.get(key)
    if (operation === undefined) {
      operation = this.performAttention(taskId, tabRef, reason, signal)
      this.attentionRuns.set(key, operation)
      void operation.finally(() => {
        if (this.attentionRuns.get(key) === operation) this.attentionRuns.delete(key)
      }).catch(() => undefined)
    }
    return waitWithSignal(operation, signal)
  }

  /** Stop accepting IPC, reject pending calls, close peers, and remove this Host's token file.
   * @returns completion after peers are closed and the bootstrap file is removed.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const server = this.server
    this.server = undefined
    let failure: Error | undefined
    if (server !== undefined) {
      for (const peer of this.peers) peer.socket.destroy()
      try {
        await new Promise<void>(resolve => server.close((error) => {
          if (error !== undefined) failure = error
          resolve()
        }))
      } catch (error) {
        failure = error instanceof Error ? error : new Error('local server close failed')
      }
    }
    this.failAll(new Error('Verboo Host is shutting down'))
    if (this.bootstrapPath !== undefined && this.token !== undefined) {
      try {
        await removeBootstrap(this.bootstrapPath, this.token)
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error('bridge bootstrap cleanup failed')
      }
    }
    if (failure !== undefined) throw failure
  }

  private accept(socket: Socket): void {
    const peer: Peer = { socket, buffer: Buffer.alloc(0), authenticated: false, ready: false }
    socket.setTimeout(10_000)
    socket.on('timeout', () => socket.destroy())
    socket.on('data', chunk => this.read(peer, chunk))
    socket.on('error', error => this.ctx.logger.warn(`${NATIVE_HOST_NAME}: local peer failed: ${error.message}`))
    socket.on('close', () => this.closePeer(peer))
  }

  private read(peer: Peer, chunk: Buffer): void {
    peer.buffer = Buffer.concat([peer.buffer, chunk])
    if (peer.buffer.length > MAX_LINE_BYTES && peer.buffer.indexOf(0x0a) < 0) {
      peer.socket.destroy()
      return
    }
    for (;;) {
      const newline = peer.buffer.indexOf(0x0a)
      if (newline < 0) return
      if (newline > MAX_LINE_BYTES) {
        peer.socket.destroy()
        return
      }
      const line = peer.buffer.subarray(0, newline).toString('utf8')
      peer.buffer = peer.buffer.subarray(newline + 1)
      if (peer.buffer.length > MAX_LINE_BYTES && peer.buffer.indexOf(0x0a) < 0) {
        peer.socket.destroy()
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        peer.socket.destroy()
        return
      }
      if (!peer.authenticated) {
        if (!this.authenticate(peer, message)) peer.socket.destroy()
        else peer.socket.setTimeout(0)
        continue
      }
      this.receive(peer, message)
    }
  }

  private authenticate(peer: Peer, value: unknown): boolean {
    if (!isRecord(value)
      || value.type !== 'hello'
      || value.version !== PROTOCOL_VERSION
      || typeof value.token !== 'string'
      || typeof value.origin !== 'string'
      || !/^chrome-extension:\/\/[a-p]{32}\/$/u.test(value.origin)
      || peer.socket.remoteAddress !== '127.0.0.1'
      || this.token === undefined) return false
    const expected = Buffer.from(this.token, 'hex')
    const received = Buffer.from(value.token, 'hex')
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false
    peer.authenticated = true
    this.peers.add(peer)
    return true
  }

  private receive(peer: Peer, value: unknown): void {
    if (!isRecord(value) || value.version !== PROTOCOL_VERSION || typeof value.type !== 'string') {
      peer.socket.destroy()
      return
    }
    if (value.type === 'event') {
      this.receiveEvent(peer, value)
      return
    }
    if (value.type !== 'response'
      || typeof value.requestId !== 'string'
      || value.requestId.length === 0
      || value.requestId.length > 128
      || typeof value.ok !== 'boolean') {
      peer.socket.destroy()
      return
    }
    const pending = this.pending.get(value.requestId)
    if (pending === undefined) {
      this.acknowledge(peer, value.requestId)
      return
    }
    if (pending.peer !== peer) return
    this.acknowledge(peer, value.requestId)
    this.pending.delete(value.requestId)
    removeAbortListener(pending)
    if (pending.settled) return
    pending.settled = true
    if (value.ok && isJsonValue(value.result)) {
      pending.resolve(value.result)
      return
    }
    const message = isRecord(value.error) && typeof value.error.message === 'string'
      ? value.error.message.slice(0, 2000)
      : 'Chrome returned an invalid browser response'
    const outcomeUnknown = !isRecord(value.error) || value.error.outcomeUnknown !== false
    const code = isRecord(value.error) && typeof value.error.code === 'string'
      ? value.error.code.slice(0, 128)
      : undefined
    pending.reject(new BrowserCommandError(
      outcomeUnknown
        ? `${pending.operation} failed; inspect the Chrome page before repeating the operation. ${message}`
        : `${pending.operation} failed. ${message}`,
      outcomeUnknown,
      false,
      undefined,
      code,
    ))
  }

  private acknowledge(peer: Peer, requestId: string): void {
    if (peer.socket.destroyed) return
    const message = `${JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack', requestId })}\n`
    try {
      peer.socket.write(message, (error) => {
        if (error !== null) this.closePeer(peer, error)
      })
    } catch (error) {
      this.closePeer(peer, error instanceof Error ? error : new Error('request acknowledgement failed'))
    }
  }

  private receiveEvent(peer: Peer, value: Record<string, unknown>): void {
    if (value.event === 'extension.ready') {
      if (typeof value.instanceId !== 'string' || value.instanceId.length < 16 || value.instanceId.length > 128) {
        peer.socket.destroy()
        return
      }
      if (peer.ready && peer.instanceId !== value.instanceId) {
        peer.socket.destroy()
        return
      }
      peer.instanceId = value.instanceId
      peer.ready = true
      this.resolveReadyWaiters(peer)
      return
    }
    if (value.event !== 'attention.resolved'
      && value.event !== 'attention.unavailable'
      && value.event !== 'attention.cancelled'
      && value.event !== 'attention.raised') return
    if (typeof value.taskId !== 'string' || typeof value.tabRef !== 'string' || peer.instanceId === undefined) return
    if (this.taskInstances.get(value.taskId) !== peer.instanceId) return
    if (value.event === 'attention.raised') return
    const key = attentionKey(value.taskId, value.tabRef)
    const waiter = this.attentionWaiters.get(key)
    if (waiter === undefined) return
    this.attentionWaiters.delete(key)
    if (value.event === 'attention.resolved') waiter.resolve()
    else waiter.reject(new BrowserCommandError(
      value.event === 'attention.cancelled'
        ? 'browser attention was canceled before the challenge cleared'
        : 'the challenge tab is no longer accessible to the extension; inspect its URL and the Chrome task group before continuing',
      false,
    ))
  }

  private async performAttention(
    taskId: string,
    tabRef: string,
    reason: 'login' | 'mfa' | 'captcha',
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const key = attentionKey(taskId, tabRef)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    const waiter = { promise, resolve, reject }
    this.attentionWaiters.set(key, waiter)
    void promise.catch(() => undefined)
    try {
      const result = await this.command(taskId, 'attention.raise', { tabRef, reason }, signal)
      if (isRecord(result) && result.status === 'resolved') {
        waiter.resolve()
        return result
      }
      await waitWithSignal(waiter.promise, signal)
      return { taskId, tabRef, reason, status: 'resolved' }
    } catch (error) {
      if (this.attentionWaiters.get(key) === waiter) {
        this.attentionWaiters.delete(key)
        waiter.reject(error instanceof Error ? error : new Error('browser attention failed'))
      }
      throw error
    } finally {
      if (this.attentionWaiters.get(key) === waiter) this.attentionWaiters.delete(key)
    }
  }

  private async send(
    instanceId: string,
    operation: BrowserOperation,
    taskId: string,
    args: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    signal?.throwIfAborted()
    const requestId = randomUUID()
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error('too many browser commands are already in flight')
    }
    const command = {
      version: PROTOCOL_VERSION,
      type: 'command',
      requestId,
      operation,
      taskId,
      args,
    }
    const line = `${JSON.stringify(command)}\n`
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('browser command exceeds the Native Messaging size limit')
    let dispatched = false
    for (let attempt = 0; attempt <= this.config.recoveryRetries; attempt += 1) {
      let peer: Peer
      try {
        peer = await this.waitForReadyPeer(instanceId, signal)
      } catch (error) {
        if (dispatched) {
          throw new BrowserCommandError(
            'Chrome disconnected after the browser command was sent and did not reconnect in time; inspect the page before repeating the operation',
            true,
          )
        }
        throw error
      }
      try {
        return await this.sendOnce(peer, operation, taskId, requestId, line, () => { dispatched = true }, signal)
      } catch (error) {
        if (!(error instanceof BrowserCommandError) || !error.retryable || attempt >= this.config.recoveryRetries) throw error
        this.ctx.logger.warn(`${NATIVE_HOST_NAME}: retrying ${operation} after a Chrome connection loss (${attempt + 1}/${this.config.recoveryRetries})`)
      }
    }
    throw new Error('browser command recovery ended without a result')
  }

  private sendOnce(
    peer: Peer,
    operation: BrowserOperation,
    taskId: string,
    requestId: string,
    line: string,
    onDispatch: () => void,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    signal?.throwIfAborted()
    if (!peer.ready || peer.socket.destroyed) {
      throw new BrowserCommandError('Chrome disconnected before the browser command was sent', true, true)
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error('too many browser commands are already in flight')
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const pending: PendingRequest = {
        peer,
        operation,
        taskId,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined ? {} : { onAbort: () => {
          const current = this.pending.get(requestId)
          if (current === undefined || current.settled) return
          this.pending.delete(requestId)
          current.settled = true
          removeAbortListener(current)
          reject(new BrowserCommandError('browser command was canceled after dispatch; its outcome may be unknown', true))
        } }),
        settled: false,
      }
      this.pending.set(requestId, pending)
      if (signal !== undefined && pending.onAbort !== undefined) {
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      onDispatch()
      try {
        peer.socket.write(line, (error) => {
          if (error !== null) this.closePeer(peer, error)
        })
      } catch (error) {
        this.closePeer(peer, error instanceof Error ? error : new Error('local socket write failed'))
      }
    })
  }

  private waitForReadyPeer(instanceId: string | undefined, signal?: AbortSignal): Promise<Peer> {
    signal?.throwIfAborted()
    const current = instanceId === undefined ? this.findReadyPeer() : this.findPeer(instanceId)
    if (current !== undefined) return Promise.resolve(current)
    if (this.disposed) return Promise.reject(new Error('Verboo Host is shutting down'))
    return new Promise<Peer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeReadyWaiter(waiter)
        reject(disconnectedError())
      }, this.config.connectionTimeoutMs)
      const onAbort = signal === undefined ? undefined : (): void => {
        this.removeReadyWaiter(waiter)
        reject(signal.reason instanceof Error ? signal.reason : new Error('browser connection wait canceled'))
      }
      const waiter: ReadyWaiter = {
        ...(instanceId === undefined ? {} : { instanceId }),
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        timer,
        ...(onAbort === undefined ? {} : { onAbort }),
      }
      this.readyWaiters.add(waiter)
      if (signal !== undefined && onAbort !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private resolveReadyWaiters(peer: Peer): void {
    for (const waiter of this.readyWaiters) {
      if (waiter.instanceId !== undefined && waiter.instanceId !== peer.instanceId) continue
      this.removeReadyWaiter(waiter)
      waiter.resolve(peer)
    }
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      this.removeReadyWaiter(waiter)
      waiter.reject(error)
    }
  }

  private removeReadyWaiter(waiter: ReadyWaiter): void {
    this.readyWaiters.delete(waiter)
    clearTimeout(waiter.timer)
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private findReadyPeer(): Peer | undefined {
    return [...this.peers].find(candidate => candidate.ready && !candidate.socket.destroyed)
  }

  private findPeer(instanceId: string): Peer | undefined {
    return [...this.peers].find(candidate => candidate.ready
      && candidate.instanceId === instanceId
      && !candidate.socket.destroyed)
  }

  private closePeer(peer: Peer, cause?: Error): void {
    this.peers.delete(peer)
    const retryingAttentionTasks = new Set([...this.pending.values()]
      .filter(pending => pending.peer === peer && pending.operation === 'attention.raise')
      .map(pending => pending.taskId))
    const failure = new BrowserCommandError(
      'Chrome disconnected after a browser command was sent; inspect the page before repeating it',
      true,
      true,
      cause === undefined ? undefined : { cause },
    )
    for (const [requestId, pending] of this.pending) {
      if (pending.peer !== peer) continue
      this.pending.delete(requestId)
      removeAbortListener(pending)
      if (!pending.settled) {
        pending.settled = true
        pending.reject(failure)
      }
    }
    if (peer.instanceId !== undefined) {
      for (const [key, waiter] of this.attentionWaiters) {
        const [taskId] = splitAttentionKey(key)
        if (this.taskInstances.get(taskId) !== peer.instanceId) continue
        if (retryingAttentionTasks.has(taskId)) continue
        this.attentionWaiters.delete(key)
        waiter.reject(new BrowserCommandError('Chrome disconnected while waiting for the challenge to clear', true))
      }
    }
  }

  private failAll(error: Error): void {
    for (const peer of this.peers) peer.socket.destroy()
    this.peers.clear()
    this.rejectReadyWaiters(error)
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      removeAbortListener(pending)
      if (!pending.settled) {
        pending.settled = true
        pending.reject(error)
      }
    }
    this.clearAttention(undefined, error)
  }

  private clearAttention(taskId: string | undefined, error: Error): void {
    for (const [key, waiter] of this.attentionWaiters) {
      if (taskId !== undefined && splitAttentionKey(key)[0] !== taskId) continue
      this.attentionWaiters.delete(key)
      waiter.reject(error)
    }
  }
}

/** Stable failure class distinguishes a rejected browser operation from an unknown outcome. */
export class BrowserCommandError extends Error {
  /** @param message - Actionable failure text without page contents.
   * @param outcomeUnknown - Whether Chrome may already have performed the action.
   * @param retryable - Whether reconnecting and resending the same request ID is safe.
   * @param options - Optional error cause.
   */
  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
    readonly retryable = false,
    options?: ErrorOptions,
    readonly code?: string,
  ) {
    super(message, options)
    this.name = 'BrowserCommandError'
  }
}

/** Resolve the shared per-user bootstrap location used by the desktop and native host.
 * @returns the absolute bootstrap file path.
 */
export function bootstrapFilePath(): string {
  const configRoot = process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), '.config')
  return join(configRoot, 'Verboo Code', 'browser-extension', 'bridge.json')
}

async function publishBootstrap(path: string, data: BootstrapFile): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, path)
}

async function removeBootstrap(path: string, token: string): Promise<void> {
  try {
    const contents = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(contents)
    if (isRecord(parsed) && parsed.token === token) await rm(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAtDepth(value, 0)
}

/** Reject wire values nested deeply enough to exhaust the Host's call stack. */
function isJsonValueAtDepth(value: unknown, depth: number): value is JsonValue {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isJsonValueAtDepth(item, depth + 1))
  if (!isRecord(value)) return false
  return Object.values(value).every(item => isJsonValueAtDepth(item, depth + 1))
}

function requiredInstanceId(peer: Peer): string {
  if (peer.instanceId === undefined) throw disconnectedError()
  return peer.instanceId
}

function disconnectedError(): BrowserCommandError {
  return new BrowserCommandError(
    'Chrome is not connected. Open the Verboo Code Browser extension, accept its disclosure on first use, and check that its Native Messaging host is installed.',
    false,
  )
}

function attentionKey(taskId: string, tabRef: string): string {
  return `${taskId}\u0000${tabRef}`
}

function splitAttentionKey(key: string): [string, string] {
  const separator = key.indexOf('\u0000')
  return [key.slice(0, separator), key.slice(separator + 1)]
}

function removeAbortListener(pending: PendingRequest): void {
  if (pending.signal !== undefined && pending.onAbort !== undefined) {
    pending.signal.removeEventListener('abort', pending.onAbort)
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('browser operation canceled'))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
