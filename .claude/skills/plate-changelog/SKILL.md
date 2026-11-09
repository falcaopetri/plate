---
name: plate-changelog
description: Apply the pending Plate CHANGELOG entries on this machine after a git pull. Use when asked to "apply the changelog", "update Plate", or after pulling new Plate commits.
---

# Apply Plate's pending CHANGELOG entries

Run from the Plate repo root (the folder holding `server.mjs`). This is the "After every pull" procedure of `AGENTS.md`, step by step.

1. **Find what is pending.** Read `.plate-changelog-seen` (one number; gitignored). List the `CHANGELOG.md` entries (`## N — …`) with a number greater than it. No marker file: for each entry, check whether its **Setup** keys already exist in `<data>/sources.md` to tell what this machine already has, confirm with the user which entries to apply, and continue. Nothing pending: say so and stop.
2. **Locate the data folder:** `.plate-data-dir` (gitignored) holds it, else `$PLATE_DATA_DIR`, else `./data`. Its `sources.md` is this machine's configuration.
3. **For each pending entry, oldest first:** tell the user, in one or two lines, what it adds; then do its **Setup** list.
   - Keys with values only the user knows (e-mails, vault and QuickAdd choice names, `devin_review_dir`, `devin_link`, models): ask, then write them into `sources.md` (or via ⚙ Settings). Never invent a value.
   - Never remove or change `collect:` unasked (the user may keep it `off` on purpose).
   - Logins (`gh auth`, `devin auth login`) are the user's: check with `gh auth status` / `devin auth status`, report what is missing, do not log in for them.
4. **Never start the server from here.** A server launched by the coding agent dies with its session. If a restart is needed (new routes, `lib/`, collectors), tell the user to run `npm start` in their own terminal (its `prestart` stops the old one), then confirm `curl -s localhost:4173/api/state` answers. Frontend-only entries need only a reload.
5. **Run `npm test`.** If it fails, report the failure; do not write the marker.
6. **Write the newest applied number** into `.plate-changelog-seen`, only after steps 3–5 succeeded.
7. **Report** in a short list: entries applied, keys written, and what stays the user's (logins, values they did not give).
