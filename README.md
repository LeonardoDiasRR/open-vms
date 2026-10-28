# OpenVMS

A self-hosted video management system for IP cameras. Watch live, record,
review recordings and restream — all in one lightweight package you run on
your own server.

## Key features

- **Live view.** A videowall of any number of cameras in a resizable grid.
  Drag cameras onto the wall, resize cells and save layouts.
- **Recording.** Each camera records continuously, or only when it sees
  motion. Recordings are stored as standard MP4 segments with a timeline
  index that knows where the gaps are.
- **Recording player.** Browse any day on a timeline, jump between
  recordings, change playback speed, and export a period as a downloadable
  MP4.
- **RTSP restream.** Every camera gets its own RTSP address that third-party
  VMS software, NVRs or analysis tools can consume directly.

## Why it stands out

- **Simplified camera addition.** OpenVMS finds cameras by scanning an IP
  range or through ONVIF discovery, and a short wizard finishes the job.
  Credentials are stored encrypted, never in plain text.
- **Built-in PTZ control.** Pan, tilt, zoom and saved presets for PTZ cameras
  live right in the videowall cell. No vendor software needed.

## Architecture

One hub opens a single connection to each camera and restreams it to every
consumer: the live view, the recorder and third-party RTSP clients. The
camera only ever sees one client, so its load and the network traffic stay
flat no matter how many people are watching. Streams start on demand —
nothing pulls a camera when nobody is watching it.

## Known limitations

Use Chrome. Other browsers need an extension or specific hardware to decode
H.265 camera streams.

## Installation

Requirements: a Linux host with Docker and Docker Compose.

```bash
curl -fsSL https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh | bash
```

Open `http://<host>:7102`, sign in as `admin` with the factory password and
set a new one — the change is mandatory at the first login.

Recordings are stored under `/mnt/archive` by default. Set
`OVMS_MEDIA_PATH` before starting the stack to use another location.

## Instalador automatizado (Linux)

Requer **Docker Engine**, **Docker Compose v2**, `git`, `curl` e `openssl`. O instalador não modifica a instalação do Docker. As imagens da API e do frontend são construídas a partir do código do repositório.

Para revisar antes de executar (recomendado):

```bash
curl -fsSLo openvms-install.sh https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh
less openvms-install.sh
bash openvms-install.sh
```

Instalação direta:

```bash
curl -fsSL https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh | bash
```

O instalador clona para `/opt/openvms`, cria `.env` com senha aleatória, utiliza `/var/lib/openvms/recordings` para gravações e instala `/usr/local/bin/openvms`. Use `OPENVMS_INSTALL_DIR`, `OPENVMS_MEDIA_DIR` e `OPENVMS_REF` para personalizar ao executar um script baixado localmente. O PostgreSQL fica publicado apenas em `127.0.0.1:55433` do host. A interface é servida na porta **7102** (HTTP; configure TLS/reverse proxy antes de expor à Internet).

### CLI

```bash
openvms status
openvms logs api
openvms doctor
openvms start
openvms stop
openvms restart
openvms update
openvms backup /caminho/seguro/backup.tar.gz
```

`openvms update` exige checkout Git sem arquivos rastreados modificados, confirma a operação, atualiza por fast-forward e reconstrói a stack. **Faça backup antes de atualizar.** O comando `backup` salva o dump lógico do PostgreSQL, `config.yaml` e `.env` (que contém segredos); **não** inclui vídeos, cache de playback nem volumes auxiliares. Preserve também os volumes e arquivos de gravação em seu procedimento de disaster recovery. O instalador mantém `.env` existente e não faz `git pull` automaticamente.

> O instalador atual utiliza as imagens existentes definidas no Compose e executa build local; publicação de imagens pré-construídas no GHCR pode ser adicionada em uma etapa posterior.
