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

## Installation

Requirements: a Linux host with Docker and Docker Compose.

```bash
curl -fsSL https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh | bash
```

The installer clones the repository to `/opt/openvms`, creates `.env` with a
random password, and stores recordings under `<install-dir>/archive/`. It
installs the CLI at `/usr/local/bin/openvms`. Set `OPENVMS_INSTALL_DIR`,
`OPENVMS_MEDIA_DIR` and `OPENVMS_REF` when you run a downloaded script. The
media directory must live on a local file system. On NFS with root squash,
the container user (root) is mapped to `nobody` and mode 700 blocks writes
with `EACCES`. To record to an NFS share, mount it on the host, point
`OVMS_MEDIA_PATH` in `.env` to it, and set the directory permissions
manually. PostgreSQL is published only on `127.0.0.1:55433` of the host. The
web interface runs on port **7102** (HTTP; configure TLS or a reverse proxy
before exposing it to the Internet).

Open `http://<host>:7102`, sign in as `admin` with the factory password and
set a new one — the change is mandatory at the first login.

Recordings are stored under `<install-dir>/archive/` by default (example:
`/opt/openvms/archive/`). Set `OPENVMS_MEDIA_DIR` before the install, or
`OVMS_MEDIA_PATH` in `.env` later, to use another location.

## CLI

```bash
openvms status
openvms logs api
openvms doctor
openvms start
openvms stop
openvms restart
openvms update
openvms backup /safe/path/backup.tar.gz
```

`openvms update` requires a clean Git checkout, confirms the operation,
fast-forwards and rebuilds the stack. **Back up before you update.** The
`backup` command saves the logical PostgreSQL dump, `config.yaml` and `.env`
(which holds secrets). It does **not** include videos, the playback cache or
auxiliary volumes. Keep your own procedure for volumes and recording files.
The installer keeps an existing `.env` and never runs `git pull`
automatically.

> The installer uses the images defined in the Compose file and builds
> locally. Publishing pre-built images on GHCR may come later.

## Known limitations

Use Chrome. Other browsers need an extension or specific hardware to decode
H.265 camera streams.
