# OpenLatex — Plan

Fork of Overleaf Community Edition (`overleaf/overleaf` → `mytricker0/OpenLatex`, synced, 0 behind upstream as of 2026-06-11). Goal: a free hosted collaborative LaTeX editor — real-time collaboration for up to **100 collaborators per project**, rebranded and redesigned, sustainably hosted.

---

## 0. Assumptions (stated up front)

- Solo developer, single VPS (the one currently running nginx-proxy-manager + docker, `npm-network`), budget ~€20–50/mo.
- Target users: students and academics, primarily EU.
- "Good enough" redesign = new brand, colors, typography, landing page — **not** a rewrite of the editor UI.
- The previous self-hosted Overleaf instance (overleaf.xyonium.com) was decommissioned on 2026-06-11; OpenLatex is a fresh deployment.

---

## 1. License compliance (AGPL-3.0) — non-negotiable, do first

The repo is AGPL-3.0. Consequences, verified against `LICENSE`:

| Obligation | What we do |
|---|---|
| §13 network clause: users of the hosted service must be offered the Corresponding Source | Footer "Source code" link on every page → `github.com/mytricker0/OpenLatex`. Fork stays public. **All modifications are pushed to the public fork before (or with) each deploy.** |
| Preserve copyright + license notices | Keep `LICENSE`, all file headers, original copyright lines. Add our own copyright line alongside, never replacing. |
| Trademark NOT granted by AGPL | Remove every user-facing use of the "Overleaf" name and logo (`doc/logo.png`, pug views, `appName`). Internal code identifiers (`OVERLEAF_*` env vars, module names) may stay — they are not trademark use in commerce. |
| Trade dress (look-and-feel) | The visual identity must not be confusable with Overleaf's: no Overleaf green (`#138A07` family), different logo shape, different landing page layout and copy. Our flat blue/orange system (§4) is deliberately distant. Attribution stays factual ("based on Overleaf CE source, AGPL-3.0") — nominative use, not branding. |
| Charging is allowed | Monetization per §6 below is fully AGPL-compatible (we sell hosting/operations, not code). |

**Verify:** every page footer shows the source link; `grep -ri "overleaf" services/web/app/views` returns no user-visible brand strings (env-var names and code identifiers excluded).

---

## 2. Rebrand to OpenLatex

Smallest set of changes (surgical — touch only branding):

1. `APP_NAME=OpenLatex` env var — already wired at `services/web/config/settings.defaults.js:814` (`appName`) and `:822` (`title`). Most of the rebrand is **one env var**.
2. New logo (SVG, flat style per §4) replacing `doc/logo.png` and the header/nav logo assets in `services/web/public/` + relevant pug mixins.
3. README: replace Overleaf banner/link, describe OpenLatex, keep "fork of Overleaf CE, AGPL-3.0" attribution (honest and required).
4. Strip/replace Overleaf-branded strings in user-facing pug views (`services/web/app/views/`) — notably the subscriptions/plans pages, which we replace wholesale anyway (§6).
5. Favicon + OG meta images.

**Verify:** load site, check title bar, nav, login page, emails (`OVERLEAF_APP_NAME` analog) all say OpenLatex; no Overleaf logo renders anywhere.

---

## 3. 100-collaborator limit

Current default is **unlimited**: `services/web/config/settings.defaults.js:416` → `defaultFeatures.collaborators: -1`.

1. Change to `collaborators: 100`.
2. Enforcement already exists upstream: `services/web/app/src/Features/Subscription/LimitationsManager.mjs` reads `user.features.collaborators` (falls back to `Settings.defaultFeatures.collaborators`) and gates invites. No new enforcement code needed — this is a config change riding existing logic.
3. UI copy: invite modal should say "Up to 100 collaborators per project — free" (turn the limit into marketing).

**Verify:** integration test — project with 100 accepted collaborators rejects invite #101 with the existing limit error; invite #100 succeeds.

> Note: real-time performance with ~100 concurrent editors in one document is untested upstream at this scale. The limit is a *membership* cap, not a concurrency promise. Add to README FAQ.

---

## 4. Design ("good enough" pass)

Design system (generated via ui-ux-pro-max for "collaborative latex editor academic saas"):

- **Style:** Flat design — 2D, no shadows/gradients, typography-focused, WCAG AAA-friendly. Fits an academic tool and is the cheapest style to retrofit onto Overleaf's existing CSS.
- **Palette:** Primary `#3B82F6`, Secondary `#60A5FA`, CTA `#F97316`, Background `#F8FAFC`, Text `#1E293B`.
- **Typography:** Plus Jakarta Sans (headings + body), weights 300–700, via Google Fonts.
- **Effects:** color/opacity hovers only, 150–200ms ease transitions, SVG icons (no emoji icons).

Scope (in order, stop when "good enough"):

1. **Design tokens:** override brand colors + font in `services/web/frontend/stylesheets/` (`foundations/`, `ds/` directories hold the variables). One token pass recolors the whole app.
2. **Landing page:** new hero per recommended pattern (Hero > Features > CTA, CTA above fold): "Write LaTeX together. Up to 100 collaborators. Free." + screenshot/demo.
3. **Project dashboard:** recolor + spacing polish only.
4. **Editor:** untouched except token-driven recoloring. Do not redesign the editor.

Checklist before calling it done: text contrast ≥ 4.5:1, visible focus states, `cursor-pointer` on clickables, `prefers-reduced-motion` respected, responsive at 375/768/1024/1440px.

**Verify:** screenshot pass at all four widths; axe/Lighthouse accessibility ≥ 95 on landing + dashboard.

---

## 5. Hosting

Reuse the decommissioned Overleaf stack's shape (compose: sharelatex + mongo 6 (replSet) + redis 6.2, `npm-network` external, texlive volume), built from this fork instead of the stock image:

1. `docker build` from `server-ce/Dockerfile` (tag `openlatex:latest`).
2. Compose at `Services/OpenLatex/deploy/docker-compose.yml`: `openlatex` + `mongo:6.0 --replSet` + `redis:6.2`, internal network + `npm-network`, bind mounts under `Services/OpenLatex/data/`.
3. nginx-proxy-manager: new proxy host + Let's Encrypt cert for **openlatex.dev** (domain owned).
4. Compile safety on a shared box: keep default `compileTimeout: 180` initially (settings.defaults.js:420), `--no-shell-escape` (CE default), container CPU/memory limits in compose. Revisit timeout if CPU contention appears.

### 5b. Goal: Sandboxed Compiles (Server Pro parity)

CE compiles run inside the main container via `LocalCommandRunner` — a compiling user has read/write access to the container (upstream README caution). Server Pro fixes this with per-compile sibling Docker containers; the implementation (`services/clsi/app/js/DockerRunner.js`) is **not in the open repo** — but its full unit test is (`services/clsi/test/unit/js/DockerRunner.test.js`). That test is our interface spec.

**Status: clean-room implementation DONE and unit-test-validated** (commit `c92c48b30c`, branch `openlatex-setup`). `services/clsi/app/js/DockerRunner.js` (654 lines) + `services/clsi/seccomp/clsi-profile.json` (1024 lines) written from scratch against the test spec. **All 64 DockerRunner unit tests pass** (vitest), including the `security hardening` block: network disabled, all caps dropped, seccomp + apparmor applied, no CLSI env leak, memory/pids/cpu caps, read-only compile mount.

What is built (verified in source):
1. ✅ `DockerRunner.js` — each compile runs in a fresh container via dockerode: `NetworkDisabled: true`, `CapDrop: ['ALL']`, `Memory: 1 GB`, `PidsLimit: 4096`, configurable non-root `User`, compile dir mounted read-only for synctex/wordcount, timeout kill + old-container reaper.
2. ✅ `CommandRunner.js:12` switches on `Settings.clsi.dockerRunner === true`; clsi `settings.defaults.cjs:122` sets it from `DOCKER_RUNNER || SANDBOXED_COMPILES === 'true'`. Production `docker-compose.yml:82` sets `SANDBOXED_COMPILES: "true"`.

What remains before public multi-tenant launch:
3. ⚠️ **Socket hardening NOT done.** Root `docker-compose.yml:22` still mounts the **raw** `/var/run/docker.sock` into the app container. Replace with a socket proxy (`tecnativa/docker-socket-proxy`) on the internal network allowing only container create/start/wait/stop/remove + image inspect, denying exec/volumes/swarm/host config.
4. ⚠️ TexLive image: pin `texlive/texlive` to a digest; confirm `--read-only` rootfs end-to-end (compile dir is already the only writable mount).
5. ⚠️ **Image rebuild required.** The current local clsi image was built from `main` (no `DockerRunner.js`); the running container only picks it up via the dev bind-mount. Any deploy must `docker build` clsi from this branch, else sandboxing silently falls back to `LocalCommandRunner`.
6. ⚠️ Dev stack runs unsandboxed by design (`develop/docker-compose.yml` sets `SANDBOXED_COMPILES=false`). To exercise the sandbox locally: flip it true, provide a texlive image, mount the socket (proxy preferred).

Acceptance: DockerRunner unit test passes (**done — 64/64**); a malicious `\write18`/large-file/fork-bomb project cannot touch the app container or other projects' files (**still to run as a live end-to-end test**).

Until socket hardening (item 3) ships: public registration stays invite-only (the compose hardening contains damage to the app container, but multi-tenant isolation is not real without the socket proxy).

> Overleaf's wiki labels sandboxed compiles a Server Pro *feature*, but the AGPL repo legally permits us to build the same capability ourselves. We only may not copy their proprietary module or call it by their product names.
5. Backups: nightly `mongodump` + tar of data dirs to off-box storage. **This holds people's theses — backups before launch, not after.**

**Verify:** register, create project, invite second account, compile PDF, both users edit live; restore a backup into a scratch stack once.

---

## 6. Monetization — council decision

Three-member council convened (ads advocate, non-ad advocate, skeptic judge). Unanimous direction:

**Verdict: NO ads. Donations + cost transparency now; compute-gated soft freemium and lab/institutional support later.**

Why ads lost (the ads advocate's own numbers): an editor SPA generates ~2–4 ad impressions/session vs. a content site's dozens; STEM audience adblock 40–60%; AdSense likely rejects login-walled apps; EthicalAds/Carbon require 10–50k+ pageviews/mo; GDPR consent banner undermines the privacy pitch; AGPL means an ad-free clone is one `docker compose up` away. Realistic ceiling ≈ €10–60/mo at 1,000 MAU — at or below the VPS bill, paid for in trust. Ads advocate's own confidence ads sustain hosting: **3/10**. Judge ruled ads out everywhere, including the dashboard.

**Phase 1 (launch, ~2 days of work):**
- GitHub Sponsors (0% fees) + Liberapay links.
- Public cost-transparency bar on the dashboard: "Server: €34/mo — 71% funded." (Doubles donation conversion vs. a passive link; trust-positive for academics who fund Wikipedia/arXiv.)
- Supporter badge + priority compile queue for any donor.
- `mailto:` line: "Want a managed OpenLatex instance for your lab? →"

**Phase 2 (only after ~1,000 active users or donations > €100/mo):**
- €2.99/mo supporter tier via Merchant of Record (Paddle/Lemon Squeezy — handles EU VAT). Gates **compute only**: longer compile timeout (e.g. 60s free / 180s paid), priority queue, version-history depth, storage quota. The per-user `features` object already exists — days of work, not weeks.
- Managed instances for labs/research groups at €30–80/mo (the canonical AGPL business model; one lab ≈ 40 donors). Cap at ~5 instances.

**Forbidden, permanently:**
1. Ads anywhere; third-party tracking scripts anywhere.
2. Paywalling collaborator count, export, or compile correctness — the 100-free-collaborators promise is the entire reason to choose OpenLatex over Overleaf's 1-collaborator free tier. Sell speed and convenience, never collaboration.
3. Selling user data; donation nags inside the editor (one dismissible dashboard footer max).

Council confidence the model covers ~€50/mo hosting: **8/10**, conditional on reaching ~1,000 active users; below ~500 actives the bill comes out of pocket (which is fine — it's ~€25/mo).

---

## 7. Execution order

| # | Step | Verify |
|---|---|---|
| 1 | License pass: footer source link, trademark strip audit | grep audit + visual check |
| 2 | Rebrand: APP_NAME, logo, README, views | All surfaces say OpenLatex |
| 3 | `collaborators: 100` config + invite-modal copy | Invite #101 rejected in test |
| 4 | Design tokens + landing page | Contrast/responsive/a11y checklist |
| 5 | Deploy: build, compose, NPM proxy host, backups | End-to-end 2-user collab compile + backup restore drill |
| 6 | Monetization phase 1 (sponsors links + transparency bar) | Links live, bar renders |
| 7 | Push everything to public fork, tag `v0.1` | §13 compliance: deployed code == public code |

Steps 1–3 are config/asset changes (days). Step 4 is the bulk of the work. Steps 5–6 reuse known infra. Nothing speculative beyond this list.
