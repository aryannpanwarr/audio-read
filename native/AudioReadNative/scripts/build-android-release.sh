#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JDK_DIR="$(find "$ROOT_DIR/.toolchains" -maxdepth 1 -type d -name 'jdk-*' | sort | tail -n 1)"
SDK_DIR="$ROOT_DIR/.toolchains/android-sdk"

if [[ -z "$JDK_DIR" || ! -x "$JDK_DIR/bin/java" ]]; then
  echo "Missing local JDK. Install one under $ROOT_DIR/.toolchains first." >&2
  exit 1
fi

if [[ ! -d "$SDK_DIR/platforms/android-36" ]]; then
  echo "Missing local Android SDK packages. Install them with sdkmanager first." >&2
  exit 1
fi

cd "$ROOT_DIR/android"
JAVA_HOME="$JDK_DIR" ANDROID_HOME="$SDK_DIR" ./gradlew :app:assembleRelease
