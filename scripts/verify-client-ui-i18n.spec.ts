import { describe, expect, it } from 'vitest'
import { clientSourceRoot, findUiI18nViolations } from './verify-client-ui-i18n.ts'

function messages(source: string, localeSource?: string): string[] {
  return findUiI18nViolations('packages/client/ui-example/src/client/View.tsx', source, localeSource)
    .map(violation => violation.text)
}

const localeSource = `
  const shared = { runningMessage: 'Still running' }
  export const en = { ...shared, renewalLabel: 'Renews' } as const
  export type Key = keyof typeof en
`

describe('Client UI i18n source check', () => {
  it('rejects direct JSX copy and copy-bearing attributes', () => {
    expect(messages(`
      const View = ({ ready }: { ready: boolean }) => <section aria-label="Overview">
        <span>Hard-coded text</span>
        <input placeholder={ready ? 'Search now' : ` + "`Wait ${'${ready}'}`" + `} />
        <div runningSummary="Still working" />
      </section>
    `)).toEqual(['Overview', 'Hard-coded text', 'Search now', 'Wait', 'Still working'])
  })

  it('rejects copy kept in label data and copy helper returns', () => {
    expect(messages(`
      const TABS = [{ id: 'summary', label: 'Summary' }]
      function statusLabel(status: string): string {
        if (status === 'done') return 'Complete'
        return 'Still running'
      }
      function duration(): string { return 'Not recorded' }
      function mode(): string { return 'compact' }
      function displayFailureMessage(): string { return 'API key is invalid' }
      const emptySummary = 'Nothing to show'
      function Dialog({ closeLabel = 'Close dialog' }: { closeLabel?: string }) { return closeLabel }
    `)).toEqual([
      'Summary', 'Complete', 'Still running', 'Not recorded', 'API key is invalid',
      'Nothing to show', 'Close dialog',
    ])
  })

  it('normalizes native separators before deriving a Client source root', () => {
    expect(clientSourceRoot('packages/extensions/sample/src/client/View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages\\extensions\\sample\\src\\client\\View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages/extensions/sample/src/server/index.ts')).toBeUndefined()
  })

  it('accepts translated copy, dynamic values, structural attributes, and language tokens', () => {
    expect(messages(`
      const View = ({ t, value }: { t: (key: string) => string; value: string }) => (
        <section className="root" role="region" aria-label={t('overview')}>
          <span>{t('status.complete')}</span>
          <code>null</code>
          {value === 'pending' && <output>{value}</output>}
          <output>{value}</output>
        </section>
      )
    `)).toEqual([])
  })

  it('accepts known locale keys in typed returns and direct translation arguments', () => {
    expect(messages(`
      import type { Key as LocaleKey } from './locales.ts'
      function statusMessage(ready: boolean): LocaleKey {
        return ready ? 'renewalLabel' : 'runningMessage'
      }
      function View({ t }) {
        const periodLabel = ready ? 'renewalLabel' : 'runningMessage'
        return <div>{t(periodLabel)} {t(statusMessage(ready))}</div>
      }
    `, localeSource)).toEqual([])
  })

  it('rejects undeclared keys, raw JSX, and key bindings with mixed uses', () => {
    expect(messages(`
      import type { Key } from './locales.ts'
      function statusMessage(): Key { return 'unknownMessage' }
      function View({ t }) {
        const rawLabel = 'renewalLabel'
        const missingLabel = 'unknownLabel'
        const storedLabel = 'runningMessage'
        save({ storedLabel })
        return <div>{t(rawLabel)} {rawLabel} {t(missingLabel)} {t(storedLabel)} renewalLabel</div>
      }
    `, localeSource)).toEqual(['unknownMessage', 'renewalLabel', 'unknownLabel', 'runningMessage', 'renewalLabel'])
  })

  it('requires the sibling locale type and a translation binding', () => {
    expect(messages(`
      import type { Key } from './unrelated-types.ts'
      function statusMessage(): Key { return 'renewalLabel' }
    `, localeSource)).toEqual(['renewalLabel'])
    expect(messages(`
      import type { Key } from './locales.ts'
      function View({ t }) {
        const statusLabel = 'runningMessage'
        if (ready) {
          const t = (value: string) => value
          const periodLabel = 'renewalLabel'
          return <div>{t(periodLabel)}</div>
        }
        return <div>{t(statusLabel)}</div>
      }
      function Identity([t]) {
        const label = 'runningMessage'
        return <div>{t(label)}</div>
      }
    `, localeSource)).toEqual(['renewalLabel', 'runningMessage'])
  })

  it('does not inspect locale dictionary owners', () => {
    expect(findUiI18nViolations(
      'packages/client/ui-example/src/client/locales.ts',
      'export const en = { title: "Hard-coded by design" }',
    )).toEqual([])
  })

  it('rejects Electron dialog, title, prompt, and DOM copy outside locale owners', () => {
    const source = `
      dialog.showMessageBox({ title: 'Update available', message: 'Install it now?' })
      window.setTitle('Desktop plugins')
      window.prompt('Target version')
      status.textContent = 'Finished'
    `
    expect(findUiI18nViolations('apps/desktop/src/main.ts', source).map(row => row.text)).toEqual([
      'Update available',
      'Install it now?',
      'Desktop plugins',
      'Target version',
      'Finished',
    ])
  })
})
