<h1 align="center">
  <br>
  <a href="https://openlatex.dev"><img src="doc/logo.png" alt="OpenLatex" width="300"></a>
</h1>

<h4 align="center">A free, open-source online real-time collaborative LaTeX editor — up to 100 collaborators per project.</h4>

<p align="center">
  <a href="https://openlatex.dev">openlatex.dev</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#authors">Authors</a> •
  <a href="#license">License</a>
</p>

## OpenLatex

OpenLatex is a free hosted collaborative LaTeX editor at [openlatex.dev](https://openlatex.dev): real-time collaboration with up to **100 collaborators per project**, no paywall on collaboration, no ads, no trackers.

OpenLatex is based on the source code of [Overleaf Community Edition](https://github.com/overleaf/overleaf) (AGPL-3.0). It is an independent project and is not affiliated with or endorsed by Overleaf or Digital Science. In accordance with AGPL-3.0 §13, the complete source of the hosted service is this repository.

> [!CAUTION]
> Overleaf Community Edition is intended for use in environments where **all** users are trusted. Community Edition is **not** appropriate for scenarios where isolation of users is required due to Sandbox Compiles not being available. When not using Sandboxed Compiles, users have full read and write access to the `sharelatex` container resources (filesystem, network, environment variables) when running LaTeX compiles.

For more information on Sandbox Compiles check out our [documentation](https://docs.overleaf.com/on-premises/configuration/overleaf-toolkit/server-pro-only-configuration/sandboxed-compiles).

## Features

- Real-time collaborative editing — **up to 100 collaborators per project, free**
- Full TeX Live distribution, PDF preview, project history
- No ads, no third-party trackers, EU-hosted
- Open source (AGPL-3.0): the code running at openlatex.dev is exactly this repository

## Roadmap

- **Sandboxed compiles** — per-compile isolated Docker containers (network-disabled, resource-capped), replacing the Community Edition model where compiles run inside the app container. See `plan.md` §5b. Until this ships, registration on the hosted instance is invite-only.
- Redesigned landing page and project dashboard
- Donation-backed hosting with public cost transparency (no ads, ever — see `plan.md` §6)

## Running it yourself (production)

Requirements: docker + docker compose v2, a reverse proxy (we use nginx-proxy-manager on an external docker network named `npm-network`).

```shell
git clone https://github.com/mytricker0/OpenLatex.git
cd OpenLatex/deploy
docker compose build openlatex   # heavy: pulls TeX Live base image
docker compose up -d
```

The web container exposes port 80 **only** on `npm-network` — point your reverse proxy at `openlatex:80` and terminate TLS there. Data lives in `./data/` (bind mounts for app data, mongo, redis). First account: open `https://your-domain/launchpad` to create the admin user.

Hardening applied out of the box: no published host ports, mongo/redis on an internal-only network, `no-new-privileges`, CPU/memory limits, no docker socket in any app container. Read the caution below before opening registration to strangers.

> [!CAUTION]
> Like upstream Overleaf Community Edition, compiles are **not yet sandboxed**: a user running a compile has read/write access to the resources of the `openlatex` container (filesystem, network, environment). Keep registration restricted to users you trust until the sandboxed-compiles roadmap item lands.

## Local development

The `develop/` directory contains a hot-reloading dev environment for all services:

```shell
cd develop
bin/build        # build all service images (set COMPOSE_PARALLEL_LIMIT=1 in develop/.env if RAM-constrained)
bin/up           # start everything
```

Then open <http://localhost/launchpad> to create the first admin account.

For iterating on code, use development mode instead — services restart automatically on change via `node --watch`:

```shell
bin/dev                  # all services
bin/dev web webpack      # or just the ones you're touching (webpack needed for frontend changes)
```

Debugger ports are exposed per service (`web` 9229, `clsi` 9230, `real-time` 9237, …) — full table in [`develop/README.md`](develop/README.md), attachable from Chrome DevTools (`chrome://inspect`) or any IDE.

Deploys to production happen automatically: every push to `main` triggers the GitHub Actions workflow in [`.github/workflows/deploy-openlatex.yml`](.github/workflows/deploy-openlatex.yml), which builds and restarts the stack on the server. Develop on a branch; merging to `main` ships.

## Docker images

Two dockerfiles: [`server-ce/Dockerfile-base`](server-ce/Dockerfile-base) builds the heavy base (TeX Live + system deps); [`server-ce/Dockerfile`](server-ce/Dockerfile) layers the application services on top. The production compose file builds the latter directly, pulling the published base image. `make build-base && make build-community` from `server-ce/` builds both locally.

## Contributing

Please see the [CONTRIBUTING](CONTRIBUTING.md) file for information on contributing.

## Authors

OpenLatex is maintained by [mytricker0](https://github.com/mytricker0).

The underlying editor is the work of [the Overleaf Team](https://github.com/overleaf/overleaf) and its contributors — thank you.

## License

The code in this repository is released under the GNU AFFERO GENERAL PUBLIC LICENSE, version 3. A copy can be found in the [`LICENSE`](LICENSE) file.

Copyright (c) Overleaf, 2014-2025. OpenLatex modifications copyright (c) the OpenLatex contributors, 2026.
