---
id: BOARD-16
project: BOARD
status: backlog
priority: high
labels: [kernel, knowledge, context]
created_by: debuggingfuture
---

# Knowledgebase (gctrl-kb) — persistent wiki for human+agent teams

Build a persistent, interlinked wiki layer on top of gctrl-context. Agents incrementally build and maintain the knowledge base; humans curate sources and ask questions. Inspired by Karpathy's LLM knowledge base pattern.

See spec: specs/architecture/kernel/knowledgebase.md

## Milestones

### M0: Foundation
- kb_links and kb_pages DuckDB tables
- Wikilink extraction from markdown content
- Backlink computation
- HTTP routes: /api/kb/pages, /api/kb/links, /api/kb/stats
- Shell commands: gctrl kb pages, gctrl kb backlinks, gctrl kb stats

### M1: Ingest + Query
- gctrl kb ingest workflow (source → wiki pages)
- gctrl kb query (index-based lookup + synthesis)
- Auto-update index.md and log.md
- File watcher on wiki/ directory

### M2: Lint + Graph
- gctrl kb lint (orphans, stale, contradictions, gaps)
- gctrl kb graph / gctrl kb tree
- Kernel IPC events, inbox integration

### M3: Search + Scale
- Full-text search, semantic search
- Cloud sync for wiki content
