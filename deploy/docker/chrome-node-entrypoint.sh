#!/usr/bin/env bash
set -Eeuo pipefail

for name in \
  BROWSHARE_REMOTE_TAB_EXTENSION_ID \
  BROWSHARE_REMOTE_TAB_EXTENSION_UPDATE_URL \
  BROWSHARE_REMOTE_TAB_RUNTIME_SECRET; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable ${name}" >&2
    exit 1
  fi
done

# The managed policy and Standalone are launched by this same wrapper, so they can share a fresh
# generation without persisting or coordinating it outside the container.
export BROWSHARE_REMOTE_TAB_RUNTIME_GENERATION="$(cat /proc/sys/kernel/random/uuid)"

profile_directory="${BROWSHARE_REMOTE_TAB_CHROME_PROFILE:-/var/lib/browshare/chrome-profile}"
temp_root="${BROWSHARE_REMOTE_TAB_TEMP_ROOT:-/var/lib/browshare/remote-tab}"
cdp_port="$(node --input-type=module -e '
  const endpoint = new URL(process.env.BROWSHARE_REMOTE_TAB_CDP_ENDPOINT ?? "")
  const port = Number(endpoint.port || "80")
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new TypeError("Chrome node BROWSHARE_REMOTE_TAB_CDP_ENDPOINT must be a loopback HTTP origin")
  }
  process.stdout.write(String(port))
')"
mkdir -p "$profile_directory" "$temp_root" /var/log/browshare
chown -R node:node "$profile_directory" "$temp_root" /var/log/browshare
node /usr/local/lib/browshare/write-managed-policy.mjs

chrome_pid=''
standalone_pid=''

extension_installed() {
  [[ -d "$profile_directory/Default/Extensions/$BROWSHARE_REMOTE_TAB_EXTENSION_ID" ]] &&
    find "$profile_directory/Default/Extensions/$BROWSHARE_REMOTE_TAB_EXTENSION_ID" \
      -mindepth 2 -maxdepth 2 -type f -name manifest.json -print -quit | grep -q .
}

wait_for_chrome() {
  for _ in {1..200}; do
    if ! kill -0 "$chrome_pid" 2>/dev/null; then
      echo 'Google Chrome Stable exited before CDP became ready' >&2
      return 1
    fi
    if curl --fail --silent --show-error "http://127.0.0.1:${cdp_port}/json/version" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo 'Google Chrome Stable did not expose CDP within 20 seconds' >&2
  return 1
}

start_chrome() {
  gosu node google-chrome-stable \
    --headless=new \
    --enable-extensions \
    "--remote-debugging-port=${cdp_port}" \
    --remote-debugging-address=127.0.0.1 \
    --remote-allow-origins='*' \
    "--allowlisted-extension-id=${BROWSHARE_REMOTE_TAB_EXTENSION_ID}" \
    --enable-logging=stderr \
    --user-data-dir="$profile_directory" \
    --no-first-run \
    --no-default-browser-check \
    --noerrdialogs \
    --ozone-platform=headless \
    --ozone-override-screen-size=1920,1080 \
    --use-angle=swiftshader-webgl \
    about:blank \
    >>/var/log/browshare/chrome.log 2>&1 &
  chrome_pid=$!
  wait_for_chrome
}

stop_chrome() {
  [[ -z "$chrome_pid" ]] || kill -TERM "$chrome_pid" 2>/dev/null || true
  [[ -z "$chrome_pid" ]] || wait "$chrome_pid" 2>/dev/null || true
  chrome_pid=''
}

terminate() {
  [[ -z "$standalone_pid" ]] || kill -TERM "$standalone_pid" 2>/dev/null || true
  [[ -z "$chrome_pid" ]] || kill -TERM "$chrome_pid" 2>/dev/null || true
  [[ -z "$standalone_pid" ]] || wait "$standalone_pid" 2>/dev/null || true
  [[ -z "$chrome_pid" ]] || wait "$chrome_pid" 2>/dev/null || true
}
trap terminate TERM INT EXIT

bootstrap_extension=false
if ! extension_installed; then
  bootstrap_extension=true
fi

start_chrome

# Chrome discovers a force-installed CRX before it knows that extension's managed schema on a new
# profile. One controlled restart after installation makes the already-written 3rdparty policy
# available to chrome.storage.managed; established profiles skip this bootstrap entirely.
if [[ "$bootstrap_extension" == true ]]; then
  for _ in {1..1200}; do
    if ! kill -0 "$chrome_pid" 2>/dev/null; then
      echo 'Google Chrome Stable exited while installing the Remote Tab Extension' >&2
      exit 1
    fi
    if extension_installed; then
      break
    fi
    sleep 0.1
  done
  if ! extension_installed; then
    echo 'Remote Tab Extension was not installed within 120 seconds' >&2
    exit 1
  fi
  stop_chrome
  start_chrome
fi

gosu node node /app/dist/cli.mjs >>/var/log/browshare/standalone.log 2>&1 &
standalone_pid=$!

set +e
wait -n "$chrome_pid" "$standalone_pid"
status=$?
set -e
exit "$status"
