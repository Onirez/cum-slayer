#!/usr/bin/env bash
# Install the box-local speech-to-text engine (faster-whisper, base, int8).
# Models and the venv live under this repo: models/ and tools/whisper-venv/.
# Do not run this on Fly (256 MB, billed). No paid API.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/tools/whisper-venv"
MODEL_DIR="$ROOT/models/whisper"
HF_HOME="$ROOT/models/hf"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install faster-whisper
mkdir -p "$MODEL_DIR" "$HF_HOME"
export HF_HOME HUGGINGFACE_HUB_CACHE="$HF_HOME/hub"
"$VENV/bin/python" - << PY
from faster_whisper import WhisperModel
WhisperModel("base", device="cpu", compute_type="int8", download_root="$MODEL_DIR")
print("ok: base model ready in $MODEL_DIR")
PY
