import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
for (const mode of ['original-file', 'readonly-combined']) {
  test(`restores selected text and horizontal scroll in ${mode}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const original = `export const oldName = '${'a'.repeat(150)}SELECT_ME${'b'.repeat(160)}'\n`
    const fixture = createIsolatedLargeDiffRepo(original)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.repoPath, { recursive: true, force: true })
    )
    writeFileSync(fixture.absolutePath, original.replace('oldName', 'newName'))
    writeFileSync(path.join(fixture.repoPath, 'other.txt'), 'other file\n')
    await waitForSessionReady(orcaPage)
    await addAndActivateRepo(orcaPage, fixture.repoPath)
    await orcaPage.evaluate(() =>
      window
        .__store!.getState()
        .updateSettings({ diffDefaultView: 'side-by-side', diffWordWrap: false })
    )
    await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
    const entry = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: path.basename(fixture.relativePath) })
    if (mode === 'readonly-combined') {
      await orcaPage.getByRole('button', { name: 'Stage All', exact: true }).click()
      await expect(
        orcaPage.locator('[data-testid="source-control-entry"][data-source-control-area="staged"]')
      ).toHaveCount(2)
      await orcaPage.getByRole('button', { name: 'View all', exact: true }).first().click()
    } else {
      await entry.click()
      await orcaPage
        .locator('[data-tab-id][data-active="true"]')
        .filter({ hasText: path.basename(fixture.relativePath) })
        .dblclick()
    }
    const host = orcaPage
      .locator('diffs-container')
      .filter({ has: orcaPage.locator('[data-line]', { hasText: 'SELECT_ME' }) })
      .first()
    const side = mode === 'original-file' ? 'deletions' : 'additions'
    const code = host.locator(`[data-code][data-${side}]`)
    await expect(code).toBeVisible({ timeout: 20_000 })
    await code.evaluate((node) => {
      node.scrollLeft = 1000
    })
    const word = await code
      .locator('[data-line]')
      .first()
      .evaluate((row) => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const start = node.textContent?.indexOf('SELECT_ME') ?? -1
          if (start < 0) {
            continue
          }
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + 9)
          const rect = range.getBoundingClientRect()
          return { x: rect.x, right: rect.right, y: rect.y + rect.height / 2 }
        }
        throw new Error('Missing target text')
      })
    await orcaPage.mouse.move(word.right, word.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(word.x, word.y, { steps: 6 })
    await orcaPage.mouse.up()
    const selectedText = () =>
      host.evaluate((host) =>
        (host.shadowRoot as ShadowRoot & { getSelection(): Selection }).getSelection().toString()
      )
    await expect.poll(selectedText).toBe('SELECT_ME')
    const scrollLeft = await code.evaluate((node) => node.scrollLeft)
    if (mode === 'original-file') {
      await orcaPage
        .locator('[data-testid="source-control-entry"]')
        .filter({ hasText: 'other.txt' })
        .click()
      await expect(orcaPage.locator('diffs-container [data-content]')).toContainText('other file')
      await entry.click()
    } else {
      const header = orcaPage
        .locator('[data-combined-diff-section-row]')
        .filter({ hasText: path.basename(fixture.relativePath) })
        .locator('.sticky')
        .first()
      await header.click()
      await expect(host).toHaveCount(0)
      await header.click()
    }
    await expect.poll(() => code.evaluate((node) => node.scrollLeft)).toBeCloseTo(scrollLeft, 0)
    await expect.poll(selectedText).toBe('SELECT_ME')
    await orcaPage.waitForTimeout(300)
    await expect.poll(selectedText).toBe('SELECT_ME')
    if (mode === 'original-file') {
      await expect(host.locator('pre')).toHaveAttribute('data-deleted-text-selection', '')
      expect(
        await code
          .locator('[data-line] span')
          .first()
          .evaluate((node) => getComputedStyle(node, '::selection').backgroundColor)
      ).not.toBe('rgba(0, 0, 0, 0)')
    }
    await orcaPage.screenshot({
      path: testInfo.outputPath(`${mode}-restored-native-selection.png`)
    })
  })
}
