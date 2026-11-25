#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
root=$(mktemp -d "${TMPDIR:-$HOME/.cache}/openvms-ffmpeg-test.XXXXXXXX")
trap 'rm -rf -- "$root"' EXIT
cat > "$root/timeout" <<'MOCK'
#!/usr/bin/env bash
[[ "$*" == '-k 5 300 apk add --no-cache ffmpeg' ]] || exit 97
printf 'apk\n' >> "$CALLS"
case "$SCENARIO" in
  timeout) exit 124 ;;
  busybox_timeout) exit 143 ;;
  killed_timeout) exit 137 ;;
  network)
    if [[ $(< "$CALLS") == apk ]]; then
      printf 'WARNING: fetching Alpine index: DNS: transient error\n' >&2
      exit 1
    fi ;;
  permanent) printf 'ERROR: ffmpeg (no such package)\n' >&2; exit 2 ;;
  success) ;;
  *) exit 97 ;;
esac
MOCK
cat > "$root/sleep" <<'MOCK'
#!/usr/bin/env bash
[[ "$*" == 5 ]] || exit 97
printf 'sleep\n' >> "$CALLS"
MOCK
chmod +x "$root/timeout" "$root/sleep"
check() {
  local scenario="$1" expected_rc="$2" calls="$3" rc=0
  : > "$root/calls"
  PATH="$root:$PATH" SCENARIO="$scenario" CALLS="$root/calls" \
    sh "$source_dir/scripts/install-ffmpeg.sh" > "$root/result.log" 2>&1 || rc=$?
  if [[ "$rc" != "$expected_rc" || $(< "$root/calls") != "$calls" ]]; then
    printf 'FAIL %s: exit %s (expected %s)\n' "$scenario" "$rc" "$expected_rc" >&2
    exit 1
  fi
  printf 'PASS ffmpeg_%s\n' "$scenario"
}
check success 0 apk
check network 0 $'apk\nsleep\napk'
check timeout 124 $'apk\nsleep\napk'
check busybox_timeout 143 $'apk\nsleep\napk'
check killed_timeout 137 $'apk\nsleep\napk'
check permanent 2 apk
