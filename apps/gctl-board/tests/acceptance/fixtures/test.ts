/**
 * Extended Playwright test with kernel API client, CDP observer, and data
 * factories. All acceptance tests import `test` and `expect` from this module.
 *
 * Fixtures:
 *  - kernel   — direct HTTP client to the kernel (bypasses UI)
 *  - cdp      — Chrome DevTools Protocol observer
 *  - seedProject — pre-created project with unique key (test isolation)
 *  - seedBoard   — factory: project + N issues in one call
 */

import { test as base, expect, chromium, type Browser } from "@playwright/test"

// Module-level singleton: Cloudflare Browser Rendering's free tier
// rate-limits connectOverCDP (new session per connect, 3 concurrent,
// per-minute throttle). We enforce *exactly one* connect per CI run by
// caching the Browser handle here. Even if Playwright re-enters the
// browser fixture (worker recycle, fixture timeout, etc.), we reuse the
// same handle instead of opening a second session.
let cdpBrowser: Browser | undefined
let cdpSessionFailure: Error | undefined
import {
  KernelTestClient,
  uniqueProjectKey,
  type TestProject,
  type TestIssue,
} from "./kernel"
import { CDPObserver } from "./cdp"

type BoardFixtures = {
  /** Direct HTTP client to kernel — seed data and verify server state. */
  kernel: KernelTestClient
  /** Chrome DevTools Protocol observer — network, perf, console monitoring. */
  cdp: CDPObserver
  /** Pre-created project with a unique key (one per test for isolation). */
  seedProject: TestProject
  /** Factory: create a project + N issues. Returns project and issues. */
  seedBoard: (
    issueCount: number,
    options?: {
      priorities?: string[]
      labels?: string[][]
    }
  ) => Promise<{ project: TestProject; issues: TestIssue[] }>
}

export const test = base.extend<BoardFixtures>({
  /**
   * Browser fixture: local Chromium launch or Cloudflare Browser Rendering
   * via CDP. Set CDP_ENDPOINT + CF_API_TOKEN to use remote rendering.
   *
   * CDP mode enforces exactly one `connectOverCDP` per CI run via the
   * module-level `cdpBrowser` singleton. Do NOT close the Browser in
   * `use()` teardown — closing ends the CF session and a subsequent
   * worker would need a new connect (→ 429). The session dies naturally
   * when the Node process exits at end of run; `keep_alive` on the CDP
   * URL lets CF reap it if we crash.
   */
  browser: [
    async ({}, use) => {
      const cdpEndpoint = process.env.CDP_ENDPOINT
      if (cdpEndpoint) {
        if (cdpSessionFailure) throw cdpSessionFailure
        if (!cdpBrowser) {
          try {
            const started = Date.now()
            cdpBrowser = await chromium.connectOverCDP(cdpEndpoint, {
              headers: {
                Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
              },
            })
            process.stderr.write(
              `[cdp] connected in ${Date.now() - started}ms (singleton — should log exactly once per CI run)\n`
            )
            cdpBrowser.on("disconnected", () => {
              process.stderr.write("[cdp] Browser disconnected (CF closed session)\n")
            })
          } catch (err) {
            cdpSessionFailure = err as Error
            const msg = err instanceof Error ? err.message : String(err)
            process.stderr.write(`[cdp] connect failed: ${msg}\n`)
            throw err
          }
        } else {
          process.stderr.write("[cdp] reusing Browser handle (fixture re-entered)\n")
        }
        await use(cdpBrowser)
        // Intentionally do NOT close — see block comment above.
        return
      }
      const browser = await chromium.launch({
        args: ["--remote-debugging-port=0"],
      })
      await use(browser)
      await browser.close()
    },
    { scope: "worker", timeout: 120_000 },
  ],

  kernel: async ({}, use) => {
    const previewUrl = process.env.PREVIEW_URL
    const port = process.env.GCTL_KERNEL_PORT ?? "14318"
    const baseUrl = previewUrl ?? `http://localhost:${port}`
    const client = new KernelTestClient(baseUrl)
    if (previewUrl) {
      // Remote mode: Worker already deployed, verify via board API
      const deadline = Date.now() + 30_000
      let reachable = false
      while (Date.now() < deadline) {
        try {
          await client.listProjects()
          reachable = true
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      if (!reachable) {
        throw new Error(
          `Preview Worker not reachable after 30s at ${previewUrl}`
        )
      }
    } else {
      await client.waitForReady()
    }
    await use(client)
  },

  cdp: async ({ page }, use) => {
    const session = await page.context().newCDPSession(page)
    const observer = new CDPObserver(session)
    await observer.enable()
    await use(observer)
    await observer.disable()
    await session.detach()
  },

  seedProject: async ({ kernel }, use) => {
    const key = uniqueProjectKey()
    const project = await kernel.createProject(`Test ${key}`, key)
    await use(project)
  },

  seedBoard: async ({ kernel }, use) => {
    const factory = async (
      issueCount: number,
      options?: { priorities?: string[]; labels?: string[][] }
    ) => {
      const key = uniqueProjectKey()
      const project = await kernel.createProject(`Test ${key}`, key)
      const issues: TestIssue[] = []
      for (let i = 0; i < issueCount; i++) {
        const issue = await kernel.createIssue({
          project_id: project.id,
          title: `Test issue ${i + 1}`,
          priority: options?.priorities?.[i] ?? "none",
          labels: options?.labels?.[i] ?? [],
        })
        issues.push(issue)
      }
      return { project, issues }
    }
    await use(factory)
  },
})

export { expect }

// ── Shared UI Helpers ──

import type { Page } from "@playwright/test"

/**
 * Select a project from the dropdown by its key.
 * Uses the project key (font-mono span) for precise matching in long lists.
 */
export async function selectProject(page: Page, projectKey: string) {
  // Click the project selector button (inside the header's .relative container)
  const selectorContainer = page.locator("header .relative")
  await selectorContainer.locator("button").first().click()

  // Wait for dropdown to appear
  const dropdown = selectorContainer.locator(".absolute")
  await expect(dropdown).toBeVisible()

  // Find the project row by its key (exact match on font-mono key text)
  const projectRow = dropdown
    .locator("button")
    .filter({ hasText: projectKey })
    .first()
  await projectRow.scrollIntoViewIfNeeded()
  await projectRow.click()

  // Wait for board columns to appear (confirms project was selected)
  await expect(page.locator('[data-testid="column-backlog"]')).toBeVisible()
}

/**
 * Click an issue card to open the detail panel.
 * Playwright's default click triggers @dnd-kit's pointer capture,
 * so we use a short delay to let the PointerSensor timeout pass.
 */
export async function clickIssueCard(page: Page, issueId: string) {
  const card = page.locator(`[data-testid="issue-card-${issueId}"]`)
  await expect(card).toBeVisible()
  // Click with a fast mousedown/mouseup to avoid dnd-kit activation
  const box = await card.boundingBox()
  if (!box) throw new Error(`Card ${issueId} not visible`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.click(x, y)
}

/**
 * Drag an issue card to a target kanban column using manual pointer events.
 * Required because @dnd-kit's PointerSensor needs distance >= 8px to activate.
 */
export async function dragIssueToColumn(
  page: Page,
  issueId: string,
  targetStatus: string
) {
  const card = page.locator(`[data-testid="issue-card-${issueId}"]`)
  const target = page.locator(`[data-testid="column-${targetStatus}"]`)

  const cardBox = await card.boundingBox()
  const targetBox = await target.boundingBox()
  if (!cardBox || !targetBox)
    throw new Error(`Element not visible for drag: ${issueId} → ${targetStatus}`)

  const startX = cardBox.x + cardBox.width / 2
  const startY = cardBox.y + cardBox.height / 2
  const endX = targetBox.x + targetBox.width / 2
  const endY = targetBox.y + targetBox.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // Move past the 8px activation threshold with intermediate steps
  await page.mouse.move(startX + 10, startY, { steps: 2 })
  await page.mouse.move(endX, endY, { steps: 10 })
  await page.mouse.up()
}
