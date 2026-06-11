#!/usr/bin/env bash
# Server-side deploy: build the image from the current checkout and restart
# the stack. Run from the repo root (CI does: git reset --hard origin/main
# && bash deploy/deploy.sh).
set -euo pipefail

cd "$(dirname "$0")"

# The upstream Makefile copies this into the build context root; without it
# the ~300MB .git directory and data/ get sent to the docker daemon.
cp ../server-ce/.dockerignore ..

docker compose build openlatex
docker compose up -d --remove-orphans

# Wait for the web container to answer before declaring success.
for i in $(seq 1 60); do
    if docker exec openlatex curl -sf http://localhost/status > /dev/null 2>&1; then
        echo "OpenLatex is up."
        exit 0
    fi
    sleep 5
done
echo "OpenLatex did not become healthy within 5 minutes." >&2
docker compose logs --tail 50 openlatex >&2
exit 1
