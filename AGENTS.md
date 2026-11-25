# OpenVMS contributor instructions

## Publish both Docker images for each source change

Each source code update requires new CPU and NVIDIA GPU images. GHCR is the GitHub Container Registry.

1. Commit the source changes. Use a clean checkout of that commit for both builds.
2. Build both variants for `linux/amd64` with `Dockerfile.ghcr` and target `api`.
   - For CPU, set `OPENVMS_RUNTIME=ffmpeg` and `OPENVMS_TRANSCODE_ENCODER=libx264`.
   - For NVIDIA, set `OPENVMS_RUNTIME=ffmpeg-nvidia`.
   - For both builds, set `VITE_ARCHIVE_ADAPTIVE_PREVIEW` to the value in `OPENVMS_IMAGE_PREVIEW` in `deploy/images.env`.
3. Set `org.opencontainers.image.source` to `https://github.com/LeonardoDiasRR/open-vms`.
   Set `org.opencontainers.image.revision` to the full source commit ID. Set `io.openvms.build.dockerfile-sha256` to the SHA-256 of `Dockerfile.ghcr`.
4. Push both images to `ghcr.io/leonardodiasrr/open-vms`. Use tags `cpu-<source-sha>` and `gpu-<source-sha>`. Do not overwrite an existing version tag.
5. Verify that each image can be pulled without GHCR credentials. Record both registry digests.
   A digest identifies the exact image content. Do not use a local image ID as a registry digest.
6. Update `OPENVMS_IMAGE_SOURCE`, `OPENVMS_IMAGE_CPU`, and `OPENVMS_IMAGE_GPU` in `deploy/images.env` in a follow-up commit.
   Use full `ghcr.io/leonardodiasrr/open-vms@sha256:...` references. Do not change the source between the image builds and the manifest update.
7. Run the CPU installation and recovery test in a disposable Docker environment. Validate the NVIDIA Compose configuration.
   Report NVENC as untested if you do not verify encoding on NVIDIA hardware.

Do not merge or release a source change until both images are public, the manifest points to them, and the installation checks pass.

See [Installation](README.md#installation) for the installer commands.
