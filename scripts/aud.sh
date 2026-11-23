#!/usr/bin/env bash
# Transcribe a local audio/wav file with the box-local Whisper model.
# Usage: aud.sh <wav-or-audio-file>
# Called by vid.sh after extracting 16 kHz mono (first 60 s). Not a URL fetcher.
# Never prints secrets or source URLs.
set -euo pipefail

_HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$_HERE/data" ]]; then
  ROOT="$_HERE"
elif [[ -d "$_HERE/../data" ]]; then
  ROOT="$(cd "$_HERE/.." && pwd)"
else
  ROOT="$_HERE"
fi

WAV="${1:-}"
if [[ $# -ne 1 || -z "$WAV" ]]; then
  echo "Usage: $0 <wav>" >&2
  exit 2
fi
if [[ ! -f "$WAV" ]]; then
  echo "error: audio file not found" >&2
  exit 1
fi

VENV="${WHISPER_VENV:-$ROOT/tools/whisper-venv}"
PY="$VENV/bin/python"
SCRIPT="$ROOT/tools/transcribe.py"
if [[ ! -x "$PY" || ! -f "$SCRIPT" ]]; then
  # Public-repo layout: src/ + scripts/
  if [[ -x "$ROOT/tools/whisper-venv/bin/python" ]]; then
    PY="$ROOT/tools/whisper-venv/bin/python"
  fi
  if [[ ! -f "$SCRIPT" && -f "$_HERE/../tools/transcribe.py" ]]; then
    SCRIPT="$(cd "$_HERE/.." && pwd)/tools/transcribe.py"
  fi
fi

if [[ ! -x "$PY" || ! -f "$SCRIPT" ]]; then
  echo "language=unknown"
  echo "transcription indisponible (moteur local absent)"
  exit 0
fi

export WHISPER_ROOT="${WHISPER_ROOT:-$ROOT}"
export WHISPER_MODEL="${WHISPER_MODEL:-base}"
export WHISPER_MODEL_DIR="${WHISPER_MODEL_DIR:-$ROOT/models/whisper}"
export HF_HOME="${HF_HOME:-$ROOT/models/hf}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-$HF_HOME/hub}"
# After the model has been downloaded once, stay offline so a refresh
# cannot try to hit the network mid-request.
if [[ -d "$WHISPER_MODEL_DIR" ]]; then
  export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
fi

"$PY" "$SCRIPT" "$WAV"
