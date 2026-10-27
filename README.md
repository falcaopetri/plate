# plate — what's on my plate

Personal work/life cockpit. **Files in open formats are the source of truth**; the webapp is a thin view.
Zero dependencies — Node ≥ 18 only.

Data lives outside this repo at `PLATE_DATA_DIR` (default `./data`). Point it at
your own data folder — e.g. an Obsidian vault subfolder — via the env var, or a
gitignored `.plate-data-dir` file holding the path. Schema: see `README.md` there.

## Run

```bash
npm start            # = node server.mjs → http://localhost:4173  (PORT=… to change)
PLATE_DATA_DIR=/path/to/Plate npm start   # point at another data folder (e.g. on the work machine)
```

The Claude preview tooling uses `.claude/launch.json` (config `plate`).

## Devin review of a PR

PR cards and the ticket-context drawer have **Review no Devin**: it runs `devin -p "/code-review <PR url>"` in the background, in the folder set as `devin_review_dir` in `<data>/sources.md` (the workspace with clones of every repo). The card shows the run state, then a link to the session it created (opens in Devin Desktop). Requires `devin auth login` once on that machine. Override the prompt with `devin_review_prompt: "/my-skill {url}"`.

## Automatic collection

While `npm start` runs, the server runs the collectors itself: Devin every 2 min, GitHub every 15 min (only with boards in `sources.md`), Todoist every 15 min (only with `TODOIST_API_TOKEN`; the MCP-dump route can't run unattended). Intervals: `PLATE_EVERY_DEVIN` / `PLATE_EVERY_GITHUB` / `PLATE_EVERY_TODOIST` in minutes; `PLATE_NO_SCHEDULE=1` turns it off. The header shows the last sync (hover for each collector's result) and a **Sync now** button; the page refreshes itself every 20 s when the data changed, unless you're typing or dragging.

## Collect (Todoist)

```bash
npm run collect:todoist                     # reads .cache/todoist.json (MCP-shaped dump)
node collectors/todoist.mjs --file dump.json
TODOIST_API_TOKEN=… npm run collect:todoist # live REST pull (written from docs, not yet exercised)
```

Pulls overdue + today + next 21 days. Idempotent upsert by id; existing `workstream` assignments are kept; new items land in the Inbox.
The dump is `{"tasks":[{id, content, dueDate, recurring, priority, addedAt}]}` — the shape returned by the Todoist MCP `find-tasks-by-date`
(`startDate: today, daysCount: 21, overdueOption: include-overdue`). A standalone script can't call an MCP server, hence the dump route.

## Collect (GitHub Projects v2)

```bash
gh auth refresh -s read:project                            # once: live routes need this scope
npm run collect:github                                     # live: every board listed in <data>/sources.md `github_projects: [owner/N, …]`
node collectors/github.mjs --owner <owner> --project <N>   # live: one board
npm run collect:github -- --query "assignee:@me -status:Done"   # Projects filter syntax, for big team boards
node collectors/github.mjs --file dump.json                # dump route (gh project item-list … --format json; no parent info)
```

Issues, PRs and drafts from one or more boards (a board mixes workstreams), via `gh api graphql`, with `Status`, iteration, assignees, the issue's `parent` and the issues a PR `closes`. A new item starts in the workstream that anchors one of its epics, `issue:<owner/repo>#<N>` (the epic itself, its sub-issues at any depth, and PRs closing any of them), else the one anchoring its repo (`repo:<owner/name>`), else the Inbox. Set anchors in a workstream's "Edit workstream → GitHub" field.

**Ticket context:** the `owner/repo#N ⌖` button on GitHub cards and Triage rows opens a drawer with the ticket's parent chain, sub-issues (with progress), siblings, blocked-by / blocking and linked PRs, fetched live (any ticket the token can read). Click a related ticket to re-center on it; `+ plate` adds one that isn't on your plate.

## Collect (Devin)

```bash
npm run collect:devin                        # reads ~/.local/share/devin/cli/sessions.db (read-only)
DEVIN_SESSIONS_DB=/path/sessions.db npm run collect:devin   # other location (e.g. Windows)
```

All local Devin sessions (CLI and Desktop share the store), every directory, no 50-row cap: it reads the SQLite DB instead of `devin list`. Needs Node ≥ 22.5 (`node:sqlite`) or the `sqlite3` CLI. Archive flags come from Devin Desktop's `state.vscdb` (`DEVIN_DESKTOP_STATE` to override). Sessions archived in Devin come in as `done` (only in a workstream's "Recently done"); the rest are `idle`, since the DB has no running/waiting signal. Clicking a session opens it in Devin Desktop. The link format depends on the Desktop version: default `devin://app/return/…` (3.11+); set `devin_link: acp` in `<data>/sources.md` for older ones (e.g. 3.4), which use `devin://acp/session?…`.

## Collect (sessions)

`npm run collect:sessions` reads `.cache/sessions.json` (shape documented at the top of `collectors/sessions.mjs`). Session items have `state` `waiting | running | done`; `waiting` shows up in **Needs you**.
A session may carry `"github": "<item url>"`: a new session inherits that item's workstream, so it lands next to its ticket/PR.

## Views
- **Workstreams** (landing) — mindmap of the workstream tree (`parent` solid, `related` dashed); drag a node onto another to re-parent; click a node for a full-area focus view of that workstream (needs you / in progress / coming up / conversations).
- **Board** — Inbox + one column per workstream, collapsed by default (click a header to expand; remembered per browser); drag a card onto any column to reclassify (rewrites `workstream`, appends `item.moved`). `done` items are hidden here.
- **Triage** — dense list of the Inbox (or all open items), sessions grouped by directory. Click / shift-click / click a group header to select, `a` selects all, `m` focuses the move box: type a workstream name and Enter moves the whole selection (an unknown name creates the workstream). Undo in the toast.
- **Needs you** — open Todoist items due today or overdue, plus sessions in state `waiting`.
- Paste a link or note (Cmd+V outside a form field) to add a `teams` / `link` / `note` item. Teams web links are stored as `msteams://` so they open the desktop app. A GitHub issue/PR url becomes a `ghref` item with its real title, kind and state (via `gh api`, if it can reach the repo), routed by the `repo:` anchor; `collect:github` replaces it with the board item when the same url shows up there.

Agents and contributors: see `AGENTS.md`.
