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

![OpenVMS architecture: MediaMTX hub, live view, RTSP restream and recorder](docs/arquitetura.jpg)

## Installation

Requirements: a Linux `amd64` host with Docker and the Docker Compose plugin
(v2.24.4 or later). One command installs everything:

```bash
curl -fsSL https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh | bash
```

`install.sh` does the following:

- Clones the `main` branch to `/opt/openvms`.
- Downloads the prebuilt OpenVMS image from GHCR by digest. It does not
  compile code and it does not ask for a login.
- Chooses the NVIDIA image when the NVENC encoding test passes. It chooses
  the CPU image otherwise. It also downloads PostgreSQL, Nginx, and
  MediaMTX.
- Creates `/opt/openvms/.env` with a random database password. Recordings
  go to `/opt/openvms/archive/` by default.
- Starts the services and confirms that the API and the web interface are
  healthy before it reports success.

To force one variant, put the variable before `bash`:

```bash
curl -fsSL https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh | OPENVMS_VARIANT=cpu bash
curl -fsSL https://raw.githubusercontent.com/LeonardoDiasRR/open-vms/main/install.sh | OPENVMS_VARIANT=gpu bash
```

The NVIDIA variant requires a GPU with NVENC support, a compatible NVIDIA
driver, and the [NVIDIA Container Toolkit][nvidia-toolkit].

[nvidia-toolkit]: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html

### Options

- `OPENVMS_INSTALL_DIR` — installation directory (default `/opt/openvms`).
- `OPENVMS_MEDIA_DIR` — recording directory, set before install (default
  `<install-dir>/archive/`).
- `OPENVMS_PULL_TIMEOUT` (900), `OPENVMS_START_TIMEOUT` (300),
  `OPENVMS_HEALTH_TIMEOUT` (180) — phase limits in seconds.

The installer never runs `git pull` on an existing checkout and never
replaces its variant, digest, database, or recordings.

Use a local file system for the recording directory during installation.
To use an NFS share, mount it on the host, set `OVMS_MEDIA_PATH` in `.env`,
and set permissions that let the container write.

### First sign-in

Open `http://<host>:7102`. Sign in as `admin` with the initial password
`admin`. Set a new password when prompted.

The web interface uses HTTP. Configure HTTPS before you expose it to the
Internet. PostgreSQL listens on the host only at `127.0.0.1:55433`.

### Existing installations and recovery

The installer does not update an existing checkout. Update an older
checkout manually to a compatible release before you run the installer.

The installer does not migrate an active installation that uses a local
build. Schedule a separate maintenance window for that migration.

For an existing GHCR installation, the installer keeps the installed
variant and image digest or stops. It does not refresh the PostgreSQL,
Nginx, or MediaMTX image tags. It does not replace existing containers. If
the original `.env` or a required container is missing, restore it before
you run the installer again.

Keep the Git history for the revision in `deploy/images.env`. The installer
checks that the source and Compose files match the release. Keep
credentials and the recording path in `.env`. Do not override them in the
shell.

If a step fails, check the phase, exit code, and log path in the installer
output. Each run writes a log under
`${XDG_STATE_HOME:-$HOME/.local/state}/openvms/`. The installer log does
not include container logs or the rendered Compose configuration.

If startup fails, check the containers before you run the installer again.
Startup can change containers before a health check fails. Correct the
cause of the failure. Run the installer again in the same directory.

Keep `.env`, `conf/`, the key in the `ovms-data` volume, the database
volume, and the recordings. Do not use `docker compose down -v` for
recovery. The installer does not roll back database changes.

## Known limitations

Use Chrome. Other browsers need an extension or specific hardware to decode
H.265 camera streams.
