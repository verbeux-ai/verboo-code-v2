// @vitest-environment jsdom
/** Local diagnostic for the production TrajectoryTable turn-collapse path. */

import { performance } from 'node:perf_hooks'
import { render } from '@testing-library/react'
import { describe, it } from 'vitest'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'
import type { TrajectoryCellProps } from '../src/client/trajectory-record.ts'
import { t } from './locale.client.ts'

const SAMPLES = 5
const loadImage = async (): Promise<string> => 'blob:trajectory-benchmark'
const renderSlot = () => null
const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc

function turnsWithToolRecords(count: number): readonly TrajectoryTurnModel[] {
  const cells: TrajectoryCellProps[] = Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    kind: 'tool',
    text: `tool-${String(offset + 1)}`,
    inputDetail: '{}',
    timeSeconds: null,
  }))
  return [{ turn: 1, groups: [{ title: 'Step 1', cells }] }]
}

function renderCollapsedTurn(count: number): number {
  const start = performance.now()
  const view = render(
    <TrajectoryTable
      t={t}
      renderSlot={renderSlot}
      loadImage={loadImage}
      turns={turnsWithToolRecords(count)}
      collapsedTurns={new Set([1])}
      onToggleTurn={() => {}}
      collapsedAssistants={new Set()}
      onToggleAssistant={() => {}}
      collapsedTools={new Set()}
      onToggleTool={() => {}}
    />,
  )
  const elapsed = performance.now() - start
  view.unmount()
  return elapsed
}

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
}

describe('TrajectoryTable turn-collapse performance diagnostic', () => {
  it.each([480, 1200, 2400])('renders a collapsed turn with %i source records', (count) => {
    forceGc?.()
    const heapBeforeMb = process.memoryUsage().heapUsed / 1024 / 1024
    renderCollapsedTurn(Math.min(count, 120)) // warm component and test environment
    forceGc?.()
    const timings = Array.from({ length: SAMPLES }, () => renderCollapsedTurn(count))
    forceGc?.()
    const heapAfterMb = process.memoryUsage().heapUsed / 1024 / 1024
    const peakRssMb = process.resourceUsage().maxRSS / 1024
    console.log(JSON.stringify({
      diagnostic: 'trajectory-table-collapse',
      sourceRecords: count,
      samples: SAMPLES,
      medianRenderMs: median(timings),
      samplesMs: timings.map(value => Number(value.toFixed(3))),
      postGcHeapGrowthMb: Number((heapAfterMb - heapBeforeMb).toFixed(2)),
      peakRssMb: Number(peakRssMb.toFixed(1)),
      explicitGc: forceGc !== undefined,
    }))
  })
})
