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
node collectors/github.mjs --owner <owner> --project <N>   # live via gh (needs: gh auth refresh -s read:project)
gh project item-list <N> --owner <owner> --format json -L 200 > .cache/github.json && npm run collect:github   # dump route
```

Issues, PRs and drafts, with the board's `Status` and `Iteration` fields. New items whose repo matches a workstream anchor `repo:<owner/name>` start in that workstream; otherwise the Inbox.

## Collect (sessions)

`npm run collect:sessions` reads `.cache/sessions.json` (shape documented at the top of `collectors/sessions.mjs`). Session items have `state` `waiting | running | done`; `waiting` shows up in **Needs you**.
A session may carry `"github": "<item url>"`: a new session inherits that item's workstream, so it lands next to its ticket/PR.

## Views
- **Workstreams** (landing) — mindmap of the workstream tree (`parent` solid, `related` dashed); drag a node onto another to re-parent; click a node for a full-area focus view of that workstream (needs you / in progress / coming up / conversations).
- **Board** — Inbox + one column per workstream; drag a card to reclassify (rewrites `workstream`, appends `item.moved`).
- **Needs you** — open Todoist items due today or overdue, plus sessions in state `waiting`.
- Paste a link or note (Cmd+V outside a form field) to add a `teams` / `link` / `note` item.

Agents and contributors: see `AGENTS.md`.
