#!/usr/bin/env bash
# Testes isolados: nenhum Docker, sudo, clone remoto ou porta real e usado.
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR:-$HOME/.cache}"
mkdir -p "$SCRATCH"
ROOT="$(mktemp -d "$SCRATCH/openvms-install-test.XXXXXX")"
mkdir -p "$ROOT/bin"

# Use os mesmos artefatos do checkout que o instalador recebe (sem source).
pin() { sed -n "s/^$1=//p" "$SOURCE_DIR/deploy/images.env"; }
CPU_IMAGE=$(pin OPENVMS_IMAGE_CPU)
GPU_IMAGE=$(pin OPENVMS_IMAGE_GPU)
IMAGE_SOURCE=$(pin OPENVMS_IMAGE_SOURCE)
IMAGE_PREVIEW=$(pin OPENVMS_IMAGE_PREVIEW)
[[ -n "$CPU_IMAGE" && -n "$GPU_IMAGE" && -n "$IMAGE_SOURCE" && "$IMAGE_PREVIEW" =~ ^[01]$ ]]
cat > "$ROOT/index.html" <<'HTML'
<!doctype html>
<html lang="pt-BR"><head>
  <script type="module" crossorigin src="/assets/index-fixture.js"></script>
</head><body><div id="root"></div></body></html>
HTML
printf 'console.log("fixture OpenVMS");\n' > "$ROOT/index.js"

cat > "$ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
record() { printf '%s\n' "$*" >> "$MOCK_CALLS"; }
original="$*"
unexpected() { record "unexpected docker $original"; exit 96; }
# O ID local da imagem não é o digest do manifesto no registro.
image_id() {
  local hash
  hash=$(printf 'config:%s' "$1" | sha256sum)
  printf 'sha256:%s\n' "${hash%% *}"
}
active="$OPENVMS_INSTALL_DIR/.mock-active-image"
pulled="$MOCK_CALLS.pulled"
case "$1 $2" in
  'compose version') echo 'Docker Compose version v2.39.4'; exit 0 ;;
  'context inspect') printf '%s\n' "${DOCKER_ENDPOINT:-unix:///var/run/docker.sock}"; exit 0 ;;
  'info '|'info --format'|'info -f')
    printf '%s\n' "${DOCKER_PLATFORM:-linux/x86_64}"
    exit 0 ;;
esac
case "$1" in
  compose)
    shift
    files=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -f|--file) path="${2#"$PWD/"}"; files+=("${path#./}"); shift 2 ;;
        --progress|-p|--project-name|--env-file) shift 2 ;;
        *) break ;;
      esac
    done
    # Capture explicitamente a regressão ao rodar contra o instalador antigo.
    if [[ "$1" == build ]]; then record build; echo 'build proibido no instalador GHCR' >&2; exit 96; fi
    if [[ "$*" == 'config --quiet' && ${#files[@]} == 0 ]]; then
      record 'config legado'
      exit 0
    fi
    case "${OPENVMS_IMAGE:-}" in
      "$CPU_IMAGE") variant=cpu; expected_files='docker-compose.yml deploy/compose.ghcr.yml' ;;
      "$GPU_IMAGE") variant=gpu; expected_files='docker-compose.yml deploy/compose.ghcr.yml deploy/compose.nvidia.yml' ;;
      *) unexpected ;;
    esac
    [[ "${files[*]}" == "$expected_files" && "$PWD" == "$OPENVMS_INSTALL_DIR" ]] || unexpected
    case "$1" in
      config)
        case "$2" in
          --quiet|-q)
            record "config $variant"
            if [[ "${CONFIG_FAIL:-0}" == 1 ]]; then echo 'unknown tag !reset' >&2; exit 15; fi ;;
          --environment)
            while IFS='=' read -r key value; do
              case "$key" in
                OVMS_MEDIA_PATH|OPENVMS_PG_PASSWORD|OPENVMS_PG_URL|COMPOSE_*)
                  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}; fi
                  if [[ "$key" == OVMS_MEDIA_PATH && "${MEDIA_DRIFT:-0}" == 1 ]]; then value=/other/media; fi
                  printf '%s=%s\n' "$key" "$value" ;;
              esac
            done < .env
            preview=$(sed -n 's/^OPENVMS_PLAYBACK_PREVIEW=//p' .env)
            printf 'OPENVMS_PLAYBACK_PREVIEW=%s\n' "${OPENVMS_PLAYBACK_PREVIEW:-${preview:-$IMAGE_PREVIEW}}" ;;
          *) unexpected ;;
        esac ;;
      pull)
        case "$*" in
          'pull --policy missing api') record "pull $variant api" ;;
          'pull --policy missing api dist') record "pull $variant"; record 'app-images-only' ;;
          pull) record "pull $variant" ;;
          *) unexpected ;;
        esac
        grep -Fxq "config $variant" "$MOCK_CALLS" || unexpected
        if [[ "${GPU_TWO_PHASE_FAILURE:-0}" == 1 ]]; then
          if [[ "$*" == pull || ! -e "$MOCK_CALLS.retry" ]]; then
            touch "$MOCK_CALLS.retry"
            echo 'connection reset by peer' >&2
            exit 25
          fi
        fi
        if [[ "${SLOW_PULL:-0}" == 1 ]]; then sleep 5; fi
        if [[ "${LEAK_PULL:-0}" == 1 ]]; then
          while IFS= read -r entry; do
            case "$entry" in OPENVMS_PG_*=*) printf 'pull: %s\n' "${entry#*=}" ;; esac
          done < .env
        fi
        if [[ -n "${PULL_FAILURE:-}" ]]; then printf '%s\n' "$PULL_FAILURE" >&2; exit 25; fi
        if [[ "${TRANSIENT_PULL:-0}" == 1 && ! -e "$MOCK_CALLS.retry" ]]; then
          touch "$MOCK_CALLS.retry"
          if [[ -n "${FIRST_PULL_DELAY:-}" ]]; then sleep "$FIRST_PULL_DELAY"; fi
          printf 'Get https://ghcr.io/v2/: net/http: TLS handshake timeout\n' >&2
          exit 28
        fi
        if [[ -n "${RETRY_PULL_DELAY:-}" ]]; then sleep "$RETRY_PULL_DELAY"; fi
        printf '%s\n' "$OPENVMS_IMAGE" >> "$pulled"
        if [[ "$*" != 'pull --policy missing api' ]]; then printf '%s\n' "$OPENVMS_IMAGE" > "$pulled.all"; fi ;;
      up)
        record "up $variant"
        expected_up='up -d --no-build --pull never --remove-orphans=false'
        if [[ -s "$active" ]]; then expected_up+=' --no-recreate'; fi
        [[ "$*" == "$expected_up" ]] || unexpected
        grep -Fxq -- "$OPENVMS_IMAGE" "$pulled.all" || unexpected
        if [[ "${SLOW_UP:-0}" == 1 ]]; then sleep 5; fi
        if [[ "${UP_EXIT:-0}" != 0 ]]; then exit "$UP_EXIT"; fi
        printf '%s\n' "$OPENVMS_IMAGE" > "$active" ;;
      ps)
        case "${*: -1}" in
          dist)
            if [[ "${SLOW_PS:-0}" == 1 ]]; then sleep 12; fi
            [[ ! -s "$active" ]] || printf '%s\n' fake-dist ;;
          api|web|postgres|mediamtx)
            if [[ -s "$active" && "${*: -1}" != "${MISSING_SERVICE:-}" ]]; then printf 'fake-%s\n' "${*: -1}"; fi ;;
        esac ;;
      *) unexpected ;;
    esac ;;
  ps)
    [[ "$*" == 'ps -aq --filter name=^/ovms-(api|dist|pg|rtsp|web)$' ]] || unexpected
    if [[ -s "$active" || "${EXISTING_STACK:-0}" == 1 ]]; then printf 'existing-container\n'; fi ;;
  volume)
    [[ "$*" == 'volume ls -q --filter label=com.docker.compose.volume='* ]] || unexpected
    if [[ "${EXISTING_VOLUME:-0}" == 1 ]]; then printf 'existing-volume\n'; fi ;;
  run)
    record 'probe gpu'
    padded=" $* "
    for arg in '--rm' '--network none' '--gpus 1' '--pull never' '--entrypoint ffmpeg' "$GPU_IMAGE" h264_nvenc; do
      [[ "$padded" == *" $arg "* ]] || unexpected
    done
    [[ "$padded" != *' -v '* && "$padded" != *' --volume '* && "$padded" != *' --volume='* && "$padded" != *' --mount '* && "$padded" != *' --mount='* ]] || unexpected
    grep -Fxq -- "$GPU_IMAGE" "$pulled" || unexpected
    if [[ -n "${PROBE_ERROR:-}" ]]; then printf '%s\n' "$PROBE_ERROR" >&2; fi
    exit "${PROBE_EXIT:-0}" ;;
  inspect|container)
    [[ -s "$active" ]] || unexpected
    case "${*: -1}" in
      fake-dist|fake-api|fake-web) ;;
      *) unexpected ;;
    esac
    case "$*" in
      *'{{.Config.Image}}'*) cat "$active" ;;
      *'{{.Image}}'*)
        ref=$(< "$active")
        if [[ "${WRONG_API_IMAGE_ID:-0}" == 1 && "${*: -1}" == fake-api ]]; then
          echo 'sha256:outdated'
        else
          image_id "$ref"
        fi ;;
      *'{{.State.Health.Status}}'*) record health; echo "${API_HEALTH:-healthy}" ;;
      *'{{.State.ExitCode}}'*) echo "${DIST_EXIT:-0}" ;;
      *'{{.State.Status}}'*) [[ "${*: -1}" == fake-dist ]] && echo exited || echo running ;;
      *) unexpected ;;
    esac ;;
  image)
    [[ "$2" == inspect ]] || unexpected
    case "$*" in
      *'{{index .Config.Labels "org.opencontainers.image.revision"}}'*) printf '%s\n' "${IMAGE_REVISION:-$IMAGE_SOURCE}" ;;
      *org.opencontainers.image.revision*) echo 'template parsing error: invalid revision label format' >&2; exit 64 ;;
      *'{{.Architecture}}'*) echo amd64 ;;
      *'{{.Os}}'*) echo linux ;;
      *'{{.Id}}'*) image_id "${*: -1}" ;;
      *) unexpected ;;
    esac ;;
  exec)
    case "$*" in
      *' cat /app/client/dist/index.html') cat "$ROOT/index.html" ;;
      *' sha256sum /app/client/dist/assets/index-fixture.js') sha256sum "$ROOT/index.js" ;;
      *' cat /app/client/dist/assets/index-fixture.js') cat "$ROOT/index.js" ;;
      *' test -f /app/client/dist/assets/index-fixture.js') exit 0 ;;
      *) unexpected ;;
    esac ;;
  *) unexpected ;;
esac
MOCK
cat > "$ROOT/bin/git" <<'MOCK'
#!/usr/bin/env bash
set -e
if [[ "$1" == clone ]]; then
  target="${*: -1}"
  /usr/bin/git init -q "$target"
  mkdir -p "$target/deploy" "$target/conf"
  cp "$SOURCE_DIR/docker-compose.yml" "$target/"
  cp "$SOURCE_DIR/conf/config.yaml" "$target/conf/"
  cp "$SOURCE_DIR/deploy/"{images.env,compose.ghcr.yml,compose.nvidia.yml} "$target/deploy/"
  /usr/bin/git -C "$target" remote add origin https://github.com/LeonardoDiasRR/open-vms.git
elif [[ "$1" == -C && "$3 $4" == 'diff --quiet' ]]; then
  if [[ "$5" == HEAD ]]; then [[ "${DIRTY_DEPLOY:-0}" != 1 ]]; else [[ "$5" == "$IMAGE_SOURCE" && "${CHECKOUT_DRIFT:-0}" != 1 ]]; fi
elif [[ "$*" == *'rev-parse'* && "$*" == *HEAD* ]]; then
  printf '%s\n' "$IMAGE_SOURCE"
elif [[ "$1" == -C && "$3 $4 $5" == 'remote get-url origin' ]]; then
  exec /usr/bin/git "$@"
else
  printf 'unexpected git %s\n' "$*" >> "$MOCK_CALLS"
  exit 96
fi
MOCK
cat > "$ROOT/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
[[ "${FAIL_SUDO:-0}" != 1 ]] || exit 42
[[ "$1" == -v ]] && exit 0
exec "$@"
MOCK
cat > "$ROOT/bin/ss" <<'MOCK'
#!/usr/bin/env bash
if [[ "${PORT_BUSY:-0}" == 1 ]]; then
  printf 'tcp LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\n' "${PORT_BUSY_VALUE:-7102}"
fi
MOCK
cat > "$ROOT/bin/nvidia-smi" <<'MOCK'
#!/usr/bin/env bash
printf 'nvidia-smi\n' >> "$MOCK_CALLS"
[[ "${NVIDIA_PRESENT:-0}" == 1 ]] || exit 1
printf 'GPU 0: Test NVIDIA GPU\n'
MOCK
cat > "$ROOT/bin/curl" <<'MOCK'
#!/usr/bin/env bash
out=/dev/stdout
while (($#)); do
  case "$1" in
    -o|--output) out="$2"; shift ;;
    http://*) url="$1" ;;
  esac
  shift
done
case "${url:-}" in
  http://127.0.0.1:7101/api/v1/health)
    printf 'http_health\n' >> "$MOCK_CALLS"
    [[ "${API_HTTP_FAIL:-0}" != 1 ]] ;;
  http://127.0.0.1:7102/)
    printf 'web\n' >> "$MOCK_CALLS"
    [[ "${WEB_FAIL:-0}" != 1 ]] && cat "$ROOT/index.html" > "$out" ;;
  http://127.0.0.1:7102/assets/index-fixture.js)
    printf 'asset\n' >> "$MOCK_CALLS"
    if [[ "${JS_SPA_FALLBACK:-0}" == 1 ]]; then cat "$ROOT/index.html" > "$out"; else cat "$ROOT/index.js" > "$out"; fi ;;
  *) printf 'unexpected curl %s\n' "${url:-}" >> "$MOCK_CALLS"; exit 96 ;;
esac
MOCK
chmod +x "$ROOT/bin/"*
export ROOT SOURCE_DIR CPU_IMAGE GPU_IMAGE IMAGE_SOURCE IMAGE_PREVIEW

failures=0
assert() {
  local name="$1"; shift
  if "$@"; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"; failures=$((failures + 1))
  fi
}
calls_are() {
  local name="$1" pattern="$2" expected="$3" actual
  actual=$(grep -E "$pattern" "$ROOT/$name/calls" || true)
  if [[ "$actual" != "$expected" ]]; then
    printf '  %s: chamadas esperadas [%s]; observadas [%s]\n' "$name" "$expected" "$actual"
    return 1
  fi
}
run() {
  local name="$1" expected="$2" reason="$3" install="$ROOT/$1/app" rc=0
  shift 3
  mkdir -p "$(dirname "$install")"
  : > "$ROOT/$name/calls"
  (
    unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_REMOVE_ORPHANS COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE \
      DOCKER_CONTEXT DOCKER_HOST DOCKER_DEFAULT_PLATFORM OPENVMS_REF OPENVMS_VARIANT OPENVMS_IMAGE OVMS_MEDIA_PATH \
      OPENVMS_PLAYBACK_PREVIEW OPENVMS_RTSP_PORT OPENVMS_PG_URL OPENVMS_PG_PASSWORD
    export PATH="$ROOT/bin:$PATH" OPENVMS_INSTALL_DIR="$install" OPENVMS_MEDIA_DIR="$install/archive"
    export OPENVMS_PULL_TIMEOUT=2 OPENVMS_HEALTH_TIMEOUT=2 OPENVMS_START_TIMEOUT=2
    export XDG_STATE_HOME="$ROOT/$name/state" MOCK_CALLS="$ROOT/$name/calls"
    env "$@" bash "$SOURCE_DIR/install.sh"
  ) > "$ROOT/$name.log" 2>&1 || rc=$?
  if [[ "$expected" == failure ]]; then reason="^Erro:.*($reason)"; fi
  if [[ "$expected" == success && "$rc" != 0 || "$expected" == failure && "$rc" == 0 ]] \
    || ! grep -Eiq "$reason" "$ROOT/$name.log" || grep -Eq '^(build$|unexpected )' "$ROOT/$name/calls"; then
    printf 'FAIL %s (exit %s; expected %s; see %s/%s.log)\n' "$name" "$rc" "$reason" "$ROOT" "$name"
    failures=$((failures + 1))
  else
    printf 'PASS %s (exit %s)\n' "$name" "$rc"
  fi
}
fixture() { "$ROOT/bin/git" clone "$ROOT/$1/app"; }

run fresh_without_sudo success 'Instalação validada' FAIL_SUDO=1
assert fresh_order calls_are fresh_without_sudo '^(config |pull |up |health|http_health|web|asset)' \
  $'config cpu\npull cpu\nup cpu\nhealth\nhttp_health\nweb\nasset'
assert no_driver_skips_container_probe calls_are fresh_without_sudo '^(nvidia-smi|probe )' 'nvidia-smi'
run cpu_without_probe success 'Instalação validada' OPENVMS_VARIANT=cpu NVIDIA_PRESENT=1 DOCKER_PLATFORM=linux/amd64
assert cpu_skips_gpu calls_are cpu_without_probe '^(nvidia-smi|probe |pull |up )' $'pull cpu\nup cpu'
run auto_gpu success 'Instalação validada' NVIDIA_PRESENT=1
assert auto_gpu_order calls_are auto_gpu '^(nvidia-smi|pull |probe |up )' $'nvidia-smi\npull gpu api\nprobe gpu\npull gpu\nup gpu'
run explicit_gpu success 'Instalação validada' OPENVMS_VARIANT=gpu
assert explicit_gpu_skips_host_probe calls_are explicit_gpu '^(nvidia-smi|pull |probe |up )' $'pull gpu api\nprobe gpu\npull gpu\nup gpu'
capability_error='NVENC|NVIDIA Container Toolkit|driver NVIDIA'
run auto_fallback success 'Instalação validada' NVIDIA_PRESENT=1 PROBE_EXIT=1 PROBE_ERROR='Cannot load libnvidia-encode.so.1'
assert fallback_uses_cpu calls_are auto_fallback '^(pull |probe |up )' $'pull gpu api\nprobe gpu\npull cpu\nup cpu'
assert fallback_has_diagnostic grep -Eiq 'sonda|NVENC|GPU.*CPU' "$ROOT/auto_fallback.log"
run auto_missing_toolkit success 'Instalação validada' NVIDIA_PRESENT=1 PROBE_EXIT=125 \
  PROBE_ERROR='could not select device driver "" with capabilities: [[gpu]]'
assert missing_toolkit_uses_cpu calls_are auto_missing_toolkit '^(pull |probe |up )' $'pull gpu api\nprobe gpu\npull cpu\nup cpu'
run gpu_unavailable failure "$capability_error" OPENVMS_VARIANT=gpu PROBE_EXIT=1 PROBE_ERROR='No NVENC capable devices found'
assert explicit_gpu_never_falls_back calls_are gpu_unavailable '^(pull |probe |up )' $'pull gpu api\nprobe gpu'
run gpu_daemon_error failure 'daemon|infraestrutura|125' NVIDIA_PRESENT=1 PROBE_EXIT=125 \
  PROBE_ERROR='Error response from daemon: open /var/lib/docker/overlay2: input/output error'
assert daemon_error_never_falls_back calls_are gpu_daemon_error '^(pull |probe |up )' $'pull gpu api\nprobe gpu'
run gpu_probe_timeout failure 'timeout|tempo|limite|124' NVIDIA_PRESENT=1 PROBE_EXIT=124
assert probe_timeout_never_falls_back calls_are gpu_probe_timeout '^(pull |probe |up )' $'pull gpu api\nprobe gpu'
run gpu_probe_error failure 'Falha ao executar a sonda NVIDIA' NVIDIA_PRESENT=1 PROBE_EXIT=1 PROBE_ERROR='No such filter: color'
assert generic_probe_failure_never_falls_back calls_are gpu_probe_error '^(pull |probe |up )' $'pull gpu api\nprobe gpu'
run gpu_global_retry failure 'Download das imagens.*código 25' NVIDIA_PRESENT=1 GPU_TWO_PHASE_FAILURE=1 OPENVMS_PULL_TIMEOUT=8
assert gpu_retry_shared calls_are gpu_global_retry '^(pull |probe |up )' $'pull gpu api\npull gpu api\nprobe gpu\npull gpu'
run unsupported_arch failure 'linux/arm64|plataforma|arquitetura' DOCKER_PLATFORM=linux/arm64
assert unsupported_arch_no_pull_or_up calls_are unsupported_arch '^(pull |up )' ''
run remote_daemon failure 'contexto Docker local' DOCKER_ENDPOINT=ssh://mock.invalid
assert remote_daemon_no_pull_or_up calls_are remote_daemon '^(pull |up )' ''
run invalid_variant failure 'OPENVMS_VARIANT' OPENVMS_VARIANT=tpu
assert invalid_variant_no_pull_or_up calls_are invalid_variant '^(pull |up )' ''
run incompatible_compose failure 'Compose' CONFIG_FAIL=1
assert incompatible_compose_no_pull_or_up calls_are incompatible_compose '^(pull |up )' ''
run unsupported_compose_file failure 'COMPOSE_FILE' COMPOSE_FILE=custom.yml
assert unsupported_compose_file_no_pull_or_up calls_are unsupported_compose_file '^(pull |up )' ''
fixture unsupported_compose_override
printf 'services: {}\n' > "$ROOT/unsupported_compose_override/app/docker-compose.override.yml"
run unsupported_compose_override failure 'Complemento local|override'
assert unsupported_compose_override_no_pull_or_up calls_are unsupported_compose_override '^(pull |up )' ''
fixture missing_manifest
mv "$ROOT/missing_manifest/app/deploy/images.env" "$ROOT/missing_manifest/"
run missing_manifest failure 'deploy/images\.env.*referência compatível'
assert missing_manifest_no_pull_or_up calls_are missing_manifest '^(pull |up )' ''
run preview_drift failure 'OPENVMS_PLAYBACK_PREVIEW' OPENVMS_PLAYBACK_PREVIEW="$((1 - IMAGE_PREVIEW))"
assert preview_drift_no_up calls_are preview_drift '^up ' ''
run platform_override failure 'DOCKER_DEFAULT_PLATFORM' DOCKER_DEFAULT_PLATFORM=linux/arm64
assert platform_override_no_up calls_are platform_override '^(pull |up )' ''
run ambient_media_override failure 'OVMS_MEDIA_PATH' OVMS_MEDIA_PATH=/other/media
assert ambient_media_override_no_up calls_are ambient_media_override '^(pull |up )' ''
run effective_media_drift failure 'destino de gravações' MEDIA_DRIFT=1
assert effective_media_drift_no_up calls_are effective_media_drift '^(pull |up )' ''
run orphan_removal failure 'COMPOSE_REMOVE_ORPHANS' COMPOSE_REMOVE_ORPHANS=1
assert orphan_removal_no_up calls_are orphan_removal '^(pull |up )' ''
run checkout_drift failure 'revisão do checkout' CHECKOUT_DRIFT=1
assert checkout_drift_no_up calls_are checkout_drift '^(pull |up )' ''
run unsafe_config failure 'Configuração Compose.*alterada' DIRTY_DEPLOY=1
assert unsafe_config_no_up calls_are unsafe_config '^(pull |up )' ''
fixture lost_env
run lost_env failure 'Restaure a configuração original' EXISTING_VOLUME=1
assert lost_env_kept_absent test ! -e "$ROOT/lost_env/app/.env"
assert lost_env_no_up calls_are lost_env '^(pull |up )' ''

fixture incomplete_env
printf 'OVMS_MEDIA_PATH=%s\n' "$ROOT/incomplete_env/app/archive" > "$ROOT/incomplete_env/app/.env"
run incomplete_env failure '\.env incompleto'
run dist_failed failure 'publicação da interface \(dist\) terminou com código 1' DIST_EXIT=1
run occupied_port failure 'Porta 7102 já está em uso' PORT_BUSY=1
run custom_rtsp_port failure 'Porta 10554 já está em uso' PORT_BUSY=1 PORT_BUSY_VALUE=10554 OPENVMS_RTSP_PORT=10554
run unhealthy_api failure 'Serviços não ficaram saudáveis' API_HEALTH=unhealthy
run unavailable_api_http failure 'Serviços não ficaram saudáveis' API_HTTP_FAIL=1
run unavailable_web failure 'Serviços não ficaram saudáveis' WEB_FAIL=1
run stale_asset failure 'interface|Estático|asset' JS_SPA_FALLBACK=1
assert stale_asset_was_requested grep -Fxq asset "$ROOT/stale_asset/calls"
run wrong_api_image failure 'API.*(imagem|digest)' WRONG_API_IMAGE_ID=1
assert image_mismatch_checked_after_up calls_are wrong_api_image '^up ' 'up cpu'
run wrong_revision failure 'revisão da imagem.*deploy/images\.env' IMAGE_REVISION=outdated
assert revision_mismatch_blocks_up calls_are wrong_revision '^(pull |up )' 'pull cpu'
run slow_daemon failure 'Timeout ao consultar o serviço dist' SLOW_PS=1
run startup_timeout failure 'Inicialização dos serviços falhou \(código 124\)' SLOW_UP=1
run startup_error failure 'Inicialização dos serviços falhou \(código 27\)' UP_EXIT=27
assert startup_attempted_after_pull calls_are startup_error '^(pull |up )' $'pull cpu\nup cpu'

run slow_pull failure 'Download das imagens.*(124|limite)' SLOW_PULL=1
assert timed_out_pull_no_up calls_are slow_pull '^(pull |up )' 'pull cpu'
run transient_pull success 'Instalação validada' TRANSIENT_PULL=1 OPENVMS_PULL_TIMEOUT=8
assert transient_pull_retries_once calls_are transient_pull '^(pull |up )' $'pull cpu\npull cpu\nup cpu'
run pull_deadline_shared failure 'Download das imagens.*(124|limite)' \
  TRANSIENT_PULL=1 FIRST_PULL_DELAY=2 RETRY_PULL_DELAY=3 OPENVMS_PULL_TIMEOUT=4
assert retry_uses_remaining_time calls_are pull_deadline_shared '^(pull |up )' $'pull cpu\npull cpu'
run transient_pull_exhausted failure 'Download das imagens.*código 25' PULL_FAILURE='connection reset by peer' OPENVMS_PULL_TIMEOUT=8
assert exhausted_pull_no_up calls_are transient_pull_exhausted '^(pull |up )' $'pull cpu\npull cpu'
run pull_error failure 'Download das imagens.*código 25' PULL_FAILURE='denied: requested access to the resource is denied' LEAK_PULL=1
assert permanent_pull_no_retry_or_up calls_are pull_error '^(pull |up )' 'pull cpu'
run gpu_pull_error failure 'Download das imagens.*código 25' NVIDIA_PRESENT=1 PULL_FAILURE='manifest unknown'
assert gpu_registry_error_never_falls_back calls_are gpu_pull_error '^(pull |probe |up )' 'pull gpu api'
run no_disk_space failure 'Download das imagens.*código 25' PULL_FAILURE='failed to register layer: no space left on device'
assert no_space_no_retry_or_up calls_are no_disk_space '^(pull |up )' 'pull cpu'

redacted_log() {
  local log_paths=("$ROOT/pull_error/state/openvms/"*.log) entry secret log_text console_text
  [[ -f "${log_paths[0]}" && -f "$ROOT/pull_error/app/.env" ]] || return 1
  log_text=$(< "${log_paths[0]}")
  console_text=$(< "$ROOT/pull_error.log")
  while IFS= read -r entry; do
    case "$entry" in
      OPENVMS_PG_*=*)
        secret="${entry#*=}"
        [[ -n "$secret" && "$log_text" != *"$secret"* && "$console_text" != *"$secret"* ]] || return 1 ;;
    esac
  done < "$ROOT/pull_error/app/.env"
  [[ "$log_text" == *'[OCULTO]'* && "$log_text" == *'falhou (código 25)'* \
    && "$(stat -c %a "${log_paths[0]}")" == 600 ]]
}
assert pull_log_redacted redacted_log

fixture preserved_media
app="$ROOT/preserved_media/app"
mkdir -p "$app/archive"
chmod 755 "$app/archive"
printf 'keep me\n' > "$app/archive/recording-fixture"
printf '\n# config fixture\n' >> "$app/conf/config.yaml"
cp "$app/conf/config.yaml" "$ROOT/preserved_config.before"
run preserved_media success 'Instalação validada'
assert preserved_media_permissions test "$(stat -c %a "$app/archive")" = 755
if [[ -f "$app/.env" ]]; then
  cp "$app/.env" "$ROOT/preserved_env.before"
  chmod 644 "$app/.env"
  run preserved_env success 'Instalação validada' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive" NVIDIA_PRESENT=1
  assert existing_cpu_not_switched calls_are preserved_env '^(nvidia-smi|pull |probe |up )' $'pull cpu\nup cpu'
  assert existing_pulls_only_immutable_refs grep -Fxq app-images-only "$ROOT/preserved_env/calls"
  run missing_api failure 'API deste projeto não foi encontrada' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive" MISSING_SERVICE=api
  assert missing_api_no_up calls_are missing_api '^(pull |up )' ''
  run missing_db failure 'serviço postgres falta' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive" MISSING_SERVICE=postgres
  assert missing_db_no_up calls_are missing_db '^(pull |up )' ''
  assert preserved_env_content cmp -s "$ROOT/preserved_env.before" "$app/.env"
  assert preserved_env_permissions test "$(stat -c %a "$app/.env")" = 600
  while IFS= read -r entry; do
    printf '%s="%s"\n' "${entry%%=*}" "${entry#*=}"
  done < "$ROOT/preserved_env.before" > "$app/.env"
  run quoted_env success 'Instalação validada' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive"
  cp "$ROOT/preserved_env.before" "$app/.env"
  run existing_pull_error failure 'Download das imagens.*código 25' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive" \
    PULL_FAILURE='denied: requested access to the resource is denied'
  assert existing_pull_error_no_up calls_are existing_pull_error '^(pull |up )' 'pull cpu'
  assert existing_image_unchanged grep -Fxq "$CPU_IMAGE" "$app/.mock-active-image"
  run retry_after_pull_failure success 'Instalação validada' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive"
  assert retry_keeps_env cmp -s "$ROOT/preserved_env.before" "$app/.env"
  assert retry_keeps_config cmp -s "$ROOT/preserved_config.before" "$app/conf/config.yaml"
  assert retry_keeps_recording grep -Fxq 'keep me' "$app/archive/recording-fixture"
fi
printf '%s\n' "$GPU_IMAGE" > "$app/.mock-active-image"
run active_gpu_unavailable failure "$capability_error" OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive" \
  NVIDIA_PRESENT=1 PROBE_EXIT=1 PROBE_ERROR='No NVENC capable devices found'
assert active_gpu_never_falls_back calls_are active_gpu_unavailable '^(pull |probe |up )' $'pull gpu api\nprobe gpu'
printf '%s\n' 'openvms-api:local' > "$app/.mock-active-image"
run active_local_build failure 'migra|build local|imagem local' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive"
assert local_build_never_replaced calls_are active_local_build '^(pull |up )' ''
/usr/bin/git -C "$app" remote set-url origin https://github.com/other/repo.git
run wrong_repo failure 'pertence a outro repositório' OPENVMS_INSTALL_DIR="$app" OPENVMS_MEDIA_DIR="$app/archive"
if ((failures)); then
  printf '%s teste(s) falharam; logs: %s\n' "$failures" "$ROOT"
  exit 1
fi
printf 'Todos os testes passaram. Logs: %s\n' "$ROOT"
