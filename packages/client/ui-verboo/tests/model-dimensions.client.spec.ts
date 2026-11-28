import { expect, it } from 'vitest'
import { modelDimensions } from '../src/client/model-dimensions.ts'

it('records first-party model and effort without custom provider labels', () => {
  expect(modelDimensions({ provider: 'deepseek-account', name: 'max/qwen3.6-27b', effort: 'high' }))
    .toEqual({ provider: 'verboo', model: 'max/qwen3.6-27b', effort: 'high' })
  expect(modelDimensions({ provider: 'openai-account', name: 'gpt-6.2' }))
    .toEqual({ provider: 'openai', model: 'gpt-6.2', effort: 'default' })
  expect(modelDimensions({ provider: 'deepseek-official', name: 'deepseek-v4-pro', effort: 'max' }))
    .toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'max' })
  expect(modelDimensions({ provider: 'openai-account', name: 'gpt-6.2', effort: 'custom' })?.effort).toBe('other')
  expect(modelDimensions({ provider: 'private-provider', name: 'private-model' })).toEqual({ provider: 'other', model: 'other', effort: 'default' })
  expect(modelDimensions({ provider: 'openai-account', name: 'my secret prompt' })).toEqual({ provider: 'openai', model: 'other', effort: 'default' })
})
