import { describe, expect, it } from 'vitest'
import { CATEGORY_ORDER, categoryOf } from '../src/client/categories.ts'

describe('catalog categories', () => {
  it('orders every declared category, with the catch-all last', () => {
    expect(CATEGORY_ORDER.at(-1)).toBe('others')
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length)
  })

  it.each([
    ['github', 'development'],
    ['gitlab', 'development'],
    ['slack', 'communication'],
    ['notion', 'productivity'],
    ['googledrive', 'files'],
    ['figma', 'design'],
    ['airtable', 'data'],
    ['hubspot', 'crm'],
    ['zendesk', 'support'],
    ['stripe', 'finance'],
  ] as const)('maps the known slug %s to %s', (slug, category) => {
    expect(categoryOf(slug)).toBe(category)
  })

  it('ignores separators and case, so server spellings agree', () => {
    expect(categoryOf('Google_Drive')).toBe(categoryOf('googledrive'))
    expect(categoryOf('google-drive')).toBe(categoryOf('GOOGLEDRIVE'))
    expect(categoryOf('google drive')).toBe('files')
  })

  it('reads an unknown slug through the keyword hints', () => {
    expect(categoryOf('acme-helpdesk')).toBe('support')
    expect(categoryOf('my-analytics-cloud')).toBe('data')
    expect(categoryOf('team-chat')).toBe('communication')
    expect(categoryOf('invoice-hub')).toBe('finance')
    expect(categoryOf('acme-devops')).toBe('development')
  })

  it('prefers a multi-word hint over its substring', () => {
    // `helpdesk` must win over `desk`, which is why the hints run longest-first.
    expect(categoryOf('helpdesk')).toBe('support')
  })

  it('falls back to the catch-all when nothing matches', () => {
    expect(categoryOf('zzzz')).toBe('others')
    expect(categoryOf('')).toBe('others')
  })
})
