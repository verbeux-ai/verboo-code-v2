import { expect, it } from 'vitest'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { scheduleObservation, scheduleOutcome } from '../src/schedule-observation.ts'

it('classifies Schedule tool actions without retaining arguments', () => {
  expect(scheduleObservation('schedule_create', '{"prompt":"SECRET"}')).toBe('schedule_create')
  expect(scheduleObservation('schedule_edit', '{"action":"update","active":false,"prompt":"SECRET"}')).toBe('schedule_pause')
  expect(scheduleObservation('schedule_edit', '{"action":"update","active":true}')).toBe('schedule_resume')
  expect(scheduleObservation('schedule_edit', '{"action":"delete"}')).toBe('schedule_delete')
  expect(scheduleObservation('schedule_edit', '{"action":"update"}')).toBe('schedule_edit')
  expect(scheduleObservation('schedule_edit', 'invalid JSON')).toBe('schedule_edit')
  expect(scheduleObservation('unrelated', '{"prompt":"SECRET"}')).toBeUndefined()
})

it('reports only recognizable Schedule results and keeps unknown outcomes unknown', () => {
  const result = (text: string, isError = false) => createToolResultMessage({ callId: 'call' as never,
    content: [{ type: 'text', text }], isError })
  expect(scheduleOutcome(result('{"kind":"rrule","prompt":"SECRET"}'))).toBe('completed')
  expect(scheduleOutcome(result('{"deleted":true}'))).toBe('completed')
  expect(scheduleOutcome(result('{"code":"schedule_conflict","message":"SECRET"}'))).toBe('failed')
  expect(scheduleOutcome(result('malformed'))).toBeUndefined()
  expect(scheduleOutcome(result('unavailable', true))).toBe('failed')
})
