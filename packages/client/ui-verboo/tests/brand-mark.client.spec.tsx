// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AssistantMark, Brand, BrandMark } from '../src/client/Brand.tsx'
import { Hero, RunningIndicator } from '../src/client/Hero.tsx'
import type { HeroProps } from '../src/client/contracts.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const copy: Readonly<Record<string, string>> = en
const t: HeroProps['t'] = key => copy[key] ?? key

it('keeps the default sidebar wordmark compact and names it for assistive technology', () => {
  const view = render(<Brand t={t} />)
  const wordmark = view.getByRole('img', { name: 'Verboo Code' })
  expect(wordmark.hasAttribute('data-large')).toBe(false)
  const icon = wordmark.querySelector('img')!
  expect(icon.width).toBe(26)
  expect(icon.height).toBe(26)
  expect(icon.alt).toBe('')
})

it('renders one opening question and a silent running indicator', () => {
  const props: Pick<HeroProps, 't'> = { t }
  const { getByRole, container } = render(<>
    <Hero {...props as HeroProps} />
    <RunningIndicator />
  </>)
  expect(getByRole('heading', { level: 1 }).textContent).toBe(en.homeTitle)
  const indicator = container.querySelector('[data-verboo-running]')
  expect(indicator?.getAttribute('aria-hidden')).toBe('true')
  expect(indicator?.textContent).toBe('')
})

describe('assistant mark', () => {
  it('draws the mascot on the reply that closes the Turn', () => {
    const view = render(<AssistantMark closing />)
    expect(view.container.querySelector('img')).not.toBeNull()
  })

  it('draws nothing on a reply that only continues the Turn', () => {
    const view = render(<AssistantMark closing={false} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.innerHTML).toBe('')
  })

  it('keeps the bare mark available to surfaces outside the transcript', () => {
    const view = render(<BrandMark />)
    expect(view.container.querySelector('img')).not.toBeNull()
  })
})
