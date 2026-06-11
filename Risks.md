# Security Risks & Mitigations — Sandboxed Compiles

Status notes for the sandboxed-compiles implementation (`services/clsi/app/js/DockerRunner.js`).
Last reviewed: 2026-06-11.

## Threat model

LaTeX compiles execute arbitrary user-controlled code (shell-escape, Lua, `\write18`).
Before sandboxed compiles, a compile ran directly inside the app container with full
read/write access to its filesystem, network and environment — including other users'
projects and service credentials. With `SANDBOXED_COMPILES=true`, each compile runs in
its own short-lived Docker sibling container.

## Containment applied per compile container

| Control | Value | Purpose |
|---|---|---|
| `NetworkMode: none` + `NetworkDisabled` | no network | blocks exfiltration, SSRF against internal services (mongo, redis, web) |
| `CapDrop: ALL` | no capabilities | no raw sockets, no mknod, no chown, etc. |
| `SecurityOpt: no-new-privileges` | no setuid escalation | suid binaries in the image are inert |
| seccomp profile (`services/clsi/seccomp/clsi-profile.json`) | default-deny allowlist, 201 syscalls | blocks `mount`, `ptrace`, `bpf`, `kexec`, all socket syscalls, etc. |
| `User: tex` | non-root | container processes are unprivileged |
| `Memory: 1 GiB` | hard cap | contains memory bombs |
| `PidsLimit: 4096` | hard cap | contains fork bombs |
| `Ulimits cpu: timeout+5/+10 s` | hard cap | backstop if the wait-timeout kill fails |
| `Init: true` | pid 1 reaper | no zombie accumulation |
| `LogConfig: none` | no log driver | no disk exhaustion via container logs |
| read-only `/compile` bind for synctex/wordcount/synctex-output | least privilege | read-type operations cannot modify project files |
| env isolation | settings + request env only | CLSI `process.env` (credentials) never enters the container (unit-tested) |
| container monitor | destroys project containers idle > 1 h | bounds stale-container accumulation |

## Input validation (audited 2026-06-11)

- `project_id`: regex `^[a-zA-Z0-9_-]+$` enforced at `services/clsi/app.js:50` —
  safe for container names and path-basename volume rewrites.
- `user_id`: 24-hex enforced at `services/clsi/app.js:58`.
- `imageName`: allowlist-checked in RequestParser, CompileManager and DockerRunner
  (see residual risk 1).
- `environment`: constructed server-side only (`CompileManager.js`); user input
  cannot define env keys.
- `cwd`: server-generated UUID today; DockerRunner additionally rejects any cwd
  resolving outside `/compile` (path-traversal guard, unit-tested).

## Residual risks

1. **`ALLOWED_IMAGES` unset by default.** The image allowlist at all three layers
   only enforces when `ALLOWED_IMAGES` is configured. The CLSI API is
   internal-only, but defense in depth says set
   `ALLOWED_IMAGES=<your texlive image>` in the deployment environment.

2. **Docker socket mounted into the app container** (required for sibling
   containers). A full compromise of the app container is root-equivalent on the
   host via the socket. Inherent to the sibling-container architecture (upstream
   Server Pro has the same property). Mitigations, strongest first:
   - run compile containers under gVisor: `DOCKER_RUNTIME=runsc`;
   - put a socket-filtering proxy (e.g. docker-socket-proxy) between the app
     container and the daemon, allowing only the container/exec endpoints CLSI uses;
   - keep the host single-purpose so socket compromise has limited blast radius.

3. **Seccomp profile maintenance.** Profile is a default-deny allowlist
   (Overleaf's original production profile plus 37 syscalls required by modern
   glibc/TeXLive 2022+: `clone3`, `rseq`, `statx`, `getrandom`, …). Future TeXLive
   or base-image updates may need new syscalls; symptom is compiles failing with
   `EPERM` on container start or inside latexmk. All names validated against
   kernel headers; the legacy `pread` entry is inherited from upstream and ignored
   by runc.

4. **Shared kernel.** Containers are not VMs; a kernel exploit reachable through
   the allowed syscall surface escapes the sandbox. Keep the host kernel patched;
   gVisor (risk 2) also mitigates this.

5. **Compile/output host-dir coupling.** `SANDBOXED_COMPILES_HOST_DIR_COMPILES`/
   `_OUTPUT` must match the host-side paths of the data volume in
   `docker-compose.yml`; a mismatch silently produces empty bind mounts (compiles
   fail, no data exposure).

## Out of scope / pre-existing

- Community-mode (`SANDBOXED_COMPILES=false`, `LocalCommandRunner`) remains
  unsandboxed by design — trusted-user environments only.
- `test/unit/js/ContentCacheManager.test.js` fails outside the dev container
  (`mkdir '/overleaf'` at filesystem root) — environmental, unrelated.
