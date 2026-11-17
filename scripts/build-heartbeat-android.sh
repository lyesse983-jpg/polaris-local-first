#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [[ "${1:-}" != "--prepared" ]]; then
  npm ci --no-audit --no-fund
  npm run build
  npx cap sync android
fi

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_root" || ! -d "$sdk_root" ]]; then
  echo 'Set ANDROID_HOME to an Android SDK with platform 36 and build tools 35.0.0.' >&2
  exit 1
fi
export ANDROID_HOME="$sdk_root"
export ANDROID_SDK_ROOT="$sdk_root"

# A debug-only resource overlay makes this APK distinguishable from the original.
# The existing debug applicationIdSuffix (.debug) gives it a separate data sandbox.
debug_values_dir="android/app/src/debug/res/values"
debug_strings_path="$debug_values_dir/heartbeat-build-label.xml"
mkdir -p "$debug_values_dir"
cat > "$debug_strings_path" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Polaris 心跳测试</string>
    <string name="title_activity_main">Polaris 心跳测试</string>
</resources>
XML
trap 'rm -f "$debug_strings_path"' EXIT

bash android/gradlew -p android assembleDebug --no-daemon --stacktrace

apk_path="android/app/build/outputs/apk/debug/app-debug.apk"
test -s "$apk_path"
mkdir -p artifacts
cp "$apk_path" artifacts/polaris-heartbeat-debug.apk
(cd artifacts && sha256sum polaris-heartbeat-debug.apk > polaris-heartbeat-debug.apk.sha256)
