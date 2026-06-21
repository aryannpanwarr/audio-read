#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/.cuda-libs"

echo "Installing local CUDA 12 runtime libraries into:"
echo "  $TARGET"
echo
echo "This is large, but it avoids requiring a system-wide CUDA Toolkit install."

python3 -m pip install \
  --target "$TARGET" \
  --upgrade \
  nvidia-cublas-cu12 \
  nvidia-cuda-runtime-cu12 \
  nvidia-cudnn-cu12 \
  nvidia-cufft-cu12 \
  nvidia-curand-cu12 \
  nvidia-cuda-nvrtc-cu12

cat <<EOF

Done.

Launch the desktop app with CUDA library paths:
  npm run desktop:cuda

Then choose Backend: CUDA / RTX in the app.
EOF
