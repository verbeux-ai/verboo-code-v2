import { describe, expect, it } from 'vitest'
import { parseSpeedFrame } from '../src/live-speed.ts'

const at = '2026-11-26T12:00:00.000Z'
const base = { type: 'snapshot', generatedAt: at, points: [], generationRateContract: 2 }

describe('live speed frames', () => {
  it('keeps the server measurement, quality and partial flag', () => {
    expect(parseSpeedFrame({ ...base, generationTokensPerSecond: 123.4, generationRateQuality: 'estimated', generationRatePartial: true }))
      .toEqual({ at, stale: false, measurement: { value: 123.4, quality: 'estimated', partial: true, at, previous: false } })
  })
  it('does not invent zero speed or expose stale readings', () => {
    expect(parseSpeedFrame({ ...base, generationTokensPerSecond: 0, generationRateQuality: 'measured' })?.measurement).toBeNull()
    expect(parseSpeedFrame({ ...base, stale: true, generationTokensPerSecond: 100, generationRateQuality: 'measured' })?.measurement).toBeNull()
  })
  it('does not treat legacy completion token counts as speed', () => {
    const row = { at, generationTokensPerSecond: 8279, generationRateQuality: 'measured', generationRateAtCompletion: true }
    expect(parseSpeedFrame({ ...base, generationRateContract: undefined, points: [row] })?.measurement).toBeNull()
    expect(parseSpeedFrame({ ...base, points: [row] })?.measurement?.value).toBe(8279)
  })
  it('rejects malformed and unsupported frames', () => {
    expect(parseSpeedFrame({ ...base, generationRateContract: 3 })).toBeNull()
    expect(parseSpeedFrame({ ...base, generationTokensPerSecond: -1 })).toBeNull()
    expect(parseSpeedFrame({ ...base, points: Array(62).fill({ at }) })).toBeNull()
  })
})
