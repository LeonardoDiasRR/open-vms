#!/usr/bin/env bash
# Não exponha credenciais se o operador executar bash -x.
set +x
set -Eeuo pipefail
REPO_URL="https://github.com/LeonardoDiasRR/open-vms.git"
INSTALL_DIR="${OPENVMS_INSTALL_DIR:-/opt/openvms}"
MEDIA_DIR="${OPENVMS_MEDIA_DIR:-$INSTALL_DIR/archive}"
BRANCH="${OPENVMS_REF:-main}"
VARIANT="${OPENVMS_VARIANT:-auto}"
PULL_TIMEOUT="${OPENVMS_PULL_TIMEOUT:-900}"
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
select_compose() {
  local variant="$1"
  image="$cpu_image"
  FILES=(-f docker-compose.yml -f deploy/compose.ghcr.yml)
  if [[ "$variant" == gpu ]]; then
    image="$gpu_image"
    FILES+=(-f deploy/compose.nvidia.yml)
  fi
  if [[ "${DOCKER[0]}" == sudo ]]; then
    COMPOSE=(sudo env "OPENVMS_IMAGE=$image" "${DOCKER[@]:1}" compose)
  else
    COMPOSE=(env "OPENVMS_IMAGE=$image" docker compose)
  fi
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
    COMPOSE+=(--project-name "$COMPOSE_PROJECT_NAME")
  fi
  COMPOSE+=(--env-file .env "${FILES[@]}")
}
compose_probe() {
  (cd "$INSTALL_DIR" && timeout --signal=TERM --kill-after=3s 8s "${COMPOSE[@]}" "$@")
}
run_compose() {
  local limit="$1" rc
  local -a statuses
  shift
  if (cd "$INSTALL_DIR" && timeout --signal=TERM --kill-after=3s "${limit}s" \
    "${COMPOSE[@]}" --progress plain "$@") 2>&1 | redact_compose | tee -a "$log_file"; then
    return 0
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  rc="${statuses[0]}"
  if (( statuses[1] != 0 || statuses[2] != 0 )); then
    die "Não foi possível registrar a saída do Compose."
  fi
  return "$rc"
}
pull_images() {
  local remaining first_line rc output
  while :; do
    remaining=$((pull_deadline - SECONDS))
    (( remaining > 0 )) || die "Download das imagens excedeu o limite de ${PULL_TIMEOUT}s." 124
    first_line=$(( $(wc -l < "$log_file") + 1 ))
    say "Download das imagens (limite restante: ${remaining}s)..."
    if run_compose "$remaining" pull "$@"; then return 0; else rc=$?; fi
    output="$(tail -n "+$first_line" "$log_file")"
    if (( pull_retried == 0 && SECONDS < pull_deadline )) && \
      ! grep -Eqi 'denied|unauthorized|manifest unknown|not found|no matching manifest|no space left|certificate' <<< "$output" && \
      { [[ "$rc" == 124 ]] || grep -Eqi 'timeout|timed out|connection (reset|refused)|temporary failure|TLS handshake|unexpected EOF|service unavailable|bad gateway|HTTP[^[:digit:]]*(502|503|504)' <<< "$output"; }; then
      pull_retried=1
      say "Falha transitória no download. Nova tentativa."
      continue
    fi
    die "Download das imagens falhou (código $rc). Nenhum serviço foi iniciado ou recriado. Corrija a causa e execute novamente neste diretório." "$rc"
  done
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
case "$VARIANT" in auto|cpu|gpu) ;; *) die "OPENVMS_VARIANT deve ser auto, cpu ou gpu." ;; esac
for limit in "$PULL_TIMEOUT" "$START_TIMEOUT" "$HEALTH_TIMEOUT"; do
  [[ "$limit" =~ ^[1-9][0-9]{0,5}$ ]] || die "Timeouts devem ser inteiros positivos em segundos, com até seis dígitos."
done
if [[ ! "$RTSP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$RTSP_PORT > 65535 )); then
  die "OPENVMS_RTSP_PORT deve estar entre 1 e 65535."
fi
for cmd in git docker curl timeout; do
  command -v "$cmd" >/dev/null || die "Instale $cmd primeiro."
done
# Cada consulta ao daemon tem limite próprio.
docker_probe() { timeout --signal=TERM --kill-after=3s 8s "${DOCKER[@]}" "$@"; }
case "${DOCKER_HOST:-}" in ''|unix://*) ;; *) die "Use um daemon Docker local com socket Unix." ;; esac
endpoint="$(timeout 8s docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || die "Não foi possível consultar o contexto Docker."
if [[ -n "${DOCKER_CONTEXT:-}" || -z "${DOCKER_HOST:-}" ]]; then
  [[ "$endpoint" == unix://* ]] || die "Use um contexto Docker local com socket Unix."
fi
if timeout --kill-after=3s 8s docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  [[ -z "${DOCKER_CONTEXT:-}${DOCKER_HOST:-}" && "$endpoint" == unix:///var/run/docker.sock ]] || die "O daemon Docker do contexto selecionado não está acessível."
  require_sudo
  DOCKER=(sudo docker --host "$endpoint")
fi
docker_platform="$(docker_probe info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null)" || die "O daemon Docker não está acessível."
case "$docker_platform" in linux/x86_64) docker_platform=linux/amd64 ;; esac
[[ "$docker_platform" == linux/amd64 ]] || die "Plataforma Docker sem imagem publicada: $docker_platform (é necessário linux/amd64)."
[[ -z "${DOCKER_DEFAULT_PLATFORM:-}" || "$DOCKER_DEFAULT_PLATFORM" == "$docker_platform" ]] || \
  die "DOCKER_DEFAULT_PLATFORM difere da plataforma publicada ($docker_platform)."
for key in COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE COMPOSE_REMOVE_ORPHANS \
    OPENVMS_PG_PASSWORD OPENVMS_PG_URL OVMS_MEDIA_PATH; do
  [[ -z "${!key:-}" ]] || die "$key não pode ser definido no ambiente do instalador. Use apenas a configuração indicada no README."
done
docker_probe compose version >/dev/null 2>&1 || die "Plugin Docker Compose ausente."
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
for file in docker-compose.yml deploy/compose.ghcr.yml deploy/compose.nvidia.yml deploy/images.env; do
  [ -r "$INSTALL_DIR/$file" ] || die "Checkout sem $file. Selecione uma referência compatível com imagens do GHCR. O instalador não atualiza checkouts existentes."
done
for file in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
  [[ ! -e "$INSTALL_DIR/$file" && ! -L "$INSTALL_DIR/$file" ]] || die "Complemento local $file encontrado. Valide a configuração personalizada antes de migrar para imagens do GHCR."
done
# O manifesto declara dados, não comandos. Aceite somente os campos publicados.
declare -A release=()
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in ''|'#'*) continue ;; esac
  key=${line%%=*}
  case "$key" in
    OPENVMS_IMAGE_SOURCE|OPENVMS_IMAGE_PLATFORM|OPENVMS_IMAGE_PREVIEW|OPENVMS_IMAGE_CPU|OPENVMS_IMAGE_GPU) ;;
    *) die "Campo inválido em deploy/images.env." ;;
  esac
  [[ "$line" == *=* && ! -v release[$key] ]] || die "Campo inválido ou duplicado em deploy/images.env."
  release[$key]=${line#*=}
done < "$INSTALL_DIR/deploy/images.env"
source_revision="${release[OPENVMS_IMAGE_SOURCE]:-}"
image_preview="${release[OPENVMS_IMAGE_PREVIEW]:-}"
cpu_image="${release[OPENVMS_IMAGE_CPU]:-}"
gpu_image="${release[OPENVMS_IMAGE_GPU]:-}"
image_pattern='^ghcr\.io/leonardodiasrr/open-vms@sha256:[0-9a-f]{64}$'
[[ "$source_revision" =~ ^[0-9a-f]{40}$ && "$image_preview" =~ ^[01]$ && \
   "${release[OPENVMS_IMAGE_PLATFORM]:-}" == "$docker_platform" && \
   "$cpu_image" =~ $image_pattern && "$gpu_image" =~ $image_pattern && "$cpu_image" != "$gpu_image" ]] || die "Manifesto de imagens inválido para $docker_platform."
# Um manifesto antigo não torna um checkout novo compatível com a imagem.
git -C "$INSTALL_DIR" diff --quiet "$source_revision" HEAD -- client server conf/config.yaml \
  docker-compose.yml deploy/mediamtx.yml deploy/nginx.conf || \
  die "A revisão do checkout é incompatível com o manifesto GHCR ou seu histórico está incompleto. Use uma referência publicada compatível."
git -C "$INSTALL_DIR" diff --quiet HEAD -- docker-compose.yml deploy/mediamtx.yml deploy/nginx.conf || \
  die "Configuração Compose, Nginx ou MediaMTX alterada no checkout. Valide a migração manualmente."
existing_stack="$(docker_probe ps -aq --filter 'name=^/ovms-(api|dist|pg|rtsp|web)$' 2>/dev/null)" || \
  die "Não foi possível identificar contêineres OpenVMS no Docker."
known_data=''
for volume in ovms-pg-data ovms-data; do
  ids="$(docker_probe volume ls -q --filter "label=com.docker.compose.volume=$volume" 2>/dev/null)" || \
    die "Não foi possível identificar volumes OpenVMS no Docker."
  known_data+="$ids"
done
fs_for_path "$INSTALL_DIR"
[ ! -L "$INSTALL_DIR/.env" ] || die ".env não pode ser um link simbólico."
[ ! -e "$INSTALL_DIR/.env" ] || [ -f "$INSTALL_DIR/.env" ] || die ".env não é um arquivo regular."
if [ ! -f "$INSTALL_DIR/.env" ]; then
  [[ -z "$existing_stack$known_data" ]] || die "Há contêineres ou volumes OpenVMS sem .env. Restaure a configuração original. Não gere novas credenciais."
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
say "Validando Compose..."
select_compose cpu
compose_probe config --quiet >/dev/null 2>&1 || \
  die "Validação do Compose falhou. Use Docker Compose v2 com suporte a !reset. Confira os arquivos e .env sem expor credenciais."
# Leia do Compose o valor efetivo, inclusive aspas e precedência de .env.
effective_env="$(compose_probe config --environment 2>/dev/null)" || die "Não foi possível consultar o ambiente do Compose."
if grep -Eq '^COMPOSE_FILE=.+' <<< "$effective_env"; then
  die "COMPOSE_FILE personalizado não é suportado pelo instalador do GHCR."
fi
if grep -Eq '^COMPOSE_(ENV_FILES|DISABLE_ENV_FILE|REMOVE_ORPHANS)=.+' <<< "$effective_env"; then
  die "Configuração Compose de ambiente ou remoção de órfãos não aceita no .env."
fi
compose_value() {
  local entry
  entry="$(grep "^$1=" <<< "$effective_env" || true)"
  [[ "$entry" != *$'\n'* ]] || return 1
  printf '%s' "${entry#*=}"
}
[[ "$(compose_value OVMS_MEDIA_PATH)" == "$MEDIA_DIR" && \
   "$(compose_value OPENVMS_PG_PASSWORD)" == "$pg_password" && \
   "$(compose_value OPENVMS_PG_URL)" == "$pg_url" ]] || \
  die "O Compose não resolveu as credenciais ou o destino de gravações declarados no .env. Corrija o arquivo sem expor seus valores."
preview="$(compose_value OPENVMS_PLAYBACK_PREVIEW)" || die "OPENVMS_PLAYBACK_PREVIEW duplicado."
unset effective_env
[[ "${preview:-0}" == "$image_preview" ]] || die "OPENVMS_PLAYBACK_PREVIEW é incompatível com a imagem publicada. A interface usa o valor fixado no build ($image_preview)."
existing_api="$(compose_probe ps -a -q api 2>/dev/null)" || die "Timeout ou falha ao consultar o serviço api."
[[ -n "$existing_api" || -z "$existing_stack$known_data" ]] || \
  die "Há contêineres ou volumes OpenVMS, mas a API deste projeto não foi encontrada. Recupere a API original antes de reinstalar."
selected="$VARIANT"
if [[ -n "$existing_api" ]]; then
  installed_image="$(docker_probe inspect --format '{{.Config.Image}}' "$existing_api" 2>/dev/null)" || die "Não foi possível identificar a imagem da API existente."
  case "$installed_image" in
    "$cpu_image") installed_variant=cpu ;;
    "$gpu_image") installed_variant=gpu ;;
    *) die "A instalação usa outra versão ou uma imagem local. Planeje a migração antes de substituir a imagem da API." ;;
  esac
  [[ "$VARIANT" == auto || "$VARIANT" == "$installed_variant" ]] || die "A instalação usa $installed_variant. Planeje a troca de variante antes de recriar a API."
  selected="$installed_variant"
elif [[ "$VARIANT" == auto ]]; then
  if command -v nvidia-smi >/dev/null && timeout --kill-after=3s 8s nvidia-smi -L >/dev/null 2>&1; then
    selected=gpu
  else
    selected=cpu
    say "GPU NVIDIA não detectada pelo driver. Usando CPU."
  fi
fi
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
pull_deadline=$((SECONDS + PULL_TIMEOUT))
pull_retried=0
select_compose "$selected"
if [[ "$selected" == gpu ]]; then
  compose_probe config --quiet >/dev/null 2>&1 || die "Validação do Compose NVIDIA falhou."
  pull_images --policy missing api
  if nvenc_log="$(timeout --signal=TERM --kill-after=3s 30s "${DOCKER[@]}" run \
    --rm --network none --gpus 1 --pull never --entrypoint ffmpeg "$image" \
    -nostdin -hide_banner -loglevel error -f lavfi -i color=c=black:s=128x128:r=5 \
    -frames:v 2 -c:v h264_nvenc -f null - 2>&1)"; then
    say "Codificação NVIDIA NVENC verificada."
  else
    rc=$?
    if { [[ "$rc" == 1 ]] && grep -Eqi 'Cannot load lib(cuda|nvidia-encode)|No NVENC capable devices|No capable devices found|driver does not support.*nvenc|minimum required.*driver|OpenEncodeSessionEx failed|Cannot init CUDA' <<< "$nvenc_log"; } || \
      { [[ "$rc" == 125 ]] && grep -Eqi 'could not select device driver|nvidia-container-(cli|runtime)|unresolvable CDI devices' <<< "$nvenc_log"; }; then
      printf '%s\n' "$nvenc_log" | redact_compose | tee -a "$log_file" >&2
      if [[ "$VARIANT" != auto || -n "$existing_api" ]]; then
        die "NVENC indisponível. Confira a GPU, o driver e o NVIDIA Container Toolkit." "$rc"
      fi
      say "NVENC indisponível no contêiner. Usando CPU."
      selected=cpu
      select_compose cpu
    else
      printf '%s\n' "$nvenc_log" | redact_compose | tee -a "$log_file" >&2
      die "Falha ao executar a sonda NVIDIA no Docker (código $rc). Nenhum serviço foi iniciado." "$rc"
    fi
  fi
fi
say "Variante: $selected. Imagem: $image"
up_args=(-d --no-build --pull never --remove-orphans=false)
if [[ -n "$existing_api" ]]; then
  for service in postgres mediamtx web; do
    service_id="$(compose_probe ps -a -q "$service" 2>/dev/null)" || die "Não foi possível consultar o serviço $service."
    [[ -n "$service_id" ]] || die "O serviço $service falta na instalação existente. Recupere-o antes de reinstalar."
  done
  # Não baixe tags auxiliares nem recrie contêineres nesta reexecução.
  pull_images --policy missing api dist
  up_args+=(--no-recreate)
else
  pull_images
fi
expected_image_id="$(docker_probe image inspect --format '{{.Id}}' "$image" 2>/dev/null)" || die "Imagem selecionada indisponível após o download."
actual_revision="$(docker_probe image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null)" || die "Não foi possível consultar a revisão da imagem."
[[ "$actual_revision" == "$source_revision" ]] || die "A revisão da imagem não corresponde a deploy/images.env."
say "Inicialização dos serviços (limite: ${START_TIMEOUT}s)..."
run_compose "$START_TIMEOUT" up "${up_args[@]}" || \
  die "Inicialização dos serviços falhou (código $?). Contêineres podem ter sido criados ou alterados. Preserve .env, banco e gravações." "$?"
say "Verificando a publicação da interface e a saúde dos serviços..."
# O Compose em modo detached não espera o dist copiar a UI nem a API ficar saudável.
deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  dist_id="$(compose_probe ps -a -q dist)" || die "Timeout ao consultar o serviço dist."
  if [ -n "$dist_id" ]; then
    dist_state="$(docker_probe inspect --format '{{.State.Status}}' "$dist_id")" || die "Timeout ao consultar o serviço dist."
    if [ "$dist_state" = exited ]; then
      dist_exit="$(docker_probe inspect --format '{{.State.ExitCode}}' "$dist_id")" || die "Timeout ao consultar o serviço dist."
      [ "$dist_exit" = 0 ] || die "A publicação da interface (dist) terminou com código $dist_exit."
      [[ "$(docker_probe inspect --format '{{.Image}}' "$dist_id")" == "$expected_image_id" ]] || die "O serviço dist não publicou a interface da imagem selecionada."
      break
    fi
  fi
  sleep 1
done
[ "${dist_state:-}" = exited ] || die "A publicação da interface não terminou em ${HEALTH_TIMEOUT}s."
web_matches_image() {
  local index expected_index asset served_sha expected_sha
  local asset_pattern='src="(/assets/[A-Za-z0-9_.-]+\.js)"'
  index="$(curl -fsS --max-time 3 http://127.0.0.1:7102/)" || return 1
  expected_index="$(docker_probe exec "$api_id" cat /app/client/dist/index.html)" || return 1
  [[ "$index" == "$expected_index" && "$index" =~ $asset_pattern ]] || return 1
  asset="${BASH_REMATCH[1]}"
  expected_sha="$(docker_probe exec "$api_id" sha256sum "/app/client/dist$asset")" || return 1
  served_sha="$(curl -fsS --max-time 5 "http://127.0.0.1:7102$asset" | sha256sum)" || return 1
  [[ "${served_sha%% *}" == "${expected_sha%% *}" ]]
}
while (( SECONDS < deadline )); do
  api_id="$(compose_probe ps -a -q api)" || die "Timeout ao consultar o serviço api."
  web_id="$(compose_probe ps -a -q web)" || die "Timeout ao consultar o serviço web."
  if [ -n "$api_id" ] && [ -n "$web_id" ] \
    && [ "$(docker_probe inspect --format '{{.State.Health.Status}}' "$api_id")" = healthy ] \
    && [ "$(docker_probe inspect --format '{{.State.Status}}' "$web_id")" = running ] \
    && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:7101/api/v1/health; then
    [[ "$(docker_probe inspect --format '{{.Image}}' "$api_id")" == "$expected_image_id" ]] || die "A API não está executando a imagem selecionada."
    if web_matches_image; then
      say "Instalação validada: API saudável e interface da imagem selecionada acessível."
      say "Interface web: http://IP_DO_SERVIDOR:7102"
      say "Altere a senha inicial do administrador no primeiro acesso."
      exit 0
    fi
  fi
  sleep 1
done
compose_probe ps >&2 || true
die "Serviços não ficaram saudáveis ou a interface não corresponde à imagem em ${HEALTH_TIMEOUT}s. Confira o status e os logs em $INSTALL_DIR."
