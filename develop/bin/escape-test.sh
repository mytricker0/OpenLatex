#!/usr/bin/env bash
# Live containment test for sandboxed compiles under gVisor.
# Run AFTER gVisor is installed and clsi is up with the sandbox overlay.
#   bash develop/bin/escape-test.sh
set -uo pipefail
cd "$(dirname "$0")/.." # develop/

pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; FAILED=1; }
FAILED=0

echo "=================================================================="
echo " 1. gVisor runtime actually intercepts the kernel"
echo "=================================================================="
# Inside gVisor, dmesg prints the gVisor banner instead of the host kernel.
DMESG="$(docker run --runtime=runsc --rm alpine dmesg 2>/dev/null | head -1)"
echo "  guest dmesg: ${DMESG:-<empty>}"
echo "$DMESG" | grep -qi 'gvisor\|Starting gVisor' \
  && pass "compile runtime is gVisor, not the host kernel" \
  || fail "gVisor banner not seen — containers may be on runc"

echo "=================================================================="
echo " 2. Plant a host secret OUTSIDE the mounted compile dirs"
echo "=================================================================="
SENTINEL="/tmp/openlatex_host_secret_$$"
echo "TOP-SECRET-HOST-FILE-$$" | sudo tee "$SENTINEL" >/dev/null 2>&1 \
  || echo "TOP-SECRET-HOST-FILE-$$" > "$SENTINEL"
echo "  planted $SENTINEL"

echo "=================================================================="
echo " 3. Submit a malicious LaTeX project to clsi (sandboxed path)"
echo "=================================================================="
PROJ="escapetest$$"
# Hostile document: tries shell-escape RCE, host-file read, and a fork attempt.
read -r -d '' TEX <<'LATEX'
\documentclass{article}
\begin{document}
Attempting escape.
\immediate\write18{id > /compile/leak_id.txt}
\immediate\write18{cat /etc/shadow > /compile/leak_shadow.txt}
\immediate\write18{cat HOST_SENTINEL > /compile/leak_secret.txt}
\IfFileExists{/etc/hostname}{\input{/etc/hostname}}{no-host-file}
\end{document}
LATEX
TEX="${TEX/HOST_SENTINEL/$SENTINEL}"

# JSON-encode the body safely with python
BODY="$(python3 - "$TEX" <<'PY'
import json,sys
tex=sys.argv[1]
print(json.dumps({"compile":{"options":{"compiler":"pdflatex","timeout":60},
  "resources":[{"path":"main.tex","content":tex}]}}))
PY
)"

docker compose exec -T clsi sh -c "curl -s -m60 -X POST http://localhost:3013/project/$PROJ/compile \
  -H 'Content-Type: application/json' -d '$BODY'" >/tmp/escape_resp.json 2>&1
echo "  compile status: $(python3 -c 'import json;print(json.load(open("/tmp/escape_resp.json"))["compile"]["status"])' 2>/dev/null || echo '?')"

echo "=================================================================="
echo " 4. Inspect the per-compile container's security config"
echo "=================================================================="
CID="$(docker ps -a --filter "name=project-$PROJ" --format '{{.Names}}' | head -1)"
if [ -z "$CID" ]; then
  fail "no compile container found (name project-$PROJ-*) — cannot inspect"
else
  echo "  container: $CID"
  RUNTIME=$(docker inspect -f '{{.HostConfig.Runtime}}' "$CID")
  NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CID")
  ROFS=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$CID")
  CAPS=$(docker inspect -f '{{.HostConfig.CapDrop}}' "$CID")
  USER=$(docker inspect -f '{{.Config.User}}' "$CID")
  MOUNTS=$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$CID")
  echo "  Runtime=$RUNTIME NetworkMode=$NET ReadonlyRootfs=$ROFS CapDrop=$CAPS User=$USER"
  echo "  Mounts=$MOUNTS"
  [ "$RUNTIME" = "runsc" ] && pass "runs under gVisor"            || fail "runtime is '$RUNTIME', expected runsc"
  [ "$NET" = "none" ]      && pass "network disabled"             || fail "network is '$NET'"
  [ "$ROFS" = "true" ]     && pass "read-only rootfs"             || fail "rootfs not read-only"
  echo "$CAPS" | grep -q ALL && pass "all capabilities dropped"   || fail "CapDrop=$CAPS"
  { [ -n "$USER" ] && [ "$USER" != "0" ] && [ "$USER" != "root" ]; } \
    && pass "runs as non-root (uid/user '$USER')" || fail "runs as root ('$USER')"
  echo "$MOUNTS" | grep -qx "/compile " 2>/dev/null
  [ "$(echo $MOUNTS | tr -s ' ')" = "/compile" ] && pass "only /compile mounted (no host fs)" || echo "  [info] mounts: $MOUNTS"
fi

echo "=================================================================="
echo " 5. Did any escape actually succeed?"
echo "=================================================================="
CDIR="compiles/${PROJ}-"*
shopt -s nullglob
for f in $CDIR/leak_id.txt $CDIR/leak_shadow.txt $CDIR/leak_secret.txt; do
  if [ -s "$f" ]; then fail "EXFIL: $f = $(cat "$f" | head -c 60)"; fi
done
[ "$FAILED" = 0 ] && pass "no shell-escape exfil files were produced (restricted \\write18 held)" || true

echo "  clsi log (shell-escape handling):"
docker compose logs --tail=200 clsi 2>/dev/null | grep -iE "runaway|shell.escape|write18|restricted|not allowed" | tail -3 | sed 's/^/    /' || true

echo "=================================================================="
rm -f "$SENTINEL" 2>/dev/null || sudo rm -f "$SENTINEL" 2>/dev/null
if [ "$FAILED" = 0 ]; then
  echo " RESULT: CONTAINED — all checks passed."
else
  echo " RESULT: ATTENTION — one or more checks FAILED (see above)."
fi
echo "=================================================================="
exit $FAILED
