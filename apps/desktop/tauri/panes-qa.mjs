/** Keyless pane QA against the actual product profile and its existing external fixtures. */
import assert from 'node:assert/strict'
import { join } from 'node:path'

/** Focused browser acceptance without unrelated navigation or native quit gestures. */
export async function verifyComposerActivation(page, state, dir) {
  const panes = page.locator('[data-pane-id]')
  const editor = pane => pane.locator('[data-composer-card] [contenteditable=true]')
  const materialize = async pane => {
    await editor(pane).fill('Conversa independente')
    await editor(pane).press('Enter')
    const deadline = Date.now() + 20000
    while (state.finishModel === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.notEqual(state.finishModel, null)
    state.finishModel()
    await pane.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
  }
  await materialize(panes.first())
  await editor(panes.first()).press('Meta+d')
  await page.locator('[data-pane-focused]').getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await materialize(panes.last())
  await verifyPaneActivation(page, panes.first(), panes.last(), dir)
  await editor(panes.first()).press('Meta+Shift+d')
  const third = page.locator('[data-pane-focused]')
  await third.getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await materialize(third)
  const thirdId = await third.getAttribute('data-pane-id')
  const thirdPane = page.locator(`[data-pane-id="${thirdId}"]`)
  await editor(panes.first()).focus()
  await editor(thirdPane).click()
  assert.equal(await thirdPane.locator('[data-composer-card]').getAttribute('data-composer-editing'), null)
  assert.ok((await thirdPane.locator('[data-composer-card]').boundingBox()).height <= 56)
  await page.screenshot({ path: join(dir, 'three-panes-first-click.png') })
  await editor(thirdPane).click()
  assert.ok((await thirdPane.locator('[data-composer-card]').boundingBox()).height > 76)
  console.log('Composer activation QA passed: compact selection, active stroke, first keystroke, pointer editing, empty blur and independent chats.')
}

/** A real background-job action must not grow the split header when it collapses. */
export async function verifyHeaderHover(page, state, dir) {
  const panes = page.locator('[data-pane-id]')
  const editor = pane => pane.locator('[data-composer-card] [contenteditable=true]')
  state.agentFixture = (input, chunk, finish, response) => {
    const userIndex = input.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('QA_HEADER_JOB'))
    if (userIndex < 0) return false
    if (input.messages.slice(userIndex + 1).some(message => message.role === 'tool')) {
      finish('Tarefa de teste concluída.')
    } else {
      chunk({ tool_calls: [{ index: 0, id: 'call_header_job', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: 'printf header-hover-check', description: 'Verificar cabeçalho', run_in_background: true }),
      } }] }, 'tool_calls')
      response.end('data: [DONE]\n\n')
    }
    return true
  }
  await editor(panes.first()).fill('QA_HEADER_JOB')
  await editor(panes.first()).press('Enter')
  await panes.first().getByText('Tarefa de teste concluída.', { exact: true }).first().waitFor()
  state.agentFixture = null
  await panes.first().getByRole('button', { name: /Tarefas em segundo plano/ }).waitFor()
  await editor(panes.first()).press('Meta+d')
  await page.locator('[data-pane-focused]').getByRole('button', { name: 'Nova conversa', exact: true }).click()
  const otherEditor = editor(panes.last())
  await otherEditor.fill('Conversa independente')
  await otherEditor.press('Enter')
  const deadline = Date.now() + 20000
  while (state.finishModel === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.notEqual(state.finishModel, null)
  state.finishModel()
  await panes.last().getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
  const header = panes.first().locator('[data-conversation-header]')
  const actions = header.locator('[data-conversation-header-actions]')
  for (const width of [1660, 1366, 858]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme })
      await otherEditor.focus()
      await header.hover()
      const expanded = await header.boundingBox()
      await page.screenshot({ path: join(dir, `header-${width}-${theme}-hover.png`) })
      await otherEditor.hover()
      assert.equal(await actions.evaluate(element => getComputedStyle(element).opacity), '0')
      const collapsed = await header.boundingBox()
      await page.screenshot({ path: join(dir, `header-${width}-${theme}-rest.png`) })
      assert.ok(Math.abs(collapsed.height - expanded.height) < 0.5,
        `Header jumped on hover at ${width}px (${theme}): ${collapsed.height} → ${expanded.height}`)
      await header.getByRole('button', { name: /Tarefas em segundo plano/ }).focus()
      assert.equal(await actions.evaluate(element => getComputedStyle(element).opacity), '1')
      assert.ok(Math.abs((await header.boundingBox()).height - expanded.height) < 0.5, 'Keyboard focus must preserve header height')
    }
  }
  console.log('Header hover QA passed: real settled background job, two independent chats, pointer and keyboard, three widths, both themes.')
}

/** A completed reply must leave an upright, stationary Send icon after its receipt settles. */
export async function verifySendLifecycle(page, state, dir) {
  const pane = page.locator('[data-pane-id]').first()
  const editor = pane.locator('[data-composer-card] [contenteditable=true]')
  const primary = pane.locator('[data-composer-primary]')
  let releaseReceipt
  const receiptGate = new Promise(resolve => { releaseReceipt = resolve })
  const holdReceipt = async route => {
    const response = await route.fetch()
    await receiptGate
    await route.fulfill({ response })
  }
  await page.route('**/api/session/prompt', holdReceipt)
  try {
    await editor.fill('Verificar conclusão do envio')
    await editor.press('Enter')
    await primary.locator('svg circle').waitFor()
    assert.equal(await primary.getAttribute('aria-busy'), 'true')
    const deadline = Date.now() + 20000
    while (state.finishModel === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.notEqual(state.finishModel, null, 'Send did not reach the model')
    state.finishModel()
    await pane.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
    await page.screenshot({ path: join(dir, 'send-receipt-pending.png'), animations: 'allow' })
    releaseReceipt()
    await page.waitForFunction(() => document.querySelector('[data-composer-primary]')?.getAttribute('aria-busy') === 'false')
    const idle = await primary.locator('svg').evaluate(svg => ({
      animation: getComputedStyle(svg).animationName,
      transform: getComputedStyle(svg).transform,
      animations: svg.getAnimations().filter(animation => animation.playState === 'running').length,
      progress: svg.querySelector('circle') !== null,
    }))
    assert.deepEqual(idle, { animation: 'none', transform: 'none', animations: 0, progress: false }, 'The idle Send arrow must not retain the progress animation')
    await page.screenshot({ path: join(dir, 'send-completed.png'), animations: 'allow' })
    console.log('Send lifecycle QA passed: delayed receipt, completed reply, idle upright Send arrow without running animations.')
  } finally {
    releaseReceipt()
    await page.unroute('**/api/session/prompt', holdReceipt)
  }
}

/** Verify independent composers, dynamic geometry, navigation and profile-backed restoration. */
export async function verifyPanes(page, context, state, dir) {
  const panes = page.locator('[data-pane-id]')
  const composer = (pane) => pane.locator('[data-composer-card] [contenteditable=true]')
  const focused = () => page.locator('[data-pane-focused]')
  const splitRight = (pane) => pane.getByRole('button', { name: 'Dividir para a direita', exact: true })
  const splitDown = (pane) => pane.getByRole('button', { name: 'Dividir para baixo', exact: true })
  const closePane = async (pane) => {
    await pane.locator('header').first().hover()
    await pane.getByRole('button', { name: 'Fechar painel', exact: true }).click()
  }
  const materialize = async (pane, text) => {
    await composer(pane).fill(text)
    await composer(pane).press('Enter')
    const deadline = Date.now() + 20000
    while (state.finishModel === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.notEqual(state.finishModel, null, 'The conversation did not reach the fixture model')
    state.finishModel()
    await pane.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
  }
  const checkCount = (count) =>
    page.waitForFunction((n) => document.querySelectorAll('[data-pane-id]').length === n, count)
  await checkCount(1)
  assert.equal(await page.locator('[data-sidebar-collapsed=true]').count(), 1)
  await materialize(panes.first(), 'Trabalho independente A')
  assert.equal(state.modelRequests.some(request => request.tools?.some(tool => tool.function?.name === 'message_conversation' || tool.function?.name === 'list_conversation_agents')), false, 'Normal split chats must not mount conversation-agent tools')
  const beforeTools = await panes.first().boundingBox()
  await panes.first().locator('[data-conversation-header]').hover()
  await panes.first().getByRole('button', { name: 'Abrir barra lateral direita', exact: true }).click()
  await page.locator('[data-sidebar-right-guide-entry]').first().waitFor()
  assert.equal(await page.locator('[data-sidebar-right-guide-entry="agents"]').count(), 0, 'The deferred Agents tab must not appear in normal launches')
  await page.screenshot({ path: join(dir, 'panes-tools-without-agents.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Recolher barra lateral direita', exact: true }).click()
  await page.waitForFunction(width => Math.abs(document.querySelector('[data-pane-id]').getBoundingClientRect().width - width) < 0.5, beforeTools.width)
  await verifyNavigationAndQuit(page, panes.first(), dir)
  assert.equal(await panes.first().locator('[data-model-id="pro/deepseek-v4.1-flash"]').count(), 1)
  const firstCard = panes.first().locator('[data-composer-card]')
  await composer(panes.first()).evaluate(element => element.blur())
  assert.ok((await firstCard.boundingBox()).height <= 56, 'An empty idle composer stays compact')
  await composer(panes.first()).focus()
  assert.ok((await firstCard.boundingBox()).height <= 56, 'Restoring keyboard focus does not start editing')
  await composer(panes.first()).click()
  assert.ok((await firstCard.boundingBox()).height > 76, 'Clicking an empty composer expands it for typing')
  await firstCard.locator('[data-composer-tools] button').first().focus()
  assert.ok((await firstCard.boundingBox()).height > 76, 'Keyboard focus in composer controls keeps the composer expanded')
  await page.screenshot({ path: join(dir, 'composer-idle-editing.png'), animations: 'disabled' })
  await composer(panes.first()).fill('Rascunho independente A')
  await composer(panes.first()).press('Meta+d')
  await checkCount(2)
  assert.equal(await focused().getByRole('textbox', { name: 'Buscar conversa', exact: true }).evaluate(element => element === document.activeElement), true)
  assert.equal(await focused().getByText('Aberta', { exact: true }).count(), 1)
  assert.equal(await focused().locator('[data-menu-material]').count(), 0, 'Inline choices use a plain list')
  await page.screenshot({ path: join(dir, 'chooser-inline-light.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(dir, 'chooser-inline-dark.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  const firstId = await panes.first().getAttribute('data-pane-id')
  const secondId = await focused().getAttribute('data-pane-id')
  assert.notEqual(firstId, secondId)
  assert.equal(await page.getByRole('menu').count(), 0, 'Inline conversation choices must not block global shortcuts')
  await composer(panes.first()).press('Meta+Shift+d')
  await checkCount(3)
  await closePane(focused())
  await checkCount(2)
  await page.locator(`[data-pane-id="${secondId}"] input`).click()
  assert.equal(await composer(panes.first()).innerText(), 'Rascunho independente A')
  await focused().getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await composer(focused()).waitFor()
  await composer(focused()).click()
  await focused().locator('[data-composer-card]').hover()
  await focused().getByRole('button', { name: /Selecione o modelo/ }).click()
  await page.getByRole('menuitem', { name: /^Modelo/ }).click()
  await page.getByRole('menuitemradio', { name: 'Qwen Code', exact: true }).click()
  await materialize(focused(), 'Trabalho independente B')
  for (let i = 1; i <= 10; i += 1) {
    state.finishModel = null
    await composer(focused()).fill(`Mensagem ${i}`)
    await composer(focused()).press('Enter')
    const deadline = Date.now() + 20000
    while (state.finishModel === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.notEqual(state.finishModel, null)
    state.finishModel()
    await focused().getByText(`Mensagem ${i}`, { exact: true }).waitFor()
    await focused().locator('[data-composer-card][data-composer-running]').waitFor({ state: 'hidden' })
  }
  await composer(focused()).fill('Rascunho temporário')
  for (let i = 10; i >= 1; i -= 1) {
    await composer(focused()).press('ArrowUp')
    assert.equal((await composer(focused()).innerText()).trim(), `Mensagem ${i}`, 'Up walks this chat’s sent messages')
  }
  for (let i = 2; i <= 10; i += 1) {
    await composer(focused()).press('ArrowDown')
    assert.equal((await composer(focused()).innerText()).trim(), `Mensagem ${i}`, 'Down walks toward newer messages')
  }
  await composer(focused()).press('ArrowDown')
  assert.equal((await composer(focused()).innerText()).trim(), 'Rascunho temporário', 'Down restores the original draft')
  await composer(focused()).press('Meta+a')
  await composer(focused()).press('Backspace')
  await page.waitForFunction(() => document.querySelector('[data-pane-focused] [contenteditable=true]')?.textContent?.trim() === '')
  assert.equal(await focused().locator('[data-model-id="max/qwen3.6-27b"]').count(), 1)
  assert.equal(await panes.first().locator('[data-model-id="pro/deepseek-v4.1-flash"]').count(), 1)
  await verifyPaneActivation(page, panes.first(), page.locator(`[data-pane-id="${secondId}"]`), dir)
  await composer(focused()).fill('Rascunho independente B')
  assert.equal(await composer(panes.first()).innerText(), 'Rascunho independente A')
  await composer(focused()).press('Meta+Alt+ArrowLeft')
  assert.equal(await focused().getAttribute('data-pane-id'), firstId)
  assert.equal(await composer(focused()).evaluate((el) => document.activeElement === el), true)
  await composer(focused()).press('Meta+Alt+ArrowRight')
  assert.equal(await focused().getAttribute('data-pane-id'), secondId)
  await composer(focused()).press('Meta+Shift+d')
  await checkCount(3)
  await focused().getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await composer(focused()).waitFor()
  await materialize(focused(), 'Trabalho independente C')
  assert.equal(await focused().locator('[data-model-id="pro/deepseek-v4.1-flash"]').count(), 1, 'New conversations retain the Flash default after changing another pane')
  await composer(focused()).fill('Rascunho independente C')
  const first = page.locator(`[data-pane-id="${firstId}"]`)
  await first.locator('header').first().hover()
  await splitDown(first).click()
  await checkCount(4)
  await focused().getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await composer(focused()).waitFor()
  await materialize(focused(), 'Trabalho independente D')
  await composer(focused()).fill('Rascunho independente D')
  const previousSession = await focused()
    .locator('[data-conversation-session]')
    .getAttribute('data-conversation-session')
  await focused().locator('[data-conversation-selector]').click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Buscar conversa')
  await page.screenshot({ path: join(dir, 'chooser-popup-light.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(dir, 'chooser-popup-dark.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: 'Nova conversa', exact: true }).last().click()
  await page.waitForFunction(
    (previous) =>
      document
        .querySelector('[data-pane-focused] [data-conversation-session]')
        ?.getAttribute('data-conversation-session') !== previous,
    previousSession,
  )
  await composer(focused()).fill('Outro rascunho, sem substituir a conversa anterior')
  await focused().locator('[data-conversation-selector]').click()
  await page.locator(`[data-conversation-choice="${previousSession}"]`).click()
  await page.waitForFunction(
    (previous) =>
      document
        .querySelector('[data-pane-focused] [data-conversation-session]')
        ?.getAttribute('data-conversation-session') === previous,
    previousSession,
  )
  assert.equal(await composer(focused()).innerText(), 'Rascunho independente D')
  const firstSession = await panes
    .first()
    .locator('[data-conversation-session]')
    .getAttribute('data-conversation-session')
  await focused().locator('[data-conversation-selector]').click()
  await page.locator(`[data-conversation-choice="${firstSession}"]`).click()
  assert.equal(await focused().getAttribute('data-pane-id'), firstId)
  await checkCount(4)
  assert.equal(await splitRight(focused()).isDisabled(), true)
  assert.equal(await splitDown(focused()).isDisabled(), true)
  await composer(focused()).press('Meta+d')
  await checkCount(4)
  const before = await page
    .locator('[data-pane-id]')
    .evaluateAll((elements) =>
      elements.map((el) => ({ id: el.dataset.paneId, text: el.querySelector('[contenteditable=true]')?.textContent })),
    )
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.mouse.move(900, 5)
  const utilities = focused().locator('[data-conversation-header-utilities]')
  const tools = focused().locator('[data-composer-tools]')
  assert.equal(await utilities.evaluate((element) => getComputedStyle(element).opacity), '1')
  assert.equal(await tools.evaluate((element) => getComputedStyle(element).opacity), '0')
  await focused().locator('[data-conversation-header]').hover()
  assert.equal(await utilities.evaluate((element) => getComputedStyle(element).opacity), '1')
  await page.screenshot({ path: join(dir, 'panes-header-hover.png'), animations: 'disabled' })
  await focused().locator('[data-composer-card]').hover()
  assert.equal(await tools.evaluate((element) => getComputedStyle(element).opacity), '1')
  await tools.locator('button').first().focus()
  await page.mouse.move(900, 5)
  assert.equal(await tools.evaluate((element) => getComputedStyle(element).opacity), '1')
  await composer(focused()).focus()
  await page.screenshot({ path: join(dir, 'panes-four-dark.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(dir, 'panes-four-light.png'), animations: 'disabled' })
  await page.mouse.move(20, 250)
  await page.getByRole('button', { name: 'Manter navegação aberta', exact: true }).click()
  await page.getByRole('button', { name: 'Preferências', exact: true }).click()
  const appearanceSaved = page.waitForResponse((response) => response.ok() && response.request().postData()?.includes('minimalist'))
  await page.getByRole('checkbox', { name: 'Modo minimalista de conversa', exact: true }).click()
  await appearanceSaved
  await page.waitForFunction(() => document.querySelector('[data-verboo-page=preferences] input[type=checkbox]')?.checked === true)
  await page.screenshot({ path: join(dir, 'minimalist-preferences.png'), animations: 'disabled' })
  await page.locator('[data-verboo-page=preferences]').getByRole('button', { name: 'Fechar', exact: true }).click()
  await page.locator('[data-verboo-page=preferences]').waitFor({ state: 'hidden' })
  assert.equal(await panes.count(), 4, 'Closing preferences preserves every conversation pane')
  await page.getByRole('button', { name: 'Recolher navegação', exact: true }).click()
  assert.equal(await page.locator('[data-conversation-minimalist=true]').count(), 1)
  assert.equal(await page.locator('[data-chat-assistant-mark]').evaluateAll((elements) => elements.every((element) => getComputedStyle(element).display === 'none')), true)
  assert.equal(await page.locator('[data-chat-user-row]').evaluateAll((rows) => rows.every((row) => {
    const bubble = row.querySelector('[data-message-bubble]')
    if (bubble === null) return true
    return Math.abs(row.getBoundingClientRect().right - bubble.getBoundingClientRect().right) < 1
      && getComputedStyle(bubble).backgroundColor !== 'rgba(0, 0, 0, 0)'
  })), true, 'User messages retain a subtle, right-aligned bubble')
  const gap = await panes.evaluateAll((elements) => {
    const boxes = elements.map(element => element.querySelector('[data-conversation-header]')?.parentElement.getBoundingClientRect()).filter(Boolean)
    const leftmost = boxes.reduce((left, box) => box.left < left.left ? box : left)
    const neighbor = boxes.filter(box => box.left > leftmost.right).sort((a, b) => a.left - b.left)[0]
    return neighbor.left - leftmost.right
  })
  assert.equal(gap, 1.5, 'The visible pane gutter is half its previous width')
  await page.mouse.move(900, 5)
  await page.screenshot({ path: join(dir, 'panes-minimalist-light.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('[data-sidebar-preview=true]').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(dir, 'panes-minimalist-dark.png'), animations: 'disabled' })
  for (const request of state.modelRequests) {
    const payload = JSON.stringify(request.messages)
    const conversations = ['A', 'B', 'C', 'D'].filter((letter) => payload.includes(`Trabalho independente ${letter}`))
    assert.ok(conversations.length <= 1, 'A model request mixed conversation histories')
  }
  const beginStream = async (pane, text) => {
    state.finishModel = null
    await composer(pane).fill(text)
    await composer(pane).press('Enter')
    const deadline = Date.now() + 20000
    while (state.finishModel === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.notEqual(state.finishModel, null, 'Parallel conversation did not reach the model')
    return state.finishModel
  }
  const left = panes.first()
  const right = page.locator(`[data-pane-id="${secondId}"]`)
  await beginStream(left, 'Continue somente a conversa A')
  const finishRight = await beginStream(right, 'Continue somente a conversa B')
  const stop = (pane) => pane.locator('[data-composer-primary]').filter({ has: page.locator('svg rect') })
  await stop(left).waitFor()
  await stop(right).waitFor()
  const cardHeight = (pane) => pane.locator('[data-composer-card]').evaluate((element) => element.getBoundingClientRect().height)
  const compactHeight = await cardHeight(left)
  assert.ok(compactHeight <= 56, 'An empty running composer must fit on one line')
  assert.ok(await cardHeight(right) <= 56)
  await page.screenshot({ path: join(dir, 'panes-running-compact.png'), animations: 'disabled' })
  await composer(left).click()
  assert.ok(await cardHeight(left) <= 56, 'The first click selects an inactive running input without expanding it')
  await composer(left).click()
  assert.ok(await cardHeight(left) > compactHeight + 20, 'A click in the selected input expands it during generation')
  await left.locator('[data-composer-tools] button').first().focus()
  assert.ok(await cardHeight(left) > compactHeight + 20, 'Keyboard focus in the running composer controls must not collapse them')
  await page.screenshot({ path: join(dir, 'composer-running-editing.png'), animations: 'disabled' })
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  assert.ok(await cardHeight(left) <= 56)
  await composer(left).fill('Primeira linha\nSegunda linha')
  assert.ok(await cardHeight(left) > compactHeight + 20, 'Typing must expand the composer without losing the draft')
  await composer(left).fill('')
  await stop(left).waitFor()
  assert.ok(await cardHeight(left) > compactHeight + 20, 'Clearing a draft while editing must not collapse the editor: ' + JSON.stringify(await left.locator('[data-composer-card]').evaluate(element => ({
    editing: element.dataset.composerEditing, empty: element.dataset.composerEmpty, running: element.dataset.composerRunning,
    focusInside: element.contains(document.activeElement), focusTag: document.activeElement?.tagName,
    editable: document.activeElement?.getAttribute('contenteditable'),
  }))))
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await composer(left).focus()
  await composer(left).press('Escape')
  await stop(left).waitFor({ state: 'hidden' })
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  assert.ok(await cardHeight(left) <= 56, 'An idle empty composer returns to one line')
  assert.equal(await stop(right).isVisible(), true, 'Stopping one pane stopped the other conversation')
  finishRight()
  await stop(right).waitFor({ state: 'hidden' })
  await composer(left).fill('Rascunho independente A')
  await composer(right).fill('Rascunho independente B')
  const divider = page.getByRole('separator').first()
  await divider.focus()
  const layoutSaved = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes('paneLayout') && response.request().postData()?.includes('0.475'),
  )
  await divider.press('ArrowLeft')
  await layoutSaved
  const ratio = await divider.getAttribute('aria-valuenow')
  assert.equal(ratio, '48')
  await page.waitForFunction(() => document.querySelector('[data-pane-focused] [contenteditable=true]') !== null)
  await page.reload()
  await checkCount(4)
  assert.equal(await page.locator('[data-conversation-minimalist=true]').count(), 1)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-pane-id]')].every((el) => el.querySelector('[contenteditable=true]')),
  )
  assert.equal(await page.getByRole('separator').first().getAttribute('aria-valuenow'), ratio)
  const after = await panes.evaluateAll((elements) =>
    elements.map((el) => ({ id: el.dataset.paneId, text: el.querySelector('[contenteditable=true]')?.textContent })),
  )
  assert.deepEqual(after, before)
  await page.mouse.move(20, 250)
  await page.getByRole('button', { name: 'Manter navegação aberta', exact: true }).click()
  await page.getByRole('button', { name: 'Conexões', exact: true }).click()
  await page.locator('[data-verboo-page=connections]').waitFor()
  await page.getByRole('button', { name: 'Área de trabalho', exact: true }).click()
  assert.deepEqual(
    await panes.evaluateAll((elements) =>
      elements.map((el) => ({ id: el.dataset.paneId, text: el.querySelector('[contenteditable=true]')?.textContent })),
    ),
    before,
  )
  await page.getByRole('button', { name: 'Recolher navegação', exact: true }).click()
  const closedLayoutSaved = page.waitForResponse((response) => {
    const payload = response.request().postData() ?? ''
    return response.ok() && payload.includes('paneLayout') && [...payload.matchAll(/sessionId/g)].length === 3
  })
  await composer(focused()).press('Meta+w')
  await checkCount(3)
  await closedLayoutSaved
  // The same DOM keyboard path used by Tauri resolves Windows primary to Control.
  await context.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'Win32' }))
  await page.reload()
  await checkCount(3)
  await composer(panes.first()).waitFor()
  await composer(panes.first()).click()
  await composer(panes.first()).press('Control+Alt+ArrowRight')
  assert.notEqual(await focused().getAttribute('data-pane-id'), firstId)
  await composer(focused()).press('Control+w')
  await checkCount(2)
  await closePane(focused())
  await checkCount(1)
  await composer(panes.first()).click()
  await composer(focused()).press('Control+Shift+d')
  await checkCount(2)
  await focused().getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await composer(focused()).waitFor()
  await composer(focused()).press('Control+d')
  await checkCount(3)
  await focused().getByRole('button', { name: 'Nova conversa', exact: true }).click()
  await composer(focused()).waitFor()
  await composer(panes.first()).click()
  await composer(focused()).press('Control+d')
  await checkCount(4)
  await page.screenshot({ path: join(dir, 'panes-windows-bindings.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await checkCount(4)
  await page.screenshot({ path: join(dir, 'panes-narrow.png'), animations: 'disabled' })
  console.log(
    'Pane QA passed: isolated histories, concurrent streams and independent stop, dynamic splits, four-pane bound, direction keys, retained navigation, resize restoration, macOS and Windows DOM key mappings.',
  )
}

/** Selection stays compact; explicit editing and a first keystroke expand the borrowed editor. */
async function verifyPaneActivation(page, first, second, dir) {
  const editor = pane => pane.locator('[data-composer-card] [contenteditable=true]')
  const card = pane => pane.locator('[data-composer-card]')
  const compact = async pane => {
    assert.equal(await card(pane).getAttribute('data-composer-editing'), null)
    assert.ok((await card(pane).boundingBox()).height <= 56, 'Selection must retain a one-line composer')
  }
  const marked = async (active, inactive) => {
    assert.equal(await active.getAttribute('data-pane-focused'), 'true')
    const stroke = pane => card(pane).evaluate(element => getComputedStyle(element).getPropertyValue('--dsw-elevation-stroke-color').trim())
    assert.equal(await stroke(active), await card(active).evaluate(element => getComputedStyle(element).getPropertyValue('--dsw-alias-state-business-primary').trim()))
    assert.notEqual(await stroke(active), await stroke(inactive), 'Only the selected pane has the active composer stroke')
  }
  const draft = await editor(first).innerText()
  await editor(first).focus()
  await editor(first).press('Meta+a')
  await editor(first).press('Backspace')
  assert.equal((await editor(first).innerText()).trim(), '', 'Clear the retained draft before measuring compact selection')
  await editor(second).focus()
  await editor(second).press('Meta+Alt+ArrowLeft')
  await compact(first)
  await compact(second)
  assert.equal(await editor(first).evaluate(element => element === document.activeElement), true)
  await marked(first, second)
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme })
    await page.screenshot({ path: join(dir, `pane-selected-compact-${theme}.png`) })
  }
  await editor(first).press('x')
  await page.waitForFunction(() => document.querySelector('[data-pane-focused] [data-composer-card]')?.hasAttribute('data-composer-editing'))
  assert.equal(await editor(first).innerText(), 'x', 'The first keystroke must reach the selected conversation')
  assert.ok((await card(first).boundingBox()).height > 76)
  await page.screenshot({ path: join(dir, 'pane-typing-expanded.png') })
  await editor(first).press('Backspace')
  assert.ok((await card(first).boundingBox()).height > 76, 'Clearing the draft while editing keeps it open')
  await second.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).last().click()
  await compact(first)
  await compact(second)
  await marked(second, first)
  await editor(second).focus()
  await compact(second)
  await editor(second).click()
  assert.ok((await card(second).boundingBox()).height > 76, 'Clicking the selected composer starts editing')
  await first.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).click()
  await compact(second)
  await marked(first, second)
  await editor(second).click()
  await compact(second)
  await marked(second, first)
  await page.screenshot({ path: join(dir, 'pane-first-click-selects.png') })
  await editor(second).click()
  assert.ok((await card(second).boundingBox()).height > 76, 'A second click starts editing after selecting an inactive input')
  await first.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).click()
  await editor(first).fill(draft)
  await editor(second).focus()
}

/** The existing sidebar overlays retained conversations; quit confirmation uses a mocked native boundary. */
async function verifyNavigationAndQuit(page, pane, dir) {
  await pane.locator('[data-composer-card] [contenteditable=true]').focus()
  const preview = page.locator('[data-sidebar-preview=true]')
  const rectangle = () => pane.boundingBox()
  const before = await rectangle()
  await page.mouse.move(20, 250)
  await preview.waitFor()
  assert.deepEqual(await rectangle(), before, 'Hover navigation must not resize chats')
  await page.screenshot({ path: join(dir, 'navigation-preview-light.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(dir, 'navigation-preview-dark.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.mouse.move(900, 250)
  await preview.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Buscar projeto ou conversa', exact: true }).focus()
  await preview.waitFor()
  await preview.getByRole('button', { name: 'Buscar projeto ou conversa', exact: true }).press('Enter')
  const search = preview.getByRole('textbox', { name: 'Buscar projeto ou conversa', exact: true })
  await search.waitFor()
  assert.equal(await search.evaluate(element => element === document.activeElement), true)
  await search.fill('Acesso')
  await page.screenshot({ path: join(dir, 'navigation-search.png'), animations: 'disabled' })
  await search.press('Escape')
  await preview.waitFor({ state: 'hidden' })
  await page.mouse.move(900, 250)
  await page.mouse.move(20, 250)
  await preview.waitFor()
  await preview.getByRole('button', { name: 'Manter navegação aberta', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-sidebar-collapsed=true]') === null)
  await page.waitForFunction(width => document.querySelector('[data-pane-id]').getBoundingClientRect().width < width - 50, before.width)
  assert.ok((await rectangle()).width < before.width, 'Only pinning navigation makes room for it')
  await page.getByRole('button', { name: 'Recolher navegação', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-sidebar-collapsed=true]') !== null)
  await preview.waitFor({ state: 'hidden' })
  await page.mouse.move(900, 250)
  const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control')
  await page.keyboard.down(primary)
  await page.keyboard.down('q')
  await page.locator('[data-quit-hold]').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(dir, 'quit-hold.png'), animations: 'disabled' })
  await page.keyboard.up('q')
  await page.keyboard.up(primary)
  assert.equal(await page.locator('[data-quit-hold]').isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.qaQuitCalls ?? '0'), '0')
  await page.keyboard.down(primary)
  await page.keyboard.down('q')
  await page.waitForFunction(() => document.documentElement.dataset.qaQuitCalls === '1')
  await page.keyboard.up('q')
  await page.keyboard.up(primary)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.qaQuitCalls), '1')
}
