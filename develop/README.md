# Overleaf Community Edition, development environment

## Building and running

In this `develop` directory, build the services:

```shell
bin/build
```

> [!NOTE]
> If Docker is running out of RAM while building the services in parallel, create a `.env` file in this directory containing `COMPOSE_PARALLEL_LIMIT=1`.

Then start the services:

```shell
bin/up
```

Once the services are running, open <http://127.0.0.1/launchpad> to create the first admin account.

> [!NOTE]
> Use `127.0.0.1` rather than `localhost`: on some machines `localhost` resolves to
> IPv6 `::1`, while the dev server only binds IPv4, resulting in proxy errors.

> [!NOTE]
> The password may not contain any part of the email address — e.g. with
> `test@test.test`, any password containing `test` is rejected.

### MongoDB version

`docker-compose.yml` pins `mongo:7`. `mongo:8` segfaults (exit 139, ~30 seconds after
start, even with a clean data volume) on some hosts. If you change the major version,
wipe the `develop_mongo-data` volume first — MongoDB cannot downgrade data files.

## Development

To avoid running `bin/build && bin/up` after every code change, you can run Overleaf
Community Edition in _development mode_, where services will automatically update on code changes.

To do this, use the included `bin/dev` script:

```shell
bin/dev
```

This will start all services using `node --watch`, which will automatically monitor the code and restart the services as necessary.

To improve performance, you can start only a subset of the services in development mode by providing a space-separated list to the `bin/dev` script:

```shell
bin/dev [service1] [service2] ... [serviceN]
```

> [!NOTE]
> Starting the `web` service in _development mode_ will only update the `web`
> service when backend code changes. In order to automatically update frontend
> code as well, make sure to start the `webpack` service in _development mode_
> as well.

If no services are named, all services will start in development mode.

> [!WARNING]
> `bin/dev` passes `--no-deps` to docker compose: naming services (e.g.
> `bin/dev web webpack`) will **not** start mongo, redis, or the other services. Run
> `bin/up` first to bring up the full stack, then use `bin/dev <services>` to switch
> the ones you are working on into watch mode. If `web` logs
> `getaddrinfo ENOTFOUND redis`, this is why.

Container names follow the compose pattern `develop-<service>-1`
(e.g. `docker logs -f develop-webpack-1`), or use `bin/logs <service>`.

## Admin user management (CLI)

Create an admin user — or generate a fresh one-time password-set URL for an existing
user (this doubles as a command-line password reset, since the dev environment has no
SMTP configured):

```shell
docker compose exec web node modules/server-ce-scripts/scripts/create-user.mjs --admin --email=you@example.com
```

This prints a URL such as `http://localhost/user/activate?token=...` — open it
(swapping the host for `127.0.0.1` if needed) to set the password.

## Debugging

When run in _development mode_ most services expose a debugging port to which
you can attach a debugger such as
[the inspector in Chrome's Dev Tools](chrome://inspect/) or one integrated into
an IDE. The following table shows the port exposed on the **host machine** for
each service:

| Service            | Port |
| ------------------ | ---- |
| `web`              | 9229 |
| `clsi`             | 9230 |
| `chat`             | 9231 |
| `docstore`         | 9233 |
| `document-updater` | 9234 |
| `filestore`        | 9235 |
| `notifications`    | 9236 |
| `real-time`        | 9237 |
| `history-v1`       | 9239 |
| `project-history`  | 9240 |

To attach to a service using Chrome's _remote debugging_, go to
<chrome://inspect/> and make sure _Discover network targets_ is checked. Next
click _Configure..._ and add an entry `localhost:[service port]` for each of the
services you want to attach a debugger to.

After adding an entry, the service will show up as a _Remote Target_ that you
can inspect and debug.
