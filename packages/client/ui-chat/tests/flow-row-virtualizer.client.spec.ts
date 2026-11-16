// @vitest-environment jsdom

import { expect, it, onTestFinished, vi } from 'vitest'
import { FlowRowVirtualizer } from '../src/client/chat/flow-row-virtualizer.ts'

it('suspends only safe offscreen rows and preserves their measured shell height', () => {
  const observers: Array<{
    callback: IntersectionObserverCallback
    targets: Set<Element>
    observer: IntersectionObserver
  }> = []
  const entry = (target: Element, isIntersecting: boolean): IntersectionObserverEntry => {
    const boundingClientRect = target.getBoundingClientRect()
    return {
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect,
      intersectionRect: isIntersecting ? boundingClientRect : new DOMRect(),
      rootBounds: null,
      time: performance.now(),
    }
  }
  class Observer implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = '0px'
    readonly scrollMargin = '0px'
    readonly thresholds = [0]
    private readonly record: (typeof observers)[number]
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, targets: new Set(), observer: this }
      observers.push(this.record)
    }
    observe(target: Element): void { this.record.targets.add(target) }
    unobserve(target: Element): void { this.record.targets.delete(target) }
    disconnect(): void { this.record.targets.clear() }
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  vi.stubGlobal('IntersectionObserver', Observer)
  const column = document.createElement('div')
  column.dataset.chatFlow = ''
  const scroll = document.createElement('div')
  scroll.append(column)
  document.body.append(scroll)
  const row = document.createElement('div')
  row.dataset.chatFlowKey = 'assistant-1'
  row.textContent = 'Historical answer searchable text'
  column.append(row)
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 84))
  const virtualizer = new FlowRowVirtualizer()
  onTestFinished(() => {
    virtualizer.dispose()
    scroll.remove()
    vi.unstubAllGlobals()
  })
  const notify = (isIntersecting: boolean): void => {
    const observer = observers[0]
    if (observer === undefined) throw new Error('intersection observer was not created')
    observer.callback([entry(row, isIntersecting)], observer.observer)
  }

  virtualizer.register('assistant-1', row, true)
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(false)
  notify(false)
  expect(virtualizer.getSnapshot('assistant-1')).toEqual({ suspended: true, height: 84 })

  row.innerHTML = '<button aria-expanded="true">Expanded content</button>'
  notify(false)
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(false)

  row.innerHTML = 'Historical answer searchable text'
  notify(false)
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(true)
  notify(true)
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(false)

  row.innerHTML = '<span>Selected historical text</span>'
  notify(false)
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(true)
  const text = row.querySelector('span')?.firstChild
  if (text === null || text === undefined) throw new Error('virtualized text proxy missing')
  const selection = document.getSelection()
  if (selection === null) throw new Error('document selection unavailable')
  const range = document.createRange()
  range.selectNodeContents(text)
  selection.addRange(range)
  notify(true)
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(true)
  selection.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  expect(virtualizer.getSnapshot('assistant-1').suspended).toBe(false)
})

it('keeps third-party rows active unless their renderer opts into the hint', () => {
  const virtualizer = new FlowRowVirtualizer()
  const row = document.createElement('div')
  row.dataset.chatFlowKey = 'custom-1'
  document.body.append(row)
  onTestFinished(() => { virtualizer.dispose(); row.remove() })

  virtualizer.register('custom-1', row, false)
  expect(virtualizer.getSnapshot('custom-1').suspended).toBe(false)
})
