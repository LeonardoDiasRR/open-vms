#!/usr/bin/env bash
set -Eeuo pipefail
REPO_URL="https://github.com/LeonardoDiasRR/open-vms.git"
INSTALL_DIR="${OPENVMS_INSTALL_DIR:-/opt/openvms}"
MEDIA_DIR="${OPENVMS_MEDIA_DIR:-$INSTALL_DIR/archive}"
BRANCH="${OPENVMS_REF:-main}"
say() { printf '\033[1;36m[OpenVMS]\033[0m %s\n' "$*"; }
die() { printf 'Erro: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null || die "Instale git primeiro."
command -v docker >/dev/null || die "Docker Engine ausente. Consulte https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ausente."
[ "$(uname -s)" = Linux ] || die "Somente Linux é suportado."
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -v && sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  die "O daemon Docker não está acessível."
fi
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Instalação existente em $INSTALL_DIR; não alterarei o código automaticamente."
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR já existe e não é um checkout Git."
else
  say "Clonando o OpenVMS..."
  sudo mkdir -p "$(dirname "$INSTALL_DIR")"
  sudo git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi
[ -f "$INSTALL_DIR/docker-compose.yml" ] || die "Compose não encontrado."
if [ ! -f "$INSTALL_DIR/.env" ]; then
  command -v openssl >/dev/null || die "openssl é necessário para criar um segredo."
  password="$(openssl rand -hex 32)"
  sudo sh -c 'umask 077; touch "$1"' sh "$INSTALL_DIR/.env"
  printf 'OPENVMS_PG_PASSWORD=%s\nOPENVMS_PG_URL=postgres://postgres:%s@127.0.0.1:55433/openvms\nOVMS_MEDIA_PATH=%s\n' "$password" "$password" "$MEDIA_DIR" | sudo tee "$INSTALL_DIR/.env" >/dev/null
  unset password
  sudo chown "$(id -u):$(id -g)" "$INSTALL_DIR/.env"
  say "Credenciais geradas em $INSTALL_DIR/.env (permissão restrita)."
else
  say "Preservando $INSTALL_DIR/.env."
fi
sudo mkdir -p "$MEDIA_DIR"
sudo chown "$(id -u):$(id -g)" "$MEDIA_DIR"
sudo chmod 700 "$MEDIA_DIR"
if [ ! -e "$INSTALL_DIR/config.yaml" ]; then
  die "Arquivo config.yaml ausente."
fi
say "Validando Compose..."
(cd "$INSTALL_DIR" && "${DOCKER[@]}" compose config --quiet)
say "Construindo e iniciando serviços (pode levar alguns minutos)..."
(cd "$INSTALL_DIR" && "${DOCKER[@]}" compose up -d --build)
say "Instalação iniciada."
say "Interface web: http://IP_DO_SERVIDOR:7102"
say "Altere a senha inicial do administrador no primeiro acesso."
