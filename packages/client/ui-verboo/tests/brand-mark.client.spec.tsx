// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AssistantMark, BrandMark } from '../src/client/Brand.tsx'

afterEach(cleanup)

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
