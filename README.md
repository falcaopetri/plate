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

PR cards and the ticket-context drawer have **Review no Devin**: it runs `devin -p "/code-review <PR url>"` in the background, in the folder set as `devin_review_dir` in `<data>/sources.md` (the workspace with clones of every repo). The card shows the run state, then a link to the session it created (opens in Devin Desktop). Requires `devin auth login` once on that machine. The box next to the button picks the model (`devin --model`; default `devin_review_model`). The session gets the alias `Review: <PR title>`, is linked from the PR and links back to it, and has a **transcript** button (read-only drawer, local sessions only: `app.devin.ai` refuses to be framed). Override the prompt with `devin_review_prompt: "/my-skill {url}"`.

## Settings, log and shortcuts
The **⚙** in the header opens Settings: every key Plate reads, grouped, each with its default and a `custom`/`default` badge (`sources.md` only holds what you changed; ↺ default removes the key; "Only what I changed" filters; `people:` and `meeting_values:` stay in the file) and the server **Log** (`.cache/plate.log`: writes, errors, slow reads, collector runs with their duration, lock waits). Shortcuts: `r d` syncs Devin now, `r g` GitHub (board, repos, my tickets, review requests), `r a` everything.

## Automatic collection

While `npm start` runs, the server runs the collectors itself: Devin every 2 min, GitHub every 15 min (only with boards in `sources.md`), review requests every 10 min, Todoist every 15 min (only with `TODOIST_API_TOKEN`; the MCP-dump route can't run unattended). Intervals: `PLATE_EVERY_DEVIN` / `PLATE_EVERY_GITHUB` / `PLATE_EVERY_TODOIST` in minutes; `PLATE_NO_SCHEDULE=1` turns it off for that run; `collect: off` in `sources.md` turns it off persistently. The header shows the last sync (hover for each collector's result) and a **Sync now** button; the page refreshes itself every 20 s when the data changed, unless you're typing or dragging.

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
- **Workstreams** (landing): mindmap of the workstream tree (`parent` solid, `related` dashed); drag a node onto another to re-parent; click a node for a full-area focus view (needs you / in progress / coming up / conversations, to-dos, + Meeting note). `t` = Today mode (what moved today lights up, with a timeline).
- **Inbox panel** (beside the map, `i`): unclassified items grouped by kind, review requests first. Search (`/`), filter, click / shift-click to select, `a` all, `m` move by name, `d` dismiss; drag rows (or the selection) onto a node, the focused workstream's title or its child chips. Scope "Dismissed" restores.
- **Needs you**: open Todoist items due today or overdue, sessions in state `waiting`, PRs requesting your review. On the map these make nodes pulse.
- Paste a link or note (Cmd+V outside a form field) to add a `teams` / `link` / `note` item; a GitHub issue/PR url becomes a `ghref` (an issue also brings the PRs that close it). Pasting something already on the plate offers to move it into the open workstream.
- Ticket drawer (⌖ on a GitHub card): parent chain, sub-issues, PRs, dependencies, and a Teams chat about the ticket.

## Configuration (`<data>/sources.md` frontmatter)

| key | what |
|---|---|
| `github_projects: [owner/N, …]` | GitHub Projects boards to collect (needs `gh auth refresh -s read:project`) |
| `github_reviews: off` | turns off the review-requests collector (on by default) |
| `github_mine: off` | turns off the my-tickets collector (on by default): open issues/PRs I opened, am assigned to or was mentioned in, on any repo, board or not; a comment or review by someone else on them (within `mine_days`, default 7) goes to Needs you until you open the ticket from its card or tick ✓ |
| `devin_watch: off` | turns off collecting Devin the moment its `sessions.db` changes (3 s debounce, at most every 15 s; the 1-minute timer stays) |
| `devin_close_prompt` / `devin_close_model` | the **O que falta?** button on any GitHub ticket starts a Devin session with this prompt (`{url}` placeholder; e.g. `/my-skill {url}`) and `--model` (default: `devin_review_model`) |
| `<collector>_every_minutes` | polling interval per collector (`devin` 1, `github` 10, `reviews` 10, `mine` 5, `tasknotes` 5, `todoist` 15 by default), read each tick |
| `collect: off` | turns off all automatic collection (timers); **Sync now** still runs the enabled collectors by hand |
| `devin_review_model` | default `--model` for "Review no Devin" (e.g. `opus`); the box next to the button overrides it |
| `devin_review_dir` | folder where "Review no Devin" runs (the one with the repo clones) |
| `devin_review_prompt` | override, `{url}` placeholder (default `/code-review {url}`) |
| `devin_waiting_minutes` | a Devin session idle this long (and not archived) becomes `waiting` = Needs you (default 2; `0` = immediately) |
| `github_query` | Projects filter sent with every board query (same syntax as the board's filter box), e.g. `-label:Stale`; items it filters out go away from the plate. Empty = the whole board |
| `done_days` | finished items stay under "Recently done" in a workstream this many days (default 7) |
| `stale_days` | an active workstream with something open and no event for this many days is dimmed on the map with an `Nd` badge (default 3; before the event log is that old it counts from where the log starts) |
| `tasknotes_dir` | TaskNotes tasks folder (default `<data>/../TaskNotes/Tasks` if it exists; `off` disables); open tasks with a `due`/`scheduled` date ≤ today go to Needs you |
| `people_dir` | folder of the people notes behind a workstream's `people:` (default `<data>/../../Atlas/People`); optional note frontmatter `role`, `email`, `teams`, `github`, `company` |
| `people_directory: off` / `dscl_node` | directory lookup of people by e-mail through macOS `dscl` (on by default on a Mac; node default `/Search`) |
| `lan: on` | Also listen on the local network, e.g. to open Plate on a phone on the same wifi (default off: `127.0.0.1` only). Other devices need an access token: the server log and ⚙ (on the Mac) print `http://<ip>:4173/?t=<token>`; open it once on the phone and it becomes a cookie. The token lives in `.cache/lan-token`; delete the file and restart to rotate it. Plate has no login and its routes write files and run Devin: keep it off on shared networks. Restart required. On macOS the firewall blocks incoming connections to `node`; instead of allowing every node program, run `scripts/private-node.sh` (copies node to `.bin/`, which `npm start` then uses, and prints the one-time `sudo` line that allows that copy only) |
| `setup_agent` | Who the **Setup pending** badge opens to apply the CHANGELOG: `claude` (default; Claude Code app via `claude://code/new` on this repo with the prompt filled in) or `devin` (headless `devin -p /plate-changelog` in this repo; the session appears in Devin Desktop and Plate offers its link). Set `devin` on the work machine |
| `devin_link: acp` | Devin Desktop older than 3.11 (default `shell`) |
| `people:` block list `- <github login>: <e-mail>` | pre-fills Teams chats about a ticket |
| `obsidian_vault`, `meeting_quickadd` | vault name and QuickAdd choice for "+ Meeting note" |
| `meeting_values:` block list `- <variable>: <text>` | fills the choice's `{{VALUE:<variable>}}`; placeholders `{workstream}` `{project}` `{slug}` `{date}` |

Per workstream (`workstreams/<slug>.md`): `github: [repo:owner/name, issue:owner/repo#N]`: a `repo:` anchor is also a **collection source** (its open issues and PRs are pulled with or without a board; known closed ones stay current) and routes new GitHub items there; `people: ["[[Name]]"]` (mini-CRM); `project:` (vault note name for meeting notes), `color:` (branch color). Environment: `PLATE_DATA_DIR`, `PORT`, `TODOIST_API_TOKEN`, `PLATE_EVERY_<COLLECTOR>` (minutes), `PLATE_NO_SCHEDULE=1`, `PLATE_GH_BIN` (tests). `npm test` runs the suite (stub `gh`, scratch data dir).

**Upgrading:** `CHANGELOG.md` lists, per change, the setup a running machine needs after a pull.

Agents and contributors: see `AGENTS.md`.

## Submit (bug / feature requests)
The **✎ Submit** button in the top bar appends a bug or feature request about Plate itself to `requests.md` in the data folder (`- [ ] YYYY-MM-DD HH:MM · bug|feature · text`). The drawer lists the open ones and lets you tick them. It is the channel that replaces e-mailing requests from work: the agent that maintains Plate reads the open entries and ticks them when implemented.
