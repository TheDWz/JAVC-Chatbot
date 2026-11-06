#!/usr/bin/env bash
# Android smoke test: installs a debug APK on the running emulator (adb), points its profile at the mock API on the
# host (the emulator reaches it as 10.0.2.2), runs the app's built-in self-test and checks the back button.
# Usage: rust/selftest/android.sh path/to/app-debug.apk   (from the repository root; CI runs it inside the emulator job)
set -euo pipefail
APK=$1
PKG=io.github.thedwz.javcchatbot
HERE=$(dirname "$0")

node "$HERE/serve.mjs" &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  curl -sf http://127.0.0.1:18765/v1/models >/dev/null && break
  [ "$i" = 20 ] && { echo "mock API did not come up"; exit 1; }
  sleep 0.5
done

adb install -r "$APK"
adb shell am force-stop $PKG
sed 's#http://127.0.0.1:18765/v1#http://10.0.2.2:18765/v1#' "$HERE/settings.json" > "${TMPDIR:-/tmp}/javc-settings.json"
adb push "${TMPDIR:-/tmp}/javc-settings.json" /data/local/tmp/javc-settings.json >/dev/null
adb shell "run-as $PKG sh -c 'mkdir -p files && cat > files/settings.json' < /data/local/tmp/javc-settings.json"
# an image to attach, so the test covers image conversion too (the app can read its own files folder)
adb push "$HERE/../../build/icon.png" /data/local/tmp/javc-icon.png >/dev/null
adb shell "run-as $PKG sh -c 'cat > files/selftest.png' < /data/local/tmp/javc-icon.png"

adb logcat -c
adb shell am start -n $PKG/.MainActivity --es selftest /data/user/0/$PKG/files/selftest.png
result=""
for i in $(seq 1 120); do
  result=$(adb logcat -d -s javc:I | grep -o 'SELFTEST.*' | head -1 || true)
  [ -n "$result" ] && break
  sleep 1
done
adb logcat -d -s javc:I AndroidRuntime:E | tail -40
echo "${result:-SELFTEST TIMEOUT}"
[[ $result == "SELFTEST PASS" ]] || exit 1

# Back with nothing open hides the app (moveTaskToBack) instead of closing it; the process keeps running.
pid=$(adb shell pidof $PKG)
adb shell input keyevent BACK
sleep 2
top=$(adb shell dumpsys activity activities | grep -m1 topResumedActivity || true)
[[ $top != *"$PKG/"* ]] || { echo "back button: the app is still in front ($top)"; exit 1; }
[ "$(adb shell pidof $PKG)" = "$pid" ] || { echo "back button: the app was closed"; exit 1; }
# ...and the activity itself is kept (a finished one would come back as a fresh start)
adb shell dumpsys activity activities | grep -q "$PKG/.MainActivity" || { echo "back button: the activity was finished"; exit 1; }
echo "back button OK"
