#!/usr/bin/env bash
# Não exponha credenciais se o operador executar bash -x.
set +x
set -Eeuo pipefail
REPO_URL="https://github.com/LeonardoDiasRR/open-vms.git"
INSTALL_DIR="${OPENVMS_INSTALL_DIR:-/opt/openvms}"
MEDIA_DIR="${OPENVMS_MEDIA_DIR:-$INSTALL_DIR/archive}"
BRANCH="${OPENVMS_REF:-main}"
BUILD_TIMEOUT="${OPENVMS_BUILD_TIMEOUT:-1800}"
START_TIMEOUT="${OPENVMS_START_TIMEOUT:-300}"
HEALTH_TIMEOUT="${OPENVMS_HEALTH_TIMEOUT:-180}"
RTSP_PORT="${OPENVMS_RTSP_PORT:-8554}"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/openvms"
log_file=''
say() {
  printf '[OpenVMS] %s\n' "$*"
  if [ -n "$log_file" ]; then printf '[OpenVMS] %s\n' "$*" >> "$log_file"; fi
}
die() {
  local message="$1" rc="${2:-1}"
  printf 'Erro: %s\n' "$message" >&2
  if [ -n "$log_file" ]; then
    printf 'Erro: %s\n' "$message" >> "$log_file" || true
    printf 'Log: %s\n' "$log_file" >&2
  fi
  exit "$rc"
}
# Não registre a configuração renderizada nem o ambiente. O filtro também
# protege os valores do PostgreSQL antes de exibir e gravar a saída do Compose.
redact_compose() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line//"$pg_url"/[OCULTO]}
    line=${line//"$pg_password"/[OCULTO]}
    if [ -n "${OPENVMS_PG_URL:-}" ]; then line=${line//"$OPENVMS_PG_URL"/[OCULTO]}; fi
    if [ -n "${OPENVMS_PG_PASSWORD:-}" ]; then line=${line//"$OPENVMS_PG_PASSWORD"/[OCULTO]}; fi
    printf '%s\n' "$line"
  done
}
run_phase() {
  local phase="$1" limit="$2" rc
  local -a statuses
  shift 2
  say "${phase} (limite: ${limit}s)..."
  if (cd "$INSTALL_DIR" && timeout --signal=TERM --kill-after=30s "${limit}s" \
    "${DOCKER[@]}" compose --progress plain "$@") 2>&1 | redact_compose | tee -a "$log_file"; then
    return 0
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  rc="${statuses[0]}"
  if (( rc == 0 )); then die "Falha ao gravar o log da fase: $phase."; fi
  die "$phase falhou (código $rc). Após corrigir a causa, execute novamente no mesmo diretório. Não apague .env, banco ou gravações." "$rc"
}
require_sudo() {
  command -v sudo >/dev/null 2>&1 || die "Sem permissão de escrita; instale sudo ou escolha um diretório gravável."
  sudo -v || die "Não foi possível obter permissão via sudo."
}
# Escolha a permissão pelo diretório existente mais próximo, sem usar sudo quando desnecessário.
fs_for_path() {
  local ancestor="$1"
  while [ ! -e "$ancestor" ]; do ancestor="$(dirname "$ancestor")"; done
  FS=()
  if [ ! -w "$ancestor" ]; then require_sudo; FS=(sudo); fi
}
valid_dir() {
  [[ "$1" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* ]] || die "$2 deve ser um caminho absoluto sem quebras de linha."
}
[ "$(uname -s)" = Linux ] || die "Somente Linux é suportado."
(umask 077; mkdir -p -- "$log_dir") || die "Não foi possível criar o diretório de logs em $log_dir."
log_file="$(mktemp "$log_dir/install.XXXXXXXX.log")" || die "Não foi possível criar o log em $log_dir."
say "Log: $log_file"
valid_dir "$INSTALL_DIR" OPENVMS_INSTALL_DIR
valid_dir "$MEDIA_DIR" OPENVMS_MEDIA_DIR
for limit in "$BUILD_TIMEOUT" "$START_TIMEOUT" "$HEALTH_TIMEOUT"; do
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || die "Timeouts devem ser inteiros positivos em segundos."
done
if [[ ! "$RTSP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$RTSP_PORT > 65535 )); then
  die "OPENVMS_RTSP_PORT deve estar entre 1 e 65535."
fi
for cmd in git docker curl timeout; do
  command -v "$cmd" >/dev/null || die "Instale $cmd primeiro."
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ausente."
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  require_sudo
  sudo docker info >/dev/null 2>&1 || die "O daemon Docker não está acessível."
  DOCKER=(sudo docker)
fi
# Cada consulta ao daemon tem limite próprio; o prazo do loop sozinho não interrompe um Docker travado.
docker_probe() { timeout --signal=TERM --kill-after=3s 8s "${DOCKER[@]}" "$@"; }
if [ -d "$INSTALL_DIR/.git" ]; then
  origin="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null)" || die "Checkout existente sem remote origin."
  case "$origin" in
    "$REPO_URL"|https://github.com/LeonardoDiasRR/open-vms|git@github.com:LeonardoDiasRR/open-vms.git) ;;
    *) die "Checkout em $INSTALL_DIR pertence a outro repositório. Não executarei seu Compose." ;;
  esac
  say "Instalação existente em $INSTALL_DIR; não alterarei o código automaticamente."
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR já existe e não é um checkout Git."
else
  # Preflight antes de criar arquivos. Uma porta ocupada não deve deixar instalação parcial.
  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -H -ltnu)" || die "Não foi possível inspecionar as portas locais."
    for port in 7101 7102 55433 "$RTSP_PORT" 8890 9997 8189; do
      if grep -Eq "[.:]${port}[[:space:]]" <<< "$listeners"; then
        die "Porta $port já está em uso; libere-a antes da instalação."
      fi
    done
  else
    say "Aviso: ss ausente; não foi possível verificar conflitos de porta antes da instalação."
  fi
  fs_for_path "$INSTALL_DIR"
  say "Clonando o OpenVMS..."
  "${FS[@]}" mkdir -p "$(dirname "$INSTALL_DIR")"
  "${FS[@]}" git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi
[ -f "$INSTALL_DIR/docker-compose.yml" ] || die "Compose não encontrado."
fs_for_path "$INSTALL_DIR"
[ ! -L "$INSTALL_DIR/.env" ] || die ".env não pode ser um link simbólico."
[ ! -e "$INSTALL_DIR/.env" ] || [ -f "$INSTALL_DIR/.env" ] || die ".env não é um arquivo regular."
if [ ! -f "$INSTALL_DIR/.env" ]; then
  command -v openssl >/dev/null || die "openssl é necessário para criar um segredo."
  password="$(openssl rand -hex 32)"
  env_tmp="$("${FS[@]}" mktemp "$INSTALL_DIR/.env.tmp.XXXXXXXX")" || die "Não foi possível criar o .env temporário."
  trap 'if [ -n "${env_tmp:-}" ]; then "${FS[@]}" rm -f -- "$env_tmp"; fi' EXIT
  printf 'OPENVMS_PG_PASSWORD=%s\nOPENVMS_PG_URL=postgres://postgres:%s@127.0.0.1:55433/openvms\nOVMS_MEDIA_PATH=%s\n' "$password" "$password" "$MEDIA_DIR" | "${FS[@]}" tee "$env_tmp" >/dev/null
  unset password
  "${FS[@]}" chown "$(id -u):$(id -g)" "$env_tmp"
  "${FS[@]}" ln -T -- "$env_tmp" "$INSTALL_DIR/.env" || die "Não foi possível publicar .env sem sobrescrever um arquivo existente."
  "${FS[@]}" rm -f -- "$env_tmp"
  env_tmp=''
  say "Credenciais geradas em $INSTALL_DIR/.env (permissão restrita)."
else
  say "Preservando $INSTALL_DIR/.env."
fi
# Nunca interprete .env como shell: ela pode conter texto que executaria comandos.
# O Compose aceita valores entre aspas; remova apenas as aspas externas.
unquote_env() {
  REPLY="$1"
  case "$REPLY" in
    \"*\"|\'*\') REPLY="${REPLY:1:${#REPLY}-2}" ;;
  esac
}
if [ -r "$INSTALL_DIR/.env" ]; then
  env_text="$(< "$INSTALL_DIR/.env")"
else
  require_sudo
  env_text="$(sudo cat "$INSTALL_DIR/.env")" || die "Não foi possível ler .env."
fi
pg_password='' pg_url='' env_media=''
while IFS= read -r entry; do
  case "$entry" in
    OPENVMS_PG_PASSWORD=*) unquote_env "${entry#*=}"; pg_password="$REPLY" ;;
    OPENVMS_PG_URL=*) unquote_env "${entry#*=}"; pg_url="$REPLY" ;;
    OVMS_MEDIA_PATH=*) unquote_env "${entry#*=}"; env_media="$REPLY" ;;
  esac
done <<< "$env_text"
unset env_text
[[ -n "$pg_password" && -n "$pg_url" && -n "$env_media" ]] || die ".env incompleto: configure OPENVMS_PG_PASSWORD, OPENVMS_PG_URL e OVMS_MEDIA_PATH."
[[ "$pg_url" == postgres://* || "$pg_url" == postgresql://* ]] || die "OPENVMS_PG_URL inválida."
valid_dir "$env_media" OVMS_MEDIA_PATH
if [ "${OPENVMS_MEDIA_DIR+x}" ] && [ "$MEDIA_DIR" != "$env_media" ]; then
  die "OPENVMS_MEDIA_DIR difere de OVMS_MEDIA_PATH existente; ajuste .env explicitamente."
fi
MEDIA_DIR="$env_media"
unset env_media REPLY
mode="$(stat -c %a "$INSTALL_DIR/.env")" || die "Não foi possível ler permissões de .env."
if [ "$mode" != 600 ]; then
  if [ ! -O "$INSTALL_DIR/.env" ]; then
    require_sudo
    sudo chmod 600 "$INSTALL_DIR/.env"
  else
    "${FS[@]}" chmod 600 "$INSTALL_DIR/.env"
  fi
  say "Permissões de .env corrigidas para 600."
fi
if [ -e "$MEDIA_DIR" ]; then
  [ -d "$MEDIA_DIR" ] || die "$MEDIA_DIR existe e não é um diretório."
  say "Preservando proprietário e permissões do destino de gravações existente."
else
  fs_for_path "$MEDIA_DIR"
  "${FS[@]}" mkdir -p "$MEDIA_DIR"
  "${FS[@]}" chown "$(id -u):$(id -g)" "$MEDIA_DIR"
  "${FS[@]}" chmod 700 "$MEDIA_DIR"
fi
fs_for_path "$INSTALL_DIR"
if [ ! -e "$INSTALL_DIR/conf/config.yaml" ]; then
  if [ -e "$INSTALL_DIR/config.yaml" ]; then
    say "Instalação antiga: movendo config.yaml para conf/config.yaml."
    "${FS[@]}" mkdir -p "$INSTALL_DIR/conf"
    "${FS[@]}" mv "$INSTALL_DIR/config.yaml" "$INSTALL_DIR/conf/config.yaml"
  else
    die "Arquivo conf/config.yaml ausente."
  fi
fi
say "Validando Compose..."
# Erros de interpretação podem conter valores de .env. Não inclua essa saída no log.
if (cd "$INSTALL_DIR" && docker_probe compose config --quiet) >/dev/null 2>&1; then
  :
else
  rc=$?
  die "Validação do Compose falhou (código $rc). Confira 'docker compose config --quiet' em $INSTALL_DIR." "$rc"
fi
run_phase "Construção das imagens" "$BUILD_TIMEOUT" build
run_phase "Inicialização dos serviços" "$START_TIMEOUT" up -d --no-build
say "Verificando a publicação da interface e a saúde dos serviços..."
# O Compose em modo detached não espera o dist copiar a UI nem a API ficar saudável.
deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  dist_id="$(cd "$INSTALL_DIR" && docker_probe compose ps -a -q dist)" || die "Timeout ao consultar o serviço dist."
  if [ -n "$dist_id" ]; then
    dist_state="$(docker_probe inspect --format '{{.State.Status}}' "$dist_id")" || die "Timeout ao consultar o serviço dist."
    if [ "$dist_state" = exited ]; then
      dist_exit="$(docker_probe inspect --format '{{.State.ExitCode}}' "$dist_id")" || die "Timeout ao consultar o serviço dist."
      [ "$dist_exit" = 0 ] || die "A publicação da interface (dist) terminou com código $dist_exit."
      break
    fi
  fi
  sleep 1
done
[ "${dist_state:-}" = exited ] || die "A publicação da interface não terminou em ${HEALTH_TIMEOUT}s."
while (( SECONDS < deadline )); do
  api_id="$(cd "$INSTALL_DIR" && docker_probe compose ps -a -q api)" || die "Timeout ao consultar o serviço api."
  web_id="$(cd "$INSTALL_DIR" && docker_probe compose ps -a -q web)" || die "Timeout ao consultar o serviço web."
  if [ -n "$api_id" ] && [ -n "$web_id" ] \
    && [ "$(docker_probe inspect --format '{{.State.Health.Status}}' "$api_id")" = healthy ] \
    && [ "$(docker_probe inspect --format '{{.State.Status}}' "$web_id")" = running ] \
    && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:7101/api/v1/health \
    && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:7102/; then
    say "Instalação validada: API saudável e interface acessível."
    say "Interface web: http://IP_DO_SERVIDOR:7102"
    say "Altere a senha inicial do administrador no primeiro acesso."
    exit 0
  fi
  sleep 1
done
(cd "$INSTALL_DIR" && docker_probe compose ps) >&2 || true
die "Serviços não ficaram saudáveis em ${HEALTH_TIMEOUT}s. Confira o status e os logs em $INSTALL_DIR."
