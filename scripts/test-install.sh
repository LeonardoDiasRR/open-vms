#!/usr/bin/env bash
# Testes isolados: nenhum Docker, sudo, clone remoto ou porta real e usado.
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR:-$HOME/.cache}"
mkdir -p "$SCRATCH"
ROOT="$(mktemp -d "$SCRATCH/openvms-install-test.XXXXXX")"
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  'compose version'|'compose config'|'info ') exit 0 ;;
  'compose --progress')
    [[ "$3" == plain ]] || exit 96
    case "$4" in
      build)
        [[ $# == 4 ]] || exit 96
        printf 'build\n' >> "$MOCK_CALLS"
        if [[ "${LEAK_BUILD:-0}" == 1 ]]; then
          while IFS= read -r entry; do printf 'build: %s\n' "${entry#*=}"; done < .env
        fi
        if [[ "${SLOW_BUILD:-0}" == 1 ]]; then sleep 5; fi
        exit "${BUILD_EXIT:-0}" ;;
      up)
        [[ "$*" == 'compose --progress plain up -d --no-build' ]] || exit 96
        printf 'up\n' >> "$MOCK_CALLS"
        if [[ "${SLOW_UP:-0}" == 1 ]]; then sleep 5; fi
        exit "${UP_EXIT:-0}" ;;
      *) exit 96 ;;
    esac ;;
  'compose ps')
    if [[ "${SLOW_PS:-0}" == 1 ]]; then sleep 12; fi
    case "${*: -1}" in dist|api|web) echo "fake-${*: -1}" ;; esac ;;
  'inspect --format')
    case "${*: -1}" in
      fake-dist)
        case "$3" in *Status*) echo exited ;; *ExitCode*) echo "${DIST_EXIT:-0}" ;; esac ;;
      fake-api) echo "${API_HEALTH:-healthy}" ;;
      fake-web) echo running ;;
    esac ;;
esac
exit 0
MOCK
cat > "$ROOT/bin/git" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == clone ]]; then
  target="${*: -1}"
  mkdir -p "$target/conf"
  /usr/bin/git init -q "$target"
  cp "$SOURCE_DIR/docker-compose.yml" "$target/"
  cp "$SOURCE_DIR/conf/config.yaml" "$target/conf/"
  printf '%s\n' '[remote "origin"]' 'url = https://github.com/LeonardoDiasRR/open-vms.git' > "$target/.git/config"
  exit 0
fi
if [[ "$1" == -C && "$3 $4 $5" == 'remote get-url origin' ]]; then
  /usr/bin/git -C "$2" remote get-url origin
  exit $?
fi
exit 0
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
cat > "$ROOT/bin/curl" <<'MOCK'
#!/usr/bin/env bash
case "${*: -1}" in
  http://127.0.0.1:7101/api/v1/health) [[ "${API_HTTP_FAIL:-0}" != 1 ]] ;;
  http://127.0.0.1:7102/) [[ "${WEB_FAIL:-0}" != 1 ]] ;;
  *) printf 'URL inesperada no teste: %s\n' "${*: -1}" >&2; exit 1 ;;
esac
MOCK
chmod +x "$ROOT/bin/"*
failures=0
run() {
  local name="$1" expected="$2" reason="$3" install="$ROOT/$1/app" rc=0
  shift 3
  mkdir -p "$(dirname "$install")"
  (export PATH="$ROOT/bin:$PATH" SOURCE_DIR OPENVMS_INSTALL_DIR="$install" OPENVMS_MEDIA_DIR="$install/archive" OPENVMS_BUILD_TIMEOUT=2 OPENVMS_HEALTH_TIMEOUT=2 OPENVMS_START_TIMEOUT=2
   export XDG_STATE_HOME="$ROOT/$name/state" MOCK_CALLS="$ROOT/$name/calls"
   "$@" bash "$SOURCE_DIR/install.sh") > "$ROOT/$name.log" 2>&1 || rc=$?
  if [[ "$expected" == success && "$rc" != 0 || "$expected" == failure && "$rc" == 0 ]] || ! grep -Fq "$reason" "$ROOT/$name.log"; then
    printf 'FAIL %s (exit %s; expected %s)\n' "$name" "$rc" "$reason"; failures=$((failures + 1))
  else
    printf 'PASS %s (exit %s)\n' "$name" "$rc"
  fi
}
run fresh_without_sudo success 'Instalação validada' env FAIL_SUDO=1
mkdir -p "$ROOT/incomplete_env/app/.git" "$ROOT/incomplete_env/app/conf"
/usr/bin/git init -q "$ROOT/incomplete_env/app"
cp "$SOURCE_DIR/docker-compose.yml" "$ROOT/incomplete_env/app/"
cp "$SOURCE_DIR/conf/config.yaml" "$ROOT/incomplete_env/app/conf/"
printf '%s\n' '[remote "origin"]' 'url = https://github.com/LeonardoDiasRR/open-vms.git' > "$ROOT/incomplete_env/app/.git/config"
printf 'OVMS_MEDIA_PATH=%s\n' "$ROOT/incomplete_env/app/archive" > "$ROOT/incomplete_env/app/.env"
run incomplete_env failure '.env incompleto' env
mkdir -p "$ROOT/dist_failed/app/.git" "$ROOT/dist_failed/app/conf"
/usr/bin/git init -q "$ROOT/dist_failed/app"
cp "$SOURCE_DIR/docker-compose.yml" "$ROOT/dist_failed/app/"
cp "$SOURCE_DIR/conf/config.yaml" "$ROOT/dist_failed/app/conf/"
printf '%s\n' '[remote "origin"]' 'url = https://github.com/LeonardoDiasRR/open-vms.git' > "$ROOT/dist_failed/app/.git/config"
run dist_failed failure 'publicação da interface (dist) terminou com código 1' env DIST_EXIT=1
run occupied_port failure 'Porta 7102 já está em uso' env PORT_BUSY=1
run custom_rtsp_port failure 'Porta 10554 já está em uso' env PORT_BUSY=1 PORT_BUSY_VALUE=10554 OPENVMS_RTSP_PORT=10554
mkdir -p "$ROOT/preserved_media/app/.git" "$ROOT/preserved_media/app/conf" "$ROOT/preserved_media/app/archive"
/usr/bin/git init -q "$ROOT/preserved_media/app"
cp "$SOURCE_DIR/docker-compose.yml" "$ROOT/preserved_media/app/"
cp "$SOURCE_DIR/conf/config.yaml" "$ROOT/preserved_media/app/conf/"
printf '%s\n' '[remote "origin"]' 'url = https://github.com/LeonardoDiasRR/open-vms.git' > "$ROOT/preserved_media/app/.git/config"
chmod 755 "$ROOT/preserved_media/app/archive"
run preserved_media success 'Instalação validada' env
if [[ "$(stat -c %a "$ROOT/preserved_media/app/archive")" != 755 ]]; then
  printf 'FAIL preserved_media_permissions\n'; failures=$((failures + 1))
else
  printf 'PASS preserved_media_permissions\n'
fi
cp "$ROOT/preserved_media/app/.env" "$ROOT/preserved_env.before"
chmod 644 "$ROOT/preserved_media/app/.env"
run preserved_env success 'Instalação validada' env \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
if cmp -s "$ROOT/preserved_env.before" "$ROOT/preserved_media/app/.env" \
  && [[ "$(stat -c %a "$ROOT/preserved_media/app/.env")" == 600 ]]; then
  printf 'PASS preserved_env_content_and_permissions\n'
else
  printf 'FAIL preserved_env_content_and_permissions\n'; failures=$((failures + 1))
fi
while IFS= read -r entry; do
  printf '%s="%s"\n' "${entry%%=*}" "${entry#*=}"
done < "$ROOT/preserved_env.before" > "$ROOT/preserved_media/app/.env"
run quoted_env success 'Instalação validada' env \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
cp "$ROOT/preserved_env.before" "$ROOT/preserved_media/app/.env"
run unhealthy_api failure 'Serviços não ficaram saudáveis' env API_HEALTH=unhealthy \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
run unavailable_api_http failure 'Serviços não ficaram saudáveis' env API_HTTP_FAIL=1 \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
run unavailable_web failure 'Serviços não ficaram saudáveis' env WEB_FAIL=1 \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
run slow_build failure 'Construção das imagens falhou (código 124)' env SLOW_BUILD=1 \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
run startup_timeout failure 'Inicialização dos serviços falhou (código 124)' env SLOW_UP=1
run startup_error failure 'Inicialização dos serviços falhou (código 27)' env UP_EXIT=27
run build_error failure 'Construção das imagens falhou (código 25)' env BUILD_EXIT=25 LEAK_BUILD=1
build_app="$ROOT/build_error/app"
log_paths=("$ROOT/build_error/state/openvms/"*.log)
# Leia a fixture sem escrever o segredo em stdout nem em um processo externo.
secret_line=''
IFS= read -r secret_line < "$build_app/.env"
secret="${secret_line#*=}"
log_text=$(< "${log_paths[0]}")
console_text=$(< "$ROOT/build_error.log")
if [[ "$(< "$ROOT/build_error/calls")" == build && "$(< "$ROOT/startup_error/calls")" == $'build\nup' \
  && "$log_text" != *"$secret"* && "$console_text" != *"$secret"* && "$log_text" == *'[OCULTO]'* \
  && "$log_text" == *'falhou (código 25)'* && "$(stat -c %a "${log_paths[0]}")" == 600 ]]; then
  printf 'PASS phase_order_and_redacted_log\n'
else
  printf 'FAIL phase_order_and_redacted_log\n'; failures=$((failures + 1))
fi
cp "$build_app/.env" "$ROOT/failed_env.before"
printf 'keep me\n' > "$build_app/archive/recording-fixture"
run retry_after_build_failure success 'Instalação validada' env \
  OPENVMS_INSTALL_DIR="$build_app" OPENVMS_MEDIA_DIR="$build_app/archive"
if cmp -s "$ROOT/failed_env.before" "$build_app/.env" \
  && [[ "$(< "$build_app/archive/recording-fixture")" == 'keep me' ]]; then
  printf 'PASS retry_keeps_env_and_media\n'
else
  printf 'FAIL retry_keeps_env_and_media\n'; failures=$((failures + 1))
fi
run slow_daemon failure 'Timeout ao consultar o serviço dist' env SLOW_PS=1 \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
/usr/bin/git -C "$ROOT/preserved_media/app" remote set-url origin https://github.com/other/repo.git
run wrong_repo failure 'pertence a outro repositório' env \
  OPENVMS_INSTALL_DIR="$ROOT/preserved_media/app" OPENVMS_MEDIA_DIR="$ROOT/preserved_media/app/archive"
if [[ "$failures" != 0 ]]; then
  printf '%s teste(s) falharam; logs: %s\n' "$failures" "$ROOT"
  exit 1
fi
printf 'Todos os testes passaram. Logs: %s\n' "$ROOT"
