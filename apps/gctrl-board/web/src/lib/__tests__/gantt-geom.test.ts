import { describe, it, expect } from "vitest"
import {
  addDays,
  barRect,
  columnDateAt,
  dayTicks,
  daysBetween,
  gridCoordinateGetter,
  parseDate,
  rangeDays,
  snapDeltaDays,
  ZOOM,
} from "../gantt-geom"

describe("date helpers", () => {
  it("daysBetween is an integer count", () => {
    expect(daysBetween("2026-05-01", "2026-05-01")).toBe(0)
    expect(daysBetween("2026-05-01", "2026-05-14")).toBe(13)
    expect(daysBetween("2026-05-14", "2026-05-01")).toBe(-13)
  })

  it("addDays round-trips", () => {
    expect(addDays("2026-05-01", 13)).toBe("2026-05-14")
    expect(addDays("2026-05-14", -13)).toBe("2026-05-01")
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01")
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01")
  })

  it("parseDate rejects malformed", () => {
    expect(() => parseDate("nope")).toThrow()
    expect(() => parseDate("2026/05/01")).toThrow()
  })
})

describe("barRect", () => {
  const range = { min: "2026-05-01" }
  const colWidth = 32

  it("both dates → anchored at start, inclusive width", () => {
    const r = barRect(
      { start_date: "2026-05-03", due_date: "2026-05-07" },
      range, colWidth,
    )
    expect(r).toEqual({ left: 2 * 32, width: 5 * 32 })
  })

  it("only start_date → DEFAULT_SPAN_DAYS span", () => {
    const r = barRect({ start_date: "2026-05-01" }, range, colWidth)
    expect(r).toEqual({ left: 0, width: 3 * 32 })
  })

  it("only due_date → anchored at due − (span−1)", () => {
    const r = barRect({ due_date: "2026-05-10" }, range, colWidth)
    // span = 3 → left edge at 2026-05-08
    expect(r).toEqual({ left: 7 * 32, width: 3 * 32 })
  })

  it("no dates → null (Unscheduled)", () => {
    expect(barRect({}, range, colWidth)).toBeNull()
    expect(barRect({ start_date: null, due_date: null }, range, colWidth)).toBeNull()
  })

  it("same-day bar has width == 1 column", () => {
    const r = barRect(
      { start_date: "2026-05-05", due_date: "2026-05-05" },
      range, colWidth,
    )
    expect(r).toEqual({ left: 4 * 32, width: 1 * 32 })
  })

  it("zoom mode scales by colWidth", () => {
    const input = { start_date: "2026-05-03", due_date: "2026-05-07" }
    for (const mode of ["day", "week", "month", "quarter"] as const) {
      const { colWidth } = ZOOM[mode]
      const r = barRect(input, range, colWidth)!
      expect(r.left).toBe(2 * colWidth)
      expect(r.width).toBe(5 * colWidth)
    }
  })
})

describe("snapDeltaDays", () => {
  it("rounds to nearest snap unit", () => {
    // day zoom, snap=1 day, col=32
    expect(snapDeltaDays(0, 32, 1)).toBe(0)
    expect(snapDeltaDays(15, 32, 1)).toBe(0)
    expect(snapDeltaDays(17, 32, 1)).toBe(1)
    expect(snapDeltaDays(-40, 32, 1)).toBe(-1)
    expect(snapDeltaDays(100, 32, 1)).toBe(3)
  })

  it("quarter zoom snaps to whole weeks", () => {
    const col = ZOOM.quarter.colWidth // 120
    // snap unit is 7 * 120 = 840px
    expect(snapDeltaDays(419, col, 7)).toBe(0)
    expect(snapDeltaDays(421, col, 7)).toBe(7)
    expect(snapDeltaDays(-841, col, 7)).toBe(-7)
  })
})

describe("columnDateAt", () => {
  const range = { min: "2026-05-01", max: "2026-05-10" }
  it("resolves x to a date on the axis", () => {
    // gridOrigin=100, colWidth=32 → clientX=100 is day 0 = range.min
    expect(columnDateAt(100, 100, 32, range)).toBe("2026-05-01")
    // 100 + 3*32 = 196 → day 3
    expect(columnDateAt(196, 100, 32, range)).toBe("2026-05-04")
  })

  it("clamps below range.min and above range.max", () => {
    expect(columnDateAt(0, 100, 32, range)).toBe("2026-05-01")
    expect(columnDateAt(9999, 100, 32, range)).toBe("2026-05-10")
  })
})

describe("gridCoordinateGetter", () => {
  const getter = gridCoordinateGetter({ colWidth: 32, rowHeight: 40 })
  const base = { currentCoordinates: { x: 100, y: 100 } }

  it("snaps arrow keys to exact column/row deltas", () => {
    expect(getter({ code: "ArrowRight" } as KeyboardEvent, base))
      .toEqual({ x: 132, y: 100 })
    expect(getter({ code: "ArrowLeft" } as KeyboardEvent, base))
      .toEqual({ x: 68, y: 100 })
    expect(getter({ code: "ArrowDown" } as KeyboardEvent, base))
      .toEqual({ x: 100, y: 140 })
    expect(getter({ code: "ArrowUp" } as KeyboardEvent, base))
      .toEqual({ x: 100, y: 60 })
  })

  it("returns undefined for non-arrow keys", () => {
    expect(getter({ code: "Space" } as KeyboardEvent, base)).toBeUndefined()
    expect(getter({ code: "Enter" } as KeyboardEvent, base)).toBeUndefined()
  })
})

describe("axis", () => {
  it("rangeDays is inclusive", () => {
    expect(rangeDays({ min: "2026-05-01", max: "2026-05-01" })).toBe(1)
    expect(rangeDays({ min: "2026-05-01", max: "2026-05-03" })).toBe(3)
  })

  it("dayTicks returns one string per day", () => {
    const ticks = dayTicks({ min: "2026-05-01", max: "2026-05-04" })
    expect(ticks).toEqual([
      "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04",
    ])
  })
})
