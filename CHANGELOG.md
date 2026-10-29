# Changelog

Newest first. Each entry has a number; **Setup** lists what a machine that already runs Plate must do after pulling it
(config in `<data>/sources.md`, logins, restarts). Entries without Setup need only a restart.

Applying entries after a pull: see "After every pull" in `AGENTS.md`. The last number applied on a machine is kept in the
gitignored file `.plate-changelog-seen` at the repo root.

## 9 — 2026-10-29: Devin run kept when the CLI dies after the session exists, toasts in the corner, bell, nesting, Top 3 ✓, `github_query`

- **A Devin review/check no longer shows "failed" when the session was created**: if the CLI exits non-zero (a tool call rejected by a pre-hook, say) after the session exists, the run is `done` with a "session kept" note, and the session is still anchored and renamed (`Review: <title>`). Finding the session now compares folders by real path and falls back to the only session born in the run window. The alias lives in Plate only: the Devin CLI has no way to rename a session.
- **Toasts** are neutral and stack bottom-right; only errors are red (starting a session used to show a red toast).
- **Bell (🔔 in the top bar)** logs what starts needing you: a session waiting, a review request, a new comment on my ticket, a finished Devin run. Per browser, last 40; a count on the bell, nothing pops up. For machines where browser notifications are blocked.
- **Nesting in a workstream:** a Devin session hangs under its PR, a PR under the issue it closes (same workstream), with a connector line. Needs-you on a child lifts the whole stack into "Needs you / next".
- **"Teams → @author"** on a PR after a Devin review (or any anchored session): opens a Teams chat to its author with a draft message (needs the login in `people:`). Board items now carry the PR `author`.
- **Top 3 ✓:** each pin has a ✓ ("I did this"; ↺ reopens). Stored as `done: true` in the pin.
- **`github_query`** (sources.md, Settings): a Projects filter sent with every board query, e.g. `-label:Stale`, instead of pulling the whole board.
- **`done_days`** (default 7): finished items older than this leave "Recently done".

**Setup**
1. Restart the server (the new `author` field fills on the next GitHub sync).
2. Optional: `github_query: "-label:Stale"` in `<data>/sources.md` (or in ⚙).
3. Work machine: `people:` needs the PR authors' logins → e-mails for the Teams button (same map as the ticket drawer).

## 8 — 2026-10-29: archived Devin sessions (new format), no more "server busy", session tied to the PR at once, Today lights the path to the root

- **Archived Devin sessions** are recognised in the Desktop's current format (`windsurf.acp.session/archivedSessions`, a list of `acp/devin-cli/<id>`) as well as the legacy `localSessionAnnotations`: they are `done` and leave Needs you even when the last message left the turn to you.
- **Server busy:** the GitHub / mine / reviews / Todoist collectors no longer hold the write lock while they wait on the network, so drags and edits don't queue behind them.
- **Review / "O que falta?"** ties the new Devin session to the PR (and its workstream) as soon as it appears, not when the run ends.
- **Today mode** also lights each touched workstream's parents up to the root.
- **`/plate-changelog`** (Devin project skill): in Devin opened on this repo, it applies the pending CHANGELOG entries.

**Setup**
1. Restart the server.
2. Optional: if archived sessions still show on a machine, the Log line `devin: N sessions, M archived` must have `M` > 0; otherwise send `sqlite3 "<Devin state.vscdb>" "select key from ItemTable where key like '%rchived%' or key like '%ession%'"`.

## 7 — 2026-10-28: my tickets + their comments, Devin on your turn, r d / r g, Settings and log

- **My tickets:** a new collector (`mine`, every 5 min) pulls the open issues and PRs I opened, am assigned to or was mentioned in, on any repo (no board needed), into the Inbox (or the workstream with that `repo:` anchor). A comment or review by someone else on them, newer than `mine_days` (default 7), is **Needs you** with a 💬 chip until you open the ticket from its card or tick ✓. Needs `gh` logged in; nothing new to authorize. `github_mine: off` turns it off.
- **Devin on your turn = Needs you** even before the 2-minute idle; a cancelled/interrupted tool call counts as your turn too (matched on the tool result's text, not seen on a real run). The collector's line now says how many sessions are archived and how many annotations it found, and warns when it found none.
- **`r d` / `r g` / `r a`:** sync Devin / GitHub / everything on the spot. Devin is also collected right after its `sessions.db` changes (`devin_watch: off` to disable).
- **O que falta?** on any GitHub ticket starts a Devin session asking what is left to close it (`devin_close_prompt`, `devin_close_model`).
- **⚙ Settings** edits `sources.md` from the UI; **Log** shows `.cache/plate.log` (requests that write or fail or are slow, collector durations, lock waits with who holds it).
- Fixed: the review-requests collector crashed on a `repo:` anchor written as an object.

**Setup**
1. Restart the server.
2. Optional, in Settings (or `sources.md`): `devin_close_prompt` (e.g. `/your-skill {url}`) and `devin_close_model` for **O que falta?**; without them it asks in plain words with the review model.
3. If archived Devin sessions still show as "your turn" on a machine, open the Log after a Devin run: `devin: N sessions, M archived (K annotations)`. `K` = 0 means the Desktop's `state.vscdb` has no annotations under the key the collector looks for; send `sqlite3 "<Devin state.vscdb>" "select key from ItemTable where key like '%ession%'"`.

## 6 — 2026-10-27: repo anchors collect, stale Devin sessions, TaskNotes, people, readable transcript

- **`repo:owner/name` anchors are a collection source:** Sync and the schedule pull each anchored repo's open issues and PRs into its workstream, with or without a board (the collector turns on by itself). A board item wins over the same url from the repo; items already held from those repos (including a pasted link such as a merged PR) are re-fetched so they stay current; closed history is not imported. Rules now also route closed/merged items.
- **Devin sessions waiting on you:** idle for `devin_waiting_minutes` (default 2, the prompt-cache window is 5 min) and not archived → `waiting` (Needs you), with a "your turn" chip when Devin's last message ended its turn. The tab title shows the Needs-you count; click the Needs-you tile once to allow desktop notifications.
- **Archived sessions** disappear from the workstream view and its counts.
- **Review no Devin** also shows on draft PRs.
- **TaskNotes:** open tasks of the plugin's folder arrive as items; due/scheduled ≤ today = Needs you.
- **Mini-CRM:** a People row on each workstream (`people:` → notes in `people_dir`, with role, e-mail and a Teams chat link).
- **Transcript drawer** renders markdown, newest first (latest three open, older folded).
- **Create from the UI:** a dated task (writes a TaskNote file into the tasks folder; workstream → `projects:`) and a new person (writes a note in `people_dir`, links it to the workstream).
- **People from the directory (macOS, `dscl`):** creating a person by e-mail fills the note's properties (`role`, `department`, `company`, `email`, `photo`, `directory_synced`) from the Mac's directory (`/Search`), and ↻ on a person re-reads them. Teams chat opens from the e-mail (`teams` property overrides). **Untested against a real directory** (stub only): on the work Mac, try "new person" with a colleague's e-mail; if fields come back empty, send `dscl /Search -read /Users/<their record> | head -60` so the attribute names can be mapped.
- **Replay of past days:** in Today mode (`t`) the timeline has ← date → and a date picker (`/api/events?day=YYYY-MM-DD`); it reads `events.jsonl`, so only days the Plate was running (collectors or UI) have events.
- **Schedule:** Devin every 1 min, GitHub every 10 min (`<collector>_every_minutes` in `sources.md`, e.g. `github_every_minutes: 10`; read each tick).
- `npm test` (stub `gh`, scratch data dir).

**Setup**
1. Restart the server.
2. Optional: `devin_waiting_minutes: 2`, `tasknotes_dir: <folder>` (or `off`), `people_dir: <folder>` in `sources.md`. Where the data lives in `x/Plate`, the defaults already find `x/TaskNotes/Tasks` and `Atlas/People`.
3. Work machine (untested there): check the TaskNotes folder and the people notes' frontmatter (`email`, `teams`) match that vault.

## 5 — 2026-10-27: routing rules on existing items, snooze, rename/label, Devin model + transcript, write-lock diagnostics

- **Routing rules apply to items already on the plate:** an Inbox item whose repo matches a workstream's `repo:` anchor moves there (and an Inbox session anchored to a classified PR follows the PR). Runs after every collector, on Sync now, when a workstream's anchors change, and from the Inbox's **Apply rules** button.
- **Snooze** in Needs you (3 hours / tomorrow 9:00 / 3 days / next Monday): the item leaves Needs you until then and sits in a "Snoozed" section.
- **Rename / label** (✎ on any card): `alias` shows instead of the title, `label` is free text with suggestions (e.g. "Chat com PO"). Collectors never overwrite them. Devin review sessions get the alias `Review: <PR title>` automatically.
- **Devin review model:** a box next to **Review no Devin** (remembered in the browser) or `devin_review_model` in `sources.md`; passed as `devin --model`.
- **Review sessions are linked both ways:** the PR lists its sessions, a session shows `↳ owner/repo#N` (opens the PR context).
- **Devin transcript drawer** (local sessions): reads the conversation from `sessions.db`, read-only.
- **Write lock diagnostics:** `/api/state` carries `busy` (what holds the lock); a write that waits >5s logs it; the UI gives up after 20s and says what the server is busy with; a collector that hangs is killed (SIGKILL) and abandoned after 130s instead of blocking every write.

**Setup**
1. Restart the server.
2. Optional: `devin_review_model: opus` in `sources.md`.
3. `devin auth login` once on any machine that uses Review no Devin (the Desktop login does not carry over to the CLI).

## 4 — 2026-10-26: `collect: off`

- New `sources.md` key `collect: off`: stops every automatic collector (Devin included, which had no switch), read at each tick, so no restart needed. **Sync now** still collects by hand.

**Setup**
1. Restart the server.
2. Optional: add `collect: off` to `sources.md` to keep the plate manual-only.

## 3 — 2026-10-26: Inbox panel, review requests, dismiss, to-dos, Today mode, Teams chat, meeting notes

- **Board and Triage views removed.** The Triage list is now the **Inbox panel** beside the mindmap (`i` toggles, `/` searches): multi-select and drag rows onto workstream nodes, the focused workstream's title, or its child chips.
- **Dismiss** Inbox items without classifying them (`d`, the row's ✕); scope "Dismissed" restores them.
- **Review requests:** new collector `reviews` (every 10 min) brings open PRs that request a review from *you* directly (`user-review-requested:@me`, not team requests) into the Inbox and Needs you.
- **Attaching an issue** (paste or "+ plate") also brings the PRs that close it.
- **Paste dedupe:** pasting a link already on the plate offers to move it into the open workstream.
- **To-dos per workstream:** `- [ ]` lines in the body of `workstreams/<slug>.md`, ticked and added in the focus view.
- **Today mode** (`t` on the mindmap): workstreams touched today light up, with a timeline of today's events.
- **Needs you on the map:** nodes pulse amber; the center hub pulses for Inbox items that need you.
- **Teams chat** from a ticket (drawer ⌖): deep link with author + assignees, title and URL.
- **+ Meeting note** on a workstream: runs your vault's QuickAdd meeting choice through `obsidian://quickadd`.
- Stable branch colors on the mindmap; PR colors follow GitHub (open green, merged purple, closed red); keys `1`–`2` switch views.
- `readSources()` no longer breaks when `sources.md` is missing.
- **This changelog**, plus a "Setup pending" badge in the header while it has entries this machine hasn't applied (`.plate-changelog-seen`).

**Setup**
1. Restart the server (new routes and a new collector).
2. If this checkout has a local edit to `readSources` in `lib/store.mjs` (the missing-`sources.md` fix), drop it before pulling: this version includes it (`git checkout -- lib/store.mjs`, then pull).
3. `gh auth status` must show the `repo` scope for the review search (it already needs `read:project` for boards). To turn the review collector off: `github_reviews: off`.
4. Teams chat: map GitHub logins to work e-mails, so the chat is pre-filled:
   ```yaml
   people:
     - octocat: octocat@company.com
   ```
5. Meeting notes: name the vault and the QuickAdd choice exactly as in Obsidian, and fill the choice's named variables (`{{VALUE:project}}` → key `project`). Placeholders: `{workstream}`, `{project}`, `{slug}`, `{date}`. QuickAdd still asks for unnamed ones (the title) in Obsidian.
   ```yaml
   obsidian_vault: My Work Vault
   meeting_quickadd: Meeting note
   meeting_values:
     - project: "[[{project}]]"
   ```
   When a workstream's vault project note has another name, add `project: <note name>` to that workstream's `.md`.
6. Optional: `color: "#7fb5f0"` in a root workstream's `.md` pins its branch color.

## 2 — 2026-10-26: Devin Desktop link format

Session links depend on the Devin Desktop generation.

**Setup**
1. On Devin Desktop older than 3.11 (e.g. 3.4): `devin_link: acp` in `sources.md`. Newer ones need nothing (`shell` is the default).

## 1 — 2026-10-25: baseline (cockpit v1, collectors, Devin review)

Workstreams mindmap, GitHub Projects / Devin / Todoist / sessions collectors, ticket context drawer, auto-sync, "Review no Devin".

**Setup** (a fresh machine)
1. Node ≥ 18 (≥ 22.5, or the `sqlite3` CLI, for the Devin collector).
2. Point at the data folder: `PLATE_DATA_DIR=…` or a `.plate-data-dir` file with the path.
3. GitHub boards: `gh auth refresh -s read:project`, then `github_projects: [owner/N, …]`.
4. Devin review button: `devin auth login` once, and `devin_review_dir: <folder with the repo clones>`.
5. Todoist (optional): `TODOIST_API_TOKEN` in the environment.
