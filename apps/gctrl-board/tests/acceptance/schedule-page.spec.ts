/**
 * Schedule page (M1b) — acceptance tests.
 *
 * Drives `/schedule` against a live kernel. The kernel auto-plants
 * `_internal.scheduler_runs_gc` on startup (see PR-2 of M1a) so the
 * page is never *truly* empty — every assertion accounts for at
 * least one routine being present at boot.
 *
 * Tests seed user routines via direct kernel HTTP (`POST
 * /api/schedules`) bypassing the UI; UI is for the assertions only,
 * per the acceptance-fixture authoring rules in CLAUDE.md.
 */
import { test, expect } from "./fixtures/test"

const KERNEL_BASE = `http://localhost:${process.env.GCTRL_KERNEL_PORT ?? 14318}`

interface CreatedSchedule {
  id: string
  name: string
}

async function createUserSchedule(name: string, cron = "0 */2 * * *"): Promise<CreatedSchedule> {
  const res = await fetch(`${KERNEL_BASE}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      cron,
      target_url: "http://127.0.0.1:1/never-fires",
      target_method: "POST",
    }),
  })
  if (!res.ok) {
    throw new Error(`createUserSchedule(${name}) failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as CreatedSchedule
}

async function deleteSchedule(idOrName: string): Promise<void> {
  await fetch(`${KERNEL_BASE}/api/schedules/${encodeURIComponent(idOrName)}`, {
    method: "DELETE",
  })
}

test.describe("Schedule page (/schedule) — M1b", () => {
  test("loads with KPI strip + status grid", async ({ page }) => {
    await page.goto("/schedule")
    // KPI strip renders kernel-computed counts. The bootstrap GC row
    // means total >= 1 even on a fresh kernel.
    await expect(page.getByTestId("schedule-kpi")).toBeVisible()
    await expect(page.getByTestId("schedule-grid")).toBeVisible()
    // Page title in header reflects the new route.
    await expect(page.locator("header h1")).toContainText("schedule")
  })

  test("nav-sidebar entry navigates to /schedule and back", async ({ page }) => {
    await page.goto("/")
    const navBtn = page.getByTestId("nav-schedule")
    await expect(navBtn).toBeVisible()
    await navBtn.click()
    await expect(page).toHaveURL(/\/schedule\/?$/)
    await expect(page.getByTestId("schedule-kpi")).toBeVisible()
  })

  test("user-created routine appears in the grid grouped by prefix", async ({ page }) => {
    const stamp = Date.now().toString(36).slice(-4)
    const name = `audit.codebase-${stamp}`
    const created = await createUserSchedule(name)
    try {
      await page.goto("/schedule")
      const card = page.locator(`[data-routine-name="${name}"]`)
      await expect(card).toBeVisible({ timeout: 5_000 })
      // Health on a freshly-created routine that has never fired must
      // be "pending" — the kernel-computed derived column.
      await expect(card.getByTestId("schedule-health")).toHaveAttribute(
        "data-health",
        "pending",
      )
    } finally {
      await deleteSchedule(created.id)
    }
  })

  test("deep-link /schedule/:name opens the detail drawer", async ({ page }) => {
    const stamp = Date.now().toString(36).slice(-4)
    const name = `gap.deeplink-${stamp}`
    const created = await createUserSchedule(name)
    try {
      await page.goto(`/schedule/${name}`)
      const drawer = page.getByTestId("schedule-drawer")
      await expect(drawer).toBeVisible({ timeout: 5_000 })
      // Drawer header shows the routine name.
      await expect(drawer).toContainText(name)
      // No fires yet → empty-runs hint.
      await expect(page.getByTestId("schedule-drawer-empty-runs")).toBeVisible()
    } finally {
      await deleteSchedule(created.id)
    }
  })

  test("close button on the drawer returns to /schedule", async ({ page }) => {
    const stamp = Date.now().toString(36).slice(-4)
    const name = `digest.close-${stamp}`
    const created = await createUserSchedule(name)
    try {
      await page.goto(`/schedule/${name}`)
      await expect(page.getByTestId("schedule-drawer")).toBeVisible()
      await page.getByTestId("schedule-drawer-close").click()
      await expect(page).toHaveURL(/\/schedule\/?$/)
      await expect(page.getByTestId("schedule-drawer")).not.toBeVisible()
    } finally {
      await deleteSchedule(created.id)
    }
  })

  test("kpi-runs reflects manual fire of an http routine", async ({ page }) => {
    const stamp = Date.now().toString(36).slice(-4)
    const name = `digest.runnow-${stamp}`
    const created = await createUserSchedule(name)
    try {
      // Manual fire via the kernel — same path the UI's "run now"
      // button hits. The target URL points at port 1 which won't
      // accept connections, so the run is recorded as a failure.
      // That's fine — the assertion is "the runs counter advanced",
      // not "the run succeeded".
      const fireRes = await fetch(`${KERNEL_BASE}/api/schedules/${name}/run`, {
        method: "POST",
      })
      expect(fireRes.ok).toBeTruthy()

      await page.goto("/schedule")
      // Wait until the KPI strip shows at least 1 run in 24h.
      await expect
        .poll(
          async () => {
            const txt = await page.getByTestId("schedule-kpi-runs").innerText()
            const m = txt.match(/^[A-Z\s()0-9]*?\n(\d+)/m)
            return m ? Number(m[1]) : 0
          },
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0)
    } finally {
      await deleteSchedule(created.id)
    }
  })
})
