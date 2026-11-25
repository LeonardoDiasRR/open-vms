#!/bin/sh
set -eu

output=$(mktemp)
trap 'rm -f "$output"' EXIT

# apk usa o mesmo código para falhas de rede e de pacote. Tente de novo só
# quando a etapa estourar o prazo ou o diagnóstico indicar erro de rede.
for attempt in 1 2; do
  printf '[OpenVMS] Instalando ffmpeg (tentativa %s/2, limite: 300s)\n' "$attempt"
  if LC_ALL=C timeout -k 5 300 apk add --no-cache ffmpeg >"$output" 2>&1; then
    cat "$output"
    exit 0
  else
    rc=$?
  fi
  cat "$output" >&2
  if [ "$attempt" -eq 2 ]; then break; fi
  # GNU timeout usa 124. BusyBox usa o status de TERM (143) ou KILL (137).
  case "$rc" in
    124|137|143) ;;
    *)
      grep -Eiq 'temporary (error|failure)|transient error|DNS:|name resolution|could not resolve|network (error|is unreachable)|connection (timed out|refused|reset|aborted)|operation timed out|bad gateway|service unavailable|gateway timeout' "$output" || break
      ;;
  esac
  printf '[OpenVMS] Falha de rede ou timeout no apk (código %s); tentando de novo em 5s.\n' "$rc" >&2
  sleep 5
done
printf '[OpenVMS] Não foi possível instalar o ffmpeg (código %s).\n' "$rc" >&2
exit "$rc"
