// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSettings } from '../src/chat-settings.ts'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('TranscriptViewPolicy', () => {
  it('defaults to completion and persists explicit timing without reading or writing browser storage', () => {
    const storageReads = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('"next-input"')
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem')
    const storageRemovals = vi.spyOn(Storage.prototype, 'removeItem')
    const storageClears = vi.spyOn(Storage.prototype, 'clear')
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    const modeChanged = vi.fn()
    const timingChanged = vi.fn()
    const unsubscribeMode = policy.mode.subscribe(modeChanged)
    const unsubscribeTiming = policy.collapseTiming.subscribe(timingChanged)
    try {
      expect(policy.collapseTiming.getSnapshot()).toBe('completion')
      policy.setCollapseTiming('completion')
      expect(timingChanged).not.toHaveBeenCalled()
      policy.setCollapseTiming('next-input')
      expect(policy.collapseTiming.getSnapshot()).toBe('next-input')
      expect(timingChanged).toHaveBeenCalledTimes(1)
      policy.setCollapseTiming('next-input')
      expect(timingChanged).toHaveBeenCalledTimes(1)
      policy.setCollapseTiming('completion')
      expect(policy.collapseTiming.getSnapshot()).toBe('completion')
      expect(timingChanged).toHaveBeenCalledTimes(2)
      expect(policy.mode.getSnapshot()).toBe('compact')
      expect(modeChanged).not.toHaveBeenCalled()
      expect(host.set).toHaveBeenCalledTimes(2)
      expect(host.set).toHaveBeenNthCalledWith(1, 'collapseTiming', 'next-input')
      expect(host.set).toHaveBeenNthCalledWith(2, 'collapseTiming', 'completion')
      expect(storageReads).not.toHaveBeenCalled()
      expect(storageWrites).not.toHaveBeenCalled()
      expect(storageRemovals).not.toHaveBeenCalled()
      expect(storageClears).not.toHaveBeenCalled()
    } finally {
      unsubscribeMode()
      unsubscribeTiming()
      policy.dispose()
    }
  })

  it('keeps every reply by default, persists an explicit folded-reply choice, and adopts saved values', () => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    const changed = vi.fn()
    const unsubscribe = policy.foldedReplies.subscribe(changed)
    try {
      expect(policy.foldedReplies.getSnapshot()).toBe('all')
      policy.setFoldedReplies('all')
      expect(changed).not.toHaveBeenCalled()
      policy.setFoldedReplies('final')
      expect(policy.foldedReplies.getSnapshot()).toBe('final')
      expect(host.set).toHaveBeenCalledExactlyOnceWith('foldedReplies', 'final')
      host.publish({ value: { linkOpening: 'sidebar', performanceUsage: 'detailed', foldedReplies: 'all' }, revision: 2 })
      expect(policy.foldedReplies.getSnapshot()).toBe('all')
      host.publish({ value: { linkOpening: 'sidebar', performanceUsage: 'detailed' }, revision: 3 })
      expect(policy.foldedReplies.getSnapshot()).toBe('all')
      expect(changed).toHaveBeenCalledTimes(2)
      expect(host.set).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      policy.dispose()
    }
  })

  it('restores both saved preferences in each new instance', () => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'standard', performanceUsage: 'detailed' }, revision: 1, writable: true })
    const first = new TranscriptViewPolicy(host.scope)
    try {
      first.setCollapseTiming('next-input')
      host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'standard', performanceUsage: 'detailed', collapseTiming: 'next-input' }, revision: 2 })
      const second = new TranscriptViewPolicy(host.scope)
      try {
        expect(first.collapseTiming.getSnapshot()).toBe('next-input')
        expect(second.collapseTiming.getSnapshot()).toBe('next-input')
        expect(second.mode.getSnapshot()).toBe('standard')
        expect(host.set).toHaveBeenCalledExactlyOnceWith('collapseTiming', 'next-input')
      } finally {
        second.dispose()
      }
    } finally {
      first.dispose()
    }
    expect(host.listenerCount()).toBe(0)
  })

  it('adopts Host mode and timing updates without writing them back', () => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    try {
      policy.setCollapseTiming('next-input')
      host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed', collapseTiming: 'next-input' }, revision: 1, writable: true })
      expect(policy.mode.getSnapshot()).toBe('compact')
      expect(policy.collapseTiming.getSnapshot()).toBe('next-input')
      // A document that already carries another mode keeps it.
      host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'verbose', performanceUsage: 'detailed' }, revision: 2 })
      expect(policy.mode.getSnapshot()).toBe('verbose')
      expect(policy.collapseTiming.getSnapshot()).toBe('completion')
      expect(host.set).toHaveBeenCalledExactlyOnceWith('collapseTiming', 'next-input')
    } finally {
      policy.dispose()
    }
  })

  it('publishes the fixed presentation mode before persistence settles and never writes it', () => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe('compact')
    policy.dispose()
    expect(host.set).not.toHaveBeenCalled()
  })

  it.each([
    ['compact', 'compact'], ['standard', 'standard'], ['detailed', 'detailed'], ['verbose', 'verbose'],
    ['normal', 'detailed'], ['expanded', 'detailed'],
  ] as const)(
    'reads a saved %s setting as %s without rewriting it',
    (mode, expected) => {
      const host = stubConfigForm<ChatSettings>()
      host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: mode, performanceUsage: 'detailed' }, revision: 1, writable: true })
      const policy = new TranscriptViewPolicy(host.scope)
      expect(policy.mode.getSnapshot()).toBe(expected)
      expect(host.set).not.toHaveBeenCalled()
      policy.dispose()
    },
  )
})

it('releases its subscription when the consuming plugin unloads', () => {
  const host = stubConfigForm<ChatSettings>()
  const policy = new TranscriptViewPolicy(host.scope)
  expect(host.listenerCount()).toBe(1)
  policy.dispose()
  expect(host.listenerCount()).toBe(0)
})
