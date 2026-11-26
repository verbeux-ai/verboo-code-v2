import { z } from 'zod'
import type { SpeedFrame, SpeedMeasurement } from './types.ts'

/** Only measured or estimated generation rates may be presented as speed. */
const quality = z.enum(['measured', 'estimated', 'unavailable'])
const rate = z.number().finite().nonnegative().nullable().optional()
const point = z.object({
  at: z.iso.datetime({ offset: true }), generationTokensPerSecond: rate,
  generationRateQuality: quality.optional(), generationRatePartial: z.boolean().optional(),
  generationRateAtCompletion: z.boolean().optional(),
})
const frame = z.object({
  type: z.enum(['snapshot', 'update']), generatedAt: z.iso.datetime({ offset: true }),
  generationRateContract: z.literal(2).optional(), stale: z.boolean().optional(),
  generationTokensPerSecond: rate, generationRateQuality: quality.optional(),
  generationRatePartial: z.boolean().optional(), points: z.array(point).max(61),
})

/**
 * Drop legacy completion counts and invalid or unavailable speed readings.
 * @param input - untrusted frame from the live usage service.
 * @returns the safe speed projection, or null when the frame is invalid.
 */
export function parseSpeedFrame(input: unknown): SpeedFrame | null {
  const parsed = frame.safeParse(input)
  if (!parsed.success) return null
  const data = parsed.data
  if (data.stale) return { at: data.generatedAt, stale: true, measurement: null }
  const candidate = (
    value: number | null | undefined, kind: z.infer<typeof quality> | undefined,
    partial: boolean | undefined, at: string, previous: boolean,
  ): SpeedMeasurement | null =>
    typeof value === 'number' && value > 0 && (kind === 'measured' || kind === 'estimated')
      ? { value, quality: kind, partial: partial ?? false, at, previous } : null
  const current = candidate(data.generationTokensPerSecond, data.generationRateQuality, data.generationRatePartial, data.generatedAt, false)
  if (current) return { at: data.generatedAt, stale: false, measurement: current }
  const previous = data.points
    .filter(row => !row.generationRateAtCompletion || data.generationRateContract === 2)
    .map(row => candidate(row.generationTokensPerSecond, row.generationRateQuality, row.generationRatePartial, row.at, true))
    .filter((row): row is SpeedMeasurement => row !== null && Date.parse(row.at) <= Date.parse(data.generatedAt))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
  return { at: data.generatedAt, stale: false, measurement: previous }
}
