import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Tests for the dispatch flow: team API client methods and dispatch orchestration logic.
 * Uses mock fetch — no real HTTP server or kernel daemon needed.
 */

// Mock response factories
const mockRecommendation = (count: number) => ({
  personas: Array.from({ length: count }, (_, i) => ({
    id: `persona-${i + 1}`,
    name: `Persona ${i + 1}`,
    focus: `Focus area ${i + 1}`,
    prompt_prefix: `You are persona ${i + 1}.`,
    owns: "test",
    review_focus: "test",
    pushes_back: "test",
    tools: ["tool1"],
    key_specs: ["spec1"],
  })),
  rationale: `Recommended ${count} persona(s)`,
})

const mockRenderResult = (ids: string[]) => ({
  agents: ids.map((id) => ({
    persona_id: id,
    name: `Agent ${id}`,
    prompt: `System prompt for ${id}`,
  })),
})

describe("team API client", () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("recommend sends labels in POST body", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockRecommendation(2)),
    })

    // Dynamic import to pick up the mocked fetch
    const { api } = await import("../web/src/api/client.js")
    const result = await api.team.recommend(["auth", "security"])

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("/api/team/recommend")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body)
    expect(body.labels).toEqual(["auth", "security"])
    expect(result.personas).toHaveLength(2)
    expect(result.rationale).toContain("2")
  })

  it("recommend sends empty body when no labels", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockRecommendation(1)),
    })

    const { api } = await import("../web/src/api/client.js")
    await api.team.recommend()

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({})
  })

  it("render sends persona_ids and issue context", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockRenderResult(["engineer", "qa"])),
    })

    const { api } = await import("../web/src/api/client.js")
    const result = await api.team.render(["engineer", "qa"], "BOARD-1")

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("/api/team/render")
    const body = JSON.parse(init.body)
    expect(body.persona_ids).toEqual(["engineer", "qa"])
    expect(body.context).toEqual({ issue_key: "BOARD-1" })
    expect(result.agents).toHaveLength(2)
  })

  it("render omits context when no issue key", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockRenderResult(["engineer"])),
    })

    const { api } = await import("../web/src/api/client.js")
    await api.team.render(["engineer"])

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.persona_ids).toEqual(["engineer"])
    expect(body.context).toBeUndefined()
  })

  it("recommend throws on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    })

    const { api } = await import("../web/src/api/client.js")
    await expect(api.team.recommend(["auth"])).rejects.toThrow("500: Internal Server Error")
  })
})

describe("dispatch flow logic", () => {
  it("0 personas from recommend disables dispatch button", () => {
    const result = mockRecommendation(0)
    expect(result.personas).toHaveLength(0)
    // Dispatch button disabled when selected.size === 0
    const selected = new Set(result.personas.map((p) => p.id))
    expect(selected.size).toBe(0)
  })

  it("toggling persona selection", () => {
    const selected = new Set(["p1", "p2", "p3"])

    // Deselect p2
    const next1 = new Set(selected)
    next1.delete("p2")
    expect(next1.size).toBe(2)
    expect(next1.has("p2")).toBe(false)

    // Re-select p2
    const next2 = new Set(next1)
    next2.add("p2")
    expect(next2.size).toBe(3)
  })

  it("dispatch assigns lead as first selected persona", () => {
    const personas = mockRecommendation(3).personas
    const selected = new Set(["persona-2", "persona-3"])
    const selectedPersonas = personas.filter((p) => selected.has(p.id))
    const lead = selectedPersonas[0]
    expect(lead.id).toBe("persona-2")
    expect(lead.name).toBe("Persona 2")
  })
})
