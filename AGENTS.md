# AGENTS.md — plate

## What this is
"What's on my plate right now?" cockpit for Antonio (personal first, work later via the same code cloned from GitHub). **Files in open formats are the source of truth; the webapp is a thin view** that reads and writes them on every request (no cache, no database). Organizing unit: the **workstream**; items (tasks, tickets, PRs, sessions, conversations, notes) hang off workstreams, and the user classifies by dragging/moving, never by hand-editing properties.

Run (Node ≥ 18, **zero dependencies**):
```bash
npm start                      # node server.mjs → http://localhost:4173 (PORT=… to change)
PLATE_DATA_DIR=/path npm start # data folder; default is the Obsidian vault folder x/Plate (see store.mjs)
npm run collect                # todoist + github + sessions
```
**Restart gotcha:** the server loads routes at startup. After changing `server.mjs`/`lib/`, restart: `lsof -ti:4173 | xargs kill; npm start`. Frontend changes (`public/index.html`) only need a reload. Preview tooling uses `.claude/launch.json` (config `plate`); if 4173 is busy it picks another port.

## Data model
Schema source of truth: **`README.md` in the data folder** (`$PLATE_DATA_DIR`, default `./data`; set it to your own data folder). Don't duplicate it here; read it before touching data code. Summary:
- `workstreams/<slug>.md` — YAML frontmatter + body. **Primary entity.** Tree via `parent` (one slug), graph edges via `related` (undirected), `state` active|paused|done, anchors `github: ["repo:owner/name", …]`.
- `items.jsonl` — one item per line, `source` ∈ `todoist | github | session | teams | link | note`; `workstream` = slug or `null` (Inbox). Moving an item rewrites only that field.
- `events.jsonl` — append-only log (`item.new`, `item.gone`, `item.moved`, `item.state`, `item.removed`, `workstream.new`, `workstream.reparented`). Raw material for a future git-graph view (not built).
- "Needs you" is derived in `lib/store.mjs` (`needsYou`): open Todoist due ≤ today, sessions in state `waiting`. The focus view also puts PRs with a "review" Status there.

## Layout
- `server.mjs` — stdlib `http` server, JSON routes (`/api/state`, `/api/move`, `/api/ws/create|update`, `/api/items/add|add-teams|remove`) + static `public/`.
- `lib/store.mjs` — all file IO (items, events, workstreams with a tiny frontmatter parser/patcher), validation (`BadRequest` → HTTP 400), cycle guard for `parent`.
- `lib/upsert.mjs` — shared collector upsert.
- `collectors/*.mjs` — see below. `.cache/` (gitignored) holds dumps; it is personal data.
- `public/index.html` — the entire frontend (CSS + JS inline). Views: **Workstreams** (landing: mindmap → click a node → full-area focus view of one workstream), **Board** (Inbox + a column per workstream, drag cards), **Needs you** (flat list). Smart paste (Cmd+V outside a form field) adds an item: Teams link → `teams`, other single URL → `link`, else `note`; target = focused workstream or Inbox; undo toast.
- `design-refs/` — reference images and `after/` screenshots of the shipped views.

## Build conventions
- **Vanilla HTML/CSS/JS only. No framework, no build step, no npm installs.** It must stay cloneable onto a locked-down corporate machine.
- Keep changes narrow: frontend work lives in `public/index.html`, server work in `server.mjs` + `lib/`. Don't break existing routes, collectors, or drag-persist.
- Don't hand-edit the vault data to make UI changes work; test against a scratch copy (`PLATE_DATA_DIR=<copy> PORT=4180 node server.mjs`) so real data and the user's running :4173 server stay untouched.
- Don't commit or push unless asked. Don't touch the vault outside `x/Plate/`.
- Every item `url` is only rendered as a link if it is `https?://` or `msteams://`.

## Gotchas
- **A standalone script cannot call MCP connectors** (Todoist etc.). Collectors read a JSON dump in `.cache/*.json` (produced inside an agent session via the MCP, or by a CLI) or hit the service REST API with a token env var.
- **Manual sources (`teams`, `link`, `note`) have no collector.** `upsert(source, …)` only marks items of *its own* source `gone`, which is what keeps manual items safe. Any new manual source must have no collector, be added to `MANUAL_SOURCES` in `lib/store.mjs` (and `MANUAL` in the frontend), and never be fed through `upsert`. After touching `upsert.mjs`, verify a full `npm run collect` leaves manual items intact.
- **Collectors preserve `workstream`** (drags win); an incoming `workstream` is applied only when the item is first created.
- **Rewriting `workstreams/<slug>.md`:** edit frontmatter lines in place (`patchFrontmatter`), keep the body and unknown fields (Obsidian adds `created`/`modified`). Never regenerate the whole file. `parent:` is written bare when root. Renaming changes `name` only; the slug/filename is stable.
- `related` is undirected but stored one-sided; unlinking removes the back-reference too.
- **GitHub live route** needs `gh auth refresh -s read:project`; without that scope use the dump route.
- The frontmatter parser is minimal (scalars, inline lists, block lists, simple mappings), not full YAML.

## Collectors
| file | command | status |
|---|---|---|
| `collectors/todoist.mjs` | `npm run collect:todoist` | **Dump**: `.cache/todoist.json`, MCP `find-tasks-by-date` shape (`startDate: today, daysCount: 21, overdueOption: include-overdue`). `TODOIST_API_TOKEN` REST path is written but never exercised. |
| `collectors/github.mjs` | `npm run collect:github` or `node collectors/github.mjs --owner O --project N` | **Dump** (`.cache/github.json`, = `gh project item-list N --owner O --format json -L 200`); live `gh` route written, never run (no `read:project` scope). New items are routed by the workstream anchor `repo:<owner/name>`. Seeded data is example content. |
| `collectors/sessions.mjs` | `npm run collect:sessions` | **Dump**: `.cache/sessions.json`; shape documented in the file header. On the work machine something must convert the Devin CLI's session store into it. A session with `github: <item url>` inherits that item's workstream. Seeded data is example content. |

Planned, not built: Google Calendar, vault projects/GPS collectors, Teams/Outlook via Graph, JSON Canvas export, git-graph view.

## Design system ("cinematográfico funcional")
Dark, calm, one accent. All values are CSS custom properties on `:root` in `public/index.html`; reuse them, don't hardcode.
- **Surfaces:** `--bg #07100f` with two ambient radial glows (`--bg-glow-1` green, `--bg-glow-2` amber) on `body`; translucent layers `--surface / --surface-2 / --surface-3` (white at 3.5/6/9%), hairlines `--line` / `--line-2`. Glass panels use `backdrop-filter: blur`.
- **Text:** `--text`, `--text-2`, `--text-3` (primary → muted).
- **Accent is reserved for "needs you / waiting":** `--accent #ffa56e`, `--accent-soft`, `--accent-line`, `--accent-ink`. Never use it for decoration. Other semantics: `--late` (overdue), `--today`, `--live` (running).
- **Kind colors** (card stripe + kind label via `--k`): `--todo` Todoist, `--pr`, `--issue`, `--sess` session, plus teams `#9db4ff`, link `#7fd0e0`, note `#d9c79a`. New kinds need a `.card.k-<kind>` rule, a glyph in `GLYPH`, and a label.
- **Type & rhythm:** `--fs-xs 11 / sm 12.5 / md 14 / lg 17 / xl 24 / 2xl 34`; system UI font, `--mono` for refs. Spacing `--s1…--s6` = 4/8/12/16/24/32; radii `--r-sm 8 / md 14 / lg 20`. Generous padding, few borders.
- **Chrome:** top bar (brand/view name, clock, date, stat tiles; the "needs you" tile turns amber when > 0). Bottom **dock** (`nav.dock`, floating glass pill) is the only navigation: Workstreams · Board · Needs you (amber pip with count). Add a view by adding a dock button + a render function in the `render()` map.
- **Components:** `.card` (left kind stripe, kind row with glyph, title, `.chips`), `.chip` (`.dim`, `.need`, `.late`, `.today`), session `.state` pill with pulse for running, `.col` (board column), `.wnode` (mindmap node, amber glow when it has needs-you), `.fsec` (focus-view section; `.need` variant has the amber frame), `details.props` for secondary forms, `.toast` (`.ok` with Undo).
- Respect `prefers-reduced-motion`; keep animations short (≈.3s).
