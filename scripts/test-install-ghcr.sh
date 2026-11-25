#!/usr/bin/env bash
# Usage: OPENVMS_E2E_ISOLATED=1 bash scripts/test-install-ghcr.sh /path/to/checkout
# Run next to a disposable Linux Docker daemon (same network and filesystem).
# In DinD, stage a standalone Git checkout with its .git directory inside DinD.
set +x
set -Eeuo pipefail
umask 077

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
trap 'printf "FAIL: integration check at line %d\n" "$LINENO" >&2' ERR
[[ $# == 1 ]] || fail "usage: $0 /path/to/checkout"
[[ ${OPENVMS_E2E_ISOLATED:-} == 1 ]] || fail 'set OPENVMS_E2E_ISOLATED=1 only on an isolated Docker daemon and network'
[[ $(uname -s) == Linux ]] || fail 'Linux is required'
for cmd in docker git ss timeout curl openssl python3; do
  command -v "$cmd" >/dev/null || fail "missing command: $cmd"
done
source_dir=$(cd -- "$1" && pwd -P)
[[ -e $source_dir/.git ]] || fail 'the source must be a Git checkout'

# Check the caller's Docker endpoint before replacing its client config.
export REAL_DOCKER
REAL_DOCKER=$(command -v docker)
docker_cmd() { timeout --kill-after=3s 20s "$REAL_DOCKER" "$@"; }
if [[ -n ${DOCKER_CONTEXT:-} || -z ${DOCKER_HOST:-} ]]; then
  endpoint=$(docker_cmd context inspect --format '{{.Endpoints.docker.Host}}')
else
  endpoint=$DOCKER_HOST
fi
[[ $endpoint == unix:///* && -S ${endpoint#unix://} ]] || fail 'a local Docker Unix socket is required'
containers=$(docker_cmd ps -aq)
[[ -z $containers ]] || fail 'refusing to test: the Docker daemon already has containers'
listeners=$(ss -H -ltnu)
for port in 7101 7102 55433 8554 8000 8001 8890 9997 8189; do
  if grep -Eq ":${port}([[:space:]]|$)" <<< "$listeners"; then
    fail "refusing to test: OpenVMS port $port is already in use"
  fi
done
images=$(docker_cmd image ls -aq)
[[ -z $images ]] || fail 'the Docker daemon must start with an empty image cache'

scratch=$(mktemp -d "${TMPDIR:-/tmp}/openvms-ghcr.XXXXXXXX")
cleanup_needed=0
teardown() { compose_cleanup down --volumes --remove-orphans --timeout 10; }
cleanup() {
  local rc=$?
  trap - EXIT
  if (( cleanup_needed )) && ! teardown; then rc=1; fi
  rm -rf -- "$scratch" || rc=1
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A fresh config isolates registry credentials, while keeping the checked socket.
unset "${!COMPOSE_@}" "${!OPENVMS_@}" "${!OVMS_@}" DOCKER_CONTEXT DOCKER_AUTH_CONFIG DOCKER_DEFAULT_PLATFORM
export DOCKER_HOST="$endpoint" DOCKER_CONFIG="$scratch/docker-config" XDG_STATE_HOME="$scratch/state"
export OPENVMS_VARIANT=cpu OPENVMS_PULL_TIMEOUT=600 OPENVMS_START_TIMEOUT=180 OPENVMS_HEALTH_TIMEOUT=120
mkdir -p -- "$DOCKER_CONFIG" "$scratch/bin"
printf '%s\n' '{"auths":{"ghcr.io":{}}}' > "$DOCKER_CONFIG/config.json"
docker_cmd compose version

# Trace only operation names/flags, never Docker arguments that can contain secrets.
# The active-install failure is the only intercepted command; all others exec Docker.
cat > "$scratch/bin/docker" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
case ${1:-} in
  compose)
    shift
    while (( $# )); do
      case $1 in
        -f|--file|-p|--project-name|--project-directory|--env-file|--profile|--progress) shift 2 ;;
        --*) shift ;;
        *) break ;;
      esac
    done
    operation=${1:-}
    if [[ $operation == up && " $* " == *' --no-build '* && " $* " != *' --build '* && \
          ( " $* " == *' --pull never '* || " $* " == *' --pull=never '* ) ]]; then
      operation='up pinned'
    fi
    printf '%s\n' "$operation" >> "$TRACE"
    if [[ $operation == pull && $INJECT_PULL_FAILURE == 1 ]]; then
      printf 'integration fixture: injected compose pull failure\n' >&2
      exit 71
    fi
    ;;
  build|buildx) printf '%s\n' build >> "$TRACE" ;;
esac
exec "$REAL_DOCKER" "${args[@]}"
WRAPPER
chmod +x "$scratch/bin/docker"

stage() {
  local file
  export OPENVMS_INSTALL_DIR="$scratch/$1" COMPOSE_PROJECT_NAME="openvms-ghcr-${scratch##*.}-$1"
  COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME,,}
  git -c safe.directory="$source_dir" clone --quiet --no-local -- "$source_dir" "$OPENVMS_INSTALL_DIR"
  git -C "$OPENVMS_INSTALL_DIR" remote set-url origin https://github.com/LeonardoDiasRR/open-vms.git
  # Copy the current installer inputs (including uncommitted changes), not any .env or local overrides.
  for file in install.sh docker-compose.yml deploy/images.env deploy/compose.ghcr.yml deploy/compose.nvidia.yml \
              deploy/mediamtx.yml deploy/nginx.conf conf/config.yaml; do
    cp -- "$source_dir/$file" "$OPENVMS_INSTALL_DIR/$file"
  done
  cd -- "$OPENVMS_INSTALL_DIR"
  [[ ! -e .env && ! -L .env ]] || fail 'the fixture checkout already has a .env'
}
compose_files=(-f docker-compose.yml -f deploy/compose.ghcr.yml)
compose() { OPENVMS_IMAGE="$image" docker_cmd compose "${compose_files[@]}" "$@"; }
compose_cleanup() {
  (cd -- "$OPENVMS_INSTALL_DIR" && OPENVMS_IMAGE="$image" \
    timeout --kill-after=3s 60s "$REAL_DOCKER" compose "${compose_files[@]}" "$@");
}
ref() { sed -n "s/^OPENVMS_IMAGE_$1=//p" deploy/images.env; }
run_installer() {
  TRACE="$scratch/trace" INJECT_PULL_FAILURE="$1" PATH="$scratch/bin:$PATH" bash ./install.sh
}
assert_trace() {
  local operations
  operations=$(grep -E '^(pull|up( pinned)?|build|down|rm|stop|restart|kill)$' "$scratch/trace")
  case "$1:$operations" in
    $'success:pull\nup pinned'|$'success:pull\npull\nup pinned'|failure:pull) ;;
    *) fail "unexpected installer Docker operations ($1): $operations" ;;
  esac
}

stage fresh
cpu=$(ref CPU)
gpu=$(ref GPU)
for ref_value in "$cpu" "$gpu"; do
  [[ $ref_value =~ ^ghcr\.io/leonardodiasrr/open-vms@sha256:[0-9a-f]{64}$ ]] || fail 'invalid release image reference'
done
for variant in cpu gpu; do
  image=$cpu
  extra=()
  if [[ $variant == gpu ]]; then image=$gpu; extra=(-f deploy/compose.nvidia.yml); fi
  compose "${extra[@]}" config --format json | python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
assert all(s.get("build") is None for s in services.values()), "unexpected build spec"
assert all(services[s]["image"] == sys.argv[1] for s in ("api", "dist")), "wrong release image"
reserved = {name: s["deploy"]["resources"]["reservations"]["devices"] for name, s in services.items()
            if s.get("deploy", {}).get("resources", {}).get("reservations", {}).get("devices")}
assert set(reserved) == ({"api"} if sys.argv[2] == "gpu" else set()), "unexpected device reservation"
if reserved:
    assert any(d["driver"] == "nvidia" and "gpu" in d["capabilities"] for d in reserved["api"])
' "$image" "$variant"
done

check_stack() {
  local expected_id id service
  expected_id=$(docker_cmd image inspect --format '{{.Id}}' "$cpu")
  for service in api dist; do
    id=$(compose ps -aq "$service")
    [[ -n $id ]] || fail "missing container for $service"
    [[ $(docker_cmd inspect --format '{{.Config.Image}} {{.Image}}' "$id") == "$cpu $expected_id" ]] || fail "wrong image for $service"
    if [[ $service == dist ]]; then
      [[ $(docker_cmd inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id") == 'exited 0' ]] || fail 'dist did not complete'
    else
      [[ $(docker_cmd inspect --format '{{.State.Health.Status}}' "$id") == healthy ]] || fail 'API is not healthy'
    fi
  done
}
http() { curl --noproxy '*' --fail --silent --show-error --max-time 10 "$@"; }
check_ui() {
  local prefix=$1 asset
  http -o /dev/null http://127.0.0.1:7101/api/v1/health
  http -o "$prefix.html" http://127.0.0.1:7102/
  asset=$(grep -oE 'src="/assets/[[:alnum:]_.-]+\.js"' "$prefix.html")
  asset=${asset#src=\"}; asset=${asset%\"}
  http -o "$prefix.js" "http://127.0.0.1:7102$asset"
  [[ -s $prefix.js ]] || fail 'empty JavaScript asset'
  compose exec -T web cat "/usr/share/nginx/html$asset" | cmp -s "$prefix.js" - || fail 'HTTP did not serve the published JavaScript asset'
}
pg() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -At -U postgres -d openvms "$@"; }
vault_key() { compose exec -T api cat /app/data/vault.key; }
check_fixture() {
  cmp -s .env "$scratch/env.before" || fail '.env changed'
  [[ $(stat -c %a .env) == 600 ]] || fail '.env permissions changed'
  cmp -s archive/recovery.fixture "$scratch/recording.before" || fail 'recording changed'
  compose exec -T api cat /mnt/archive/openvms/recovery.fixture | cmp -s "$scratch/recording.before" - || fail 'recording bind mount changed'
  [[ $(pg -c 'SELECT value FROM install_recovery;') == 'keep this row' ]] || fail 'PostgreSQL fixture changed'
  vault_key | cmp -s "$scratch/key.before" - || fail 'vault key changed'
}

printf '\n== Fresh CPU installation from an empty cache ==\n'
image=$cpu
cleanup_needed=1
: > "$scratch/trace"
run_installer 0
assert_trace success
check_stack
check_ui "$scratch/ui.before"

cp -p .env "$scratch/env.before"
printf 'keep this recording\n' > "$scratch/recording.before"
cp "$scratch/recording.before" archive/recovery.fixture
pg -c "CREATE TABLE install_recovery (value text); INSERT INTO install_recovery VALUES ('keep this row');"
vault_key > "$scratch/key.before"
[[ $(wc -c < "$scratch/key.before") == 32 ]] || fail 'expected a 32-byte vault key'
active_ids=$(compose ps -q | sort)
[[ $(wc -l <<< "$active_ids") == 4 ]] || fail 'not all four long-running services are active'
all_ids=$(compose ps -aq | sort)

printf '\n== Pull failure on the active project ==\n'
: > "$scratch/trace"
if run_installer 1 > "$scratch/failure.log" 2>&1; then fail 'injected pull unexpectedly succeeded'; fi
cat "$scratch/failure.log"
grep -Fq 'integration fixture: injected compose pull failure' "$scratch/failure.log"
assert_trace failure
[[ $(compose ps -q | sort) == "$active_ids" && $(compose ps -aq | sort) == "$all_ids" ]] || fail 'container IDs changed after the failed pull'
check_stack
check_fixture

printf '\n== Successful rerun in the same project ==\n'
: > "$scratch/trace"
run_installer 0
assert_trace success
[[ $(compose ps -q | sort) == "$active_ids" && $(compose ps -aq | sort) == "$all_ids" ]] || fail 'container IDs changed after rerun'
check_stack
check_fixture
check_ui "$scratch/ui.after"
cmp -s "$scratch/ui.before.html" "$scratch/ui.after.html"
cmp -s "$scratch/ui.before.js" "$scratch/ui.after.js"
teardown
cleanup_needed=0

printf '\n== Nonexistent CPU digest in a new project ==\n'
stage missing
printf -v image '%ssha256:%064d' "${cpu%@*}@" 0
[[ $image != "$cpu" && $image != "$gpu" ]] || fail 'nonexistent digest collides with a release pin'
sed -i "s|^OPENVMS_IMAGE_CPU=.*|OPENVMS_IMAGE_CPU=$image|" deploy/images.env
cleanup_needed=1
: > "$scratch/trace"
if run_installer 0 > "$scratch/missing.log" 2>&1; then fail 'missing digest unexpectedly succeeded'; fi
cat "$scratch/missing.log"
grep -Eiq 'manifest unknown|not found' "$scratch/missing.log"
assert_trace failure
containers=$(docker_cmd ps -aq)
[[ -z $containers ]] || fail 'a container was created despite the missing digest'
printf '\nPASS: verified the pinned CPU install and both pull-failure scenarios.\n'
