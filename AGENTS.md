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

## After every pull (on any machine)
Read `CHANGELOG.md` and compare its entry numbers with `.plate-changelog-seen` (gitignored, at the repo root; one number). For each newer entry, do its **Setup** steps on this machine: tell the user what was added, ask for the values only they know (e-mails, vault and QuickAdd choice names) and write them into `<data>/sources.md`; then restart the server and write the newest number into `.plate-changelog-seen`. No marker file yet: check which Setup keys are already present in `sources.md` to tell what this machine already has, confirm with the user, then write the marker.
**When you change something that needs setup** (a new `sources.md` key, scope, login, env var, a removed/renamed view or key), add a numbered entry at the top of `CHANGELOG.md` with a Setup list, and document the key in README's Configuration table.

## Data model
Schema source of truth: **`README.md` in the data folder** (`$PLATE_DATA_DIR`, default `./data`; set it to your own data folder). Don't duplicate it here; read it before touching data code. Summary:
- `workstreams/<slug>.md` — YAML frontmatter + body. **Primary entity.** Tree via `parent` (one slug), graph edges via `related` (undirected), `state` active|paused|done, anchors `github: ["repo:owner/name", …]`.
- `items.jsonl` — one item per line, `source` ∈ `todoist | github | session | teams | link | note | ghref`; `workstream` = slug or `null` (Inbox). Moving an item rewrites only that field.
- `events.jsonl` — append-only log (`item.new`, `item.gone`, `item.moved`, `item.state`, `item.removed`, `workstream.new`, `workstream.reparented`, `todo.new`, `todo.done`, `todo.reopened`). Today's events feed the mindmap's Today mode; raw material for a future git-graph view.
- "Needs you" is derived in `lib/store.mjs` (`needsYou`): open Todoist due ≤ today, sessions in state `waiting`, open PRs with `reviewMe` (direct review request); never a `dismissed` item. The focus view also puts PRs with a "review" Status there.

## Layout
- `server.mjs` — stdlib `http` server, JSON routes (`/api/state`, `/api/move` (one `id` or `ids[]`), `/api/ws/create|update`, `/api/ws/todo` (tick, by checkbox index + text guard), `/api/ws/todo/add`, `/api/items/add|add-teams|add-github|remove`) + static `public/`. `/api/state` also carries today's `events` and `people` (sources.md). `/api/items/add` dedupes by url and answers `{existing, workstream}`.
- `lib/store.mjs` — all file IO (items, events, workstreams with a tiny frontmatter parser/patcher), validation (`BadRequest` → HTTP 400), cycle guard for `parent`. `addGithubItem` on an issue also adds the open/merged PRs that close it (live GraphQL) to the same workstream, or moves them there from the Inbox. To-dos = `- [ ]` lines in the workstream body. `readSources()` returns `{github_projects: [], people: {}}` when sources.md is missing.
- `lib/upsert.mjs` — shared collector upsert.
- `lib/schedule.mjs` — in-server collector scheduler (child processes, one at a time) and `withLock`: **every POST handler and every collector run is serialized**, because collectors rewrite `items.jsonl` whole. Running a collector by hand while the server is up bypasses the lock (small race with a drag). `/api/collect` = Sync now; `/api/state` carries `collect` status.
- `lib/devinrun.mjs` — `/api/devin/review {url}`: runs `devin -p "/code-review <url>"` (prompt: `devin_review_prompt`, `{url}` placeholder) in `devin_review_dir` from sources.md, in the background; `runs` in `/api/state`; logs in `.cache/devin-runs/`. On exit it collects Devin and anchors the new session to the PR. Needs the CLI logged in (`devin auth login`; the Desktop login doesn't carry over). Binary: `DEVIN_BIN` / `devin_bin`, else the Devin.app bundle, else `devin` on PATH.
- `lib/ghcontext.mjs` — `/api/gh/context?url=`: one issue/PR with parent chain, sub-issues, siblings, blockedBy/blocking, linked PRs (live GraphQL). Frontend: the drawer (`openCtx`).
- `collectors/*.mjs` — see below. `.cache/` (gitignored) holds dumps; it is personal data.
- `public/index.html` — the entire frontend (CSS + JS inline). Views: **Workstreams** (landing: mindmap → click a node → full-area focus view of one workstream) with the **Inbox panel** on the left (the old Triage list: search, Inbox/All open, kind filter, multi-select, type-ahead bulk move bar; dismiss (`d`, row ✕, scope "Dismissed" to restore: `/api/dismiss`, flag `dismissed` that collectors keep and a move to a workstream clears), review requests grouped first; drag a row, or the selection, onto a map node, onto a focused workstream's header or onto its child chips), and **Needs you** (flat list). Board and Triage views were removed 2026-10-26 (the panel replaces both). Needs-you on the map: amber ring pulsing on nodes, and on the center hub for Inbox items that need you. Smart paste (Cmd+V outside a form field) adds an item: Teams link → `teams`, other single URL → `link`, else `note`; target = focused workstream or Inbox; undo toast. Pasting something already on the plate while a workstream is open offers "Move to <it>". Keys: `1`–`2` switch views, `i` toggles the Inbox panel, `/` = its search, `a`/`m`/`Esc` = select all / move / clear, `t` = Today mode on the mindmap (lit nodes + timeline of today's events). Branch colors hash the root's slug (stable when nodes are added; `color:` in the .md overrides). PR kind color follows GitHub: open green, merged purple, closed red (`ghState` from the collector, `status` for ghref). Focus view: "+ Meeting note" opens `obsidian://quickadd?vault=…&choice=<meeting_quickadd>&value-<var>=…` (sources.md `meeting_values`, placeholders `{workstream}` `{project}` `{slug}` `{date}`; workstream `project:` overrides the name); QuickAdd prompts for unnamed variables like the title. Built against the URI docs, not run against the work vault's choice. Ticket drawer: "Teams chat" builds a `teams.microsoft.com/l/chat/0/0?users=…&topicName=…&message=…` deep link (msteams:// + web), people = author + assignees via `people:`; untested against a real tenant.
- `design-refs/` — reference images and `after/` screenshots of the shipped views.

## Build conventions
- **Vanilla HTML/CSS/JS only. No framework, no build step, no npm installs.** It must stay cloneable onto a locked-down corporate machine.
- Keep changes narrow: frontend work lives in `public/index.html`, server work in `server.mjs` + `lib/`. Don't break existing routes, collectors, or drag-persist.
- Don't hand-edit the vault data to make UI changes work; test against a scratch copy (`PLATE_DATA_DIR=<copy> PORT=4180 node server.mjs`) so real data and the user's running :4173 server stay untouched.
- Don't commit or push unless asked. Don't touch the vault outside `x/Plate/`.
- Every item `url` is only rendered as a link if it is `https?://` or `msteams://`.

## Gotchas
- **A standalone script cannot call MCP connectors** (Todoist etc.). Collectors read a JSON dump in `.cache/*.json` (produced inside an agent session via the MCP, or by a CLI) or hit the service REST API with a token env var.
- **Manual sources (`teams`, `link`, `note`, `ghref`) have no collector.** `upsert(source, …)` only marks items of *its own* source `gone`, which is what keeps manual items safe. Any new manual source must have no collector, be added to `MANUAL_SOURCES` in `lib/store.mjs` (and `MANUAL` in the frontend), and never be fed through `upsert`. After touching `upsert.mjs`, verify a full `npm run collect` leaves manual items intact.
- **Collectors preserve `workstream`** (drags win); an incoming `workstream` is applied only when the item is first created.
- **Two collectors share `source: session`** (`devin.mjs` owns `tool: devin`, `sessions.mjs` the rest); `upsert`'s `owns` keeps one from marking the other's items `gone`.
- **Devin Desktop deep links:** `devin://cascade?prompt=…` only focuses the window on the open session (old editor UI handler); there is no link that starts a new session with a prompt. Triggering a Devin skill on a PR has to go through the CLI (`devin -p "/skill …"`).
- **Devin store:** `devin list` only lists the current directory and stops at 50, so `collectors/devin.mjs` reads `sessions.db` read-only. Archiving is **not** in `sessions.db` (`hidden` stays 0): Devin Desktop keeps it in its own `User/globalStorage/state.vscdb`, key `devin.desktopShell.localSessionAnnotations.<org>` → `{"devin-acp/devin-cli/<id>": {archived, done, folder, parent}}`; the collector reads both DBs. Deep link depends on the Desktop generation, set by `devin_link` in sources.md: `shell` (default) = `devin://app/return/<base64url of /sessions/<encodeURIComponent("acp/devin-cli/<id>")>>`, verified on Desktop 3.11 (there the acp form answers "This session doesn't exist"); `acp` = `devin://acp/session?sessionId=<id>&connectorId=devin-cli`, for older Desktops (3.4.27, the work machine's version, has no shell route; acp verified on it 2026-10-26). Cloud links still use the acp form, untested.
- **Rewriting `workstreams/<slug>.md`:** edit frontmatter lines in place (`patchFrontmatter`), keep the body and unknown fields (Obsidian adds `created`/`modified`). Never regenerate the whole file. `parent:` is written bare when root. Renaming changes `name` only; the slug/filename is stable.
- `related` is undirected but stored one-sided; unlinking removes the back-reference too.
- **GitHub live route** needs `gh auth refresh -s read:project`; without that scope use the dump route.
- The frontmatter parser is minimal (scalars, inline lists, block lists, simple mappings), not full YAML.

## Collectors
| file | command | status |
|---|---|---|
| `collectors/todoist.mjs` | `npm run collect:todoist` | **Dump**: `.cache/todoist.json`, MCP `find-tasks-by-date` shape (`startDate: today, daysCount: 21, overdueOption: include-overdue`). `TODOIST_API_TOKEN` REST path is written but never exercised. |
| `collectors/github.mjs` | `npm run collect:github` (boards in `<data>/sources.md` `github_projects`) or `--owner O --project N`, optional `--query` | **Live** via `gh api graphql` (item-list has no `parent`; needs `read:project`), user or org boards, paginated. Routing on creation: `issue:` epic anchor matched against the item and its parent chain (4 levels; PRs via `closingIssuesReferences`), then `repo:`, then Inbox. A `--query` filter makes filtered-out items `gone`. Ran live against a personal user board (164 items, no hierarchy there); epic routing tested only by reading. |
| `collectors/devin.mjs` | `npm run collect:devin` | **Live**, reads Devin's `sessions.db` (`DEVIN_SESSIONS_DB` to override). Archived (Desktop annotation) → `done`, else `idle`; also stores Devin's own `devinFolder`. `DEVIN_DESKTOP_STATE` overrides the state.vscdb path. Verified on real sessions (2026-10-26). |
| `collectors/reviews.mjs` | `npm run collect:reviews` | **Live** via `gh` search `is:pr is:open user-review-requested:@me` (direct requests only, not team ones). Sets `reviewMe` on matching items of any source (owns that flag, clears it elsewhere); creates `review:<url>` items only for PRs not already on the plate; those go `gone` when the request goes away. Scheduled every 10 min; `github_reviews: off` in sources.md disables it. Tested with substitute `--query`s (no real request on the personal account). |
| `collectors/sessions.mjs` | `npm run collect:sessions` | **Dump**: `.cache/sessions.json`; shape documented in the file header. On the work machine something must convert the Devin CLI's session store into it. A session with `github: <item url>` inherits that item's workstream. Seeded data is example content. |

Planned, not built: Google Calendar, vault projects/GPS collectors, Teams/Outlook via Graph, JSON Canvas export, git-graph view.

## Design system ("cinematográfico funcional")
Dark, calm, one accent. All values are CSS custom properties on `:root` in `public/index.html`; reuse them, don't hardcode.
- **Surfaces:** `--bg #07100f` with two ambient radial glows (`--bg-glow-1` green, `--bg-glow-2` amber) on `body`; translucent layers `--surface / --surface-2 / --surface-3` (white at 3.5/6/9%), hairlines `--line` / `--line-2`. Glass panels use `backdrop-filter: blur`.
- **Text:** `--text`, `--text-2`, `--text-3` (primary → muted).
- **Accent is reserved for "needs you / waiting":** `--accent #ffa56e`, `--accent-soft`, `--accent-line`, `--accent-ink`. Never use it for decoration. Other semantics: `--late` (overdue), `--today`, `--live` (running).
- **Kind colors** (card stripe + kind label via `--k`): `--todo` Todoist, `--pr`, `--issue`, `--sess` session, plus teams `#9db4ff`, link `#7fd0e0`, note `#d9c79a`. New kinds need a `.card.k-<kind>` rule, a glyph in `GLYPH`, and a label.
- **Type & rhythm:** `--fs-xs 11 / sm 12.5 / md 14 / lg 17 / xl 24 / 2xl 34`; system UI font, `--mono` for refs. Spacing `--s1…--s6` = 4/8/12/16/24/32; radii `--r-sm 8 / md 14 / lg 20`. Generous padding, few borders.
- **Chrome:** top bar (brand/view name, clock, date, stat tiles; the "needs you" tile turns amber when > 0). Bottom **dock** (`nav.dock`, floating glass pill) is the only navigation: Workstreams · Needs you (amber pip with count). Add a view by adding a dock button + a render function in the `render()` map (and a `VNAME` entry).
- **Components:** `.card` (left kind stripe, kind row with glyph, title, `.chips`), `.chip` (`.dim`, `.need`, `.late`, `.today`), session `.state` pill with pulse for running, `.ipanel` + `.trow` (Inbox panel rows), `.wnode` (mindmap node, amber pulsing ring when it has needs-you), `.fsec` (focus-view section; `.need` variant has the amber frame), `details.props` for secondary forms, `.toast` (`.ok` with Undo).
- Respect `prefers-reduced-motion`; keep animations short (≈.3s).
