/** Recorded conversation views retain their editor and scroll when global pages replace the main view. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SNAPSHOT = fileURLToPath(new URL('../../../snapshots/web/global-panel-retention/', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

it('retains a recorded conversation while a global panel is visible', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false } })
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(SEED, 'utf8'), 'global-panel-retention')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('treeitem').first().click()
  await page.getByRole('treeitem').nth(1).click()
  await page.getByText('DONE', { exact: true }).waitFor()
  const input = page.locator('[data-composer-input][contenteditable=true]').first()
  await input.fill('Keep this unsubmitted draft')
  const original = await input.elementHandle()
  if (original === null) throw new Error('Recorded conversation has no composer')
  const scroll = page.locator('[data-conversation-scroll]').first()
  const position = await scroll.evaluate((element) => {
    element.scrollTop = Math.min(24, element.scrollHeight - element.clientHeight)
    return element.scrollTop
  })
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-panel]').waitFor()
  expect(await original.evaluate(element => element.isConnected)).toBe(true)
  expect(await input.isVisible()).toBe(false)
  await page.getByRole('treeitem').nth(1).click()
  await input.waitFor({ state: 'visible' })
  const sameEditor = await original.evaluate(element =>
    element === document.querySelector('[data-composer-input][contenteditable=true]'))
  const sameScroll = await scroll.evaluate((element, before) => element.scrollTop === before, position)
  expect(sameEditor).toBe(true)
  expect(sameScroll).toBe(true)
  expect(await input.innerText()).toBe('Keep this unsubmitted draft')
  await compareOrRefreshGolden(`${SNAPSHOT}ui.expected.md`, [
    `- Same editor after global navigation: ${sameEditor}`,
    `- Same transcript scroll position: ${sameScroll}`,
    `- Restored draft: ${await input.innerText()}`,
    `- Recorded assistant answer visible: ${await page.getByText('DONE', { exact: true }).isVisible()}`,
  ].join('\n'), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  await assertFixtureInventory(SNAPSHOT, ['ui.expected.md'])
})
