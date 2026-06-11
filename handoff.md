# Handoff — dev environment session, 2026-06-11

State of the `develop/` environment after today's debugging session, including one
**open bug** (project creation fails). Written so the next session can pick up without
re-deriving anything.

## Open bug: project creation fails (infinite loading → 500)

**Symptom:** On http://127.0.0.1/project, "New project" spins forever, then
`POST /project/new` returns **500 after ~30s** (client sees infinite loading because the
frontend doesn't surface the error).

**Where it fails** (from `web` logs, 2026-06-11 17:30 UTC):

```
RequestFailedError: request failed
  at Object.initializeProject (app/src/Features/History/HistoryManager.mjs:52)
  at _createBlankProject (app/src/Features/Project/ProjectCreationHandler.mjs:251)
info: { url: 'http://project-history:3054/project', method: 'POST', status: 500 }
responseTimeMs: 30051
```

`web` → `project-history` `POST /project` (history initialization for the new project)
returns 500 after a 30s timeout. The mongo write part of project creation is fine — the
failure is downstream in the history chain (`project-history`, possibly `history-v1`
behind it).

**Most likely cause:** earlier today the mongo container was replaced and its data volume
wiped (see "mongo:8 segfault" below). `web` was restarted afterwards, but
`project-history`, `history-v1`, `docstore`, `filestore`, etc. were **not** — they have
been up since before the wipe and hold dead/stale mongo connections (also seen:
`notifications` timing out with `AbortError` from `web`).

**First thing to try next session:**

```bash
cd develop
docker compose restart   # or: bin/up (recreates changed containers)
```

Then retry project creation. If it still 500s, look at the actual error inside
project-history:

```bash
rtk proxy docker logs develop-project-history-1 --since 10m | grep -E '"level":(50|60)'
rtk proxy docker logs develop-history-v1-1 --since 10m | grep -E '"level":(50|60)'
```

Note `history-v1` also uses Postgres-style migrations via knex and has its own mongo
usage — if its state referenced the wiped DB (e.g. history chains for deleted projects),
errors will show up there.

## Fixed today

### 1. mongo:8 segfaults on this host → pinned to mongo:7

`mongo:8` crashes with exit 139 (SIGSEGV) ~30s after every start on this machine
(kernel 7.0.0-22-generic). Reproduced with a **clean volume and throwaway container**, so
it is host↔image incompatibility, not data corruption. AVX present, not the AVX issue.
No error is logged — the process just dies. `mongo:7` runs stable.

- `develop/docker-compose.yml` now pins `image: mongo:7` (with comment).
- The old `develop_mongo-data` volume (written by mongo 8, unreadable by 7) was removed
  and recreated empty. **All local dev data was wiped** — admin account must be
  re-created via http://127.0.0.1/launchpad.

### 2. `create-user.mjs` hung forever — mongodb callback API removed

`services/web/modules/server-ce-scripts/scripts/create-user.mjs` called
`db.users.updateOne(filter, update, callback)`. The callback API was removed in mongodb
driver v5; this repo has **6.12.0**, so the callback never fired and the script hung
after doing its work. Rewritten to async/await (`UserRegistrationHandler.promises`).
Upstream Overleaf bug — candidate for an upstream PR.

Usage (admin create *and* password reset — for an existing user it issues a fresh
one-time URL):

```bash
cd develop
docker compose exec web node modules/server-ce-scripts/scripts/create-user.mjs \
  --admin --email=you@example.com
# prints: http://localhost/user/activate?token=...   (swap host for 127.0.0.1)
```

## Gotchas learned today (also added to develop/README.md)

- **`bin/dev` uses `--no-deps`**: `bin/dev web webpack` does NOT start mongo/redis/the
  rest. Run `bin/up` first to bring up the full stack, then `bin/dev <services>` to
  switch those to watch mode. Otherwise `web` crash-loops with
  `getaddrinfo ENOTFOUND redis`.
- **Use http://127.0.0.1/ not http://localhost/**: on this machine `localhost` resolves
  to IPv6 `::1`; the webpack dev server port only binds IPv4 → proxy errors.
- **Container names** are `develop-<service>-1` (e.g. `develop-webpack-1`), or just use
  `bin/logs <service>`.
- **Launchpad password rule**: password may not contain any part of the email address
  (with `test@test.test`, anything containing "test" is rejected as
  "password contains part of email address").
- **Frontend changes need no rebuild**: `frontend/` is bind-mounted into the `webpack`
  container; webpack-dev-server recompiles and hot-reloads. Image rebuild (`bin/build`)
  only needed for dependency/Dockerfile changes.
- Harmless noise: webpack warning `Can't resolve settings.webpack.js` (optional override
  file, only disables the persistent build cache) and the `util._extend` deprecation
  (from http-proxy-middleware).

## Not yet verified

The UI/UX changes pushed earlier today (commit `bbda9b8`: motion tokens, hover
transitions, resize-handle focus rings, thin scrollbars, leave-account form autofill)
compiled successfully in webpack but have **not** been visually verified in the browser —
the session got derailed by the mongo crash before reaching the editor.
