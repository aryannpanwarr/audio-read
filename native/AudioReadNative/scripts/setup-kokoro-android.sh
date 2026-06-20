#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_MAIN="$ROOT_DIR/android/app/src/main"
ASSETS_DIR="$ANDROID_MAIN/assets"
JNI_DIR="$ANDROID_MAIN/jniLibs"
WORK_DIR="$ROOT_DIR/.kokoro-downloads"

SHERPA_VERSION="1.13.3"
SHERPA_ANDROID_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-android.tar.bz2"
KOKORO_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2"

mkdir -p "$WORK_DIR" "$ASSETS_DIR" "$JNI_DIR/arm64-v8a"

download() {
  local url="$1"
  local out="$2"
  if [[ -s "$out" ]]; then
    echo "Using cached $(basename "$out")"
    return
  fi
  echo "Downloading $url"
  curl -L "$url" -o "$out"
}

download "$SHERPA_ANDROID_URL" "$WORK_DIR/sherpa-onnx-android.tar.bz2"
download "$KOKORO_URL" "$WORK_DIR/kokoro-en-v0_19.tar.bz2"

echo "Extracting Android JNI library"
tar -xjf "$WORK_DIR/sherpa-onnx-android.tar.bz2" -C "$WORK_DIR" ./jniLibs/arm64-v8a
cp -v "$WORK_DIR/jniLibs/arm64-v8a/"*.so "$JNI_DIR/arm64-v8a/"

echo "Extracting Kokoro model assets"
rm -rf "$ASSETS_DIR/kokoro-en-v0_19"
tar -xjf "$WORK_DIR/kokoro-en-v0_19.tar.bz2" -C "$ASSETS_DIR"

echo "Installed:"
ls -lh "$JNI_DIR/arm64-v8a"
ls -lh "$ASSETS_DIR/kokoro-en-v0_19" | sed -n '1,12p'
