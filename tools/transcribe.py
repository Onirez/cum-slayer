#!/usr/bin/env python3
"""Local speech-to-text for vid.sh / aud.sh. CPU only, no paid API.

Reads a wav (ideally 16 kHz mono) and prints:
  language=<code>
  transcript=<text>
or, when no speech is found:
  language=<code or unknown>
  aucune parole détectée

Never prints the input path or any URL. Model files live under
/workspace/discord-bridge/models (not ~/.cache).
"""
from __future__ import annotations

import os
import sys

MAX_CHARS = 4000


def _die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)



def load_wav(path: str):
    """Load a PCM WAV as float32 mono. Avoids PyAV, which can break on some Python builds."""
    import wave
    import numpy as np

    with wave.open(path, "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if width == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif width == 1:
        samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError("unsupported wav sample width")
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and samples.size:
        # Linear resample to 16 kHz (input is normally already 16 kHz).
        import math
        new_len = max(1, int(round(samples.size * 16000 / rate)))
        x_old = np.linspace(0.0, 1.0, samples.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, new_len, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)
    return samples


def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1]:
        print("Usage: transcribe.py <wav>", file=sys.stderr)
        raise SystemExit(2)
    path = sys.argv[1]
    if not os.path.isfile(path):
        _die("audio file not found")

    root = os.environ.get(
        "WHISPER_ROOT",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
    )
    model_name = os.environ.get("WHISPER_MODEL", "base")
    model_dir = os.environ.get("WHISPER_MODEL_DIR", os.path.join(root, "models", "whisper"))
    hf_home = os.environ.get("HF_HOME", os.path.join(root, "models", "hf"))
    os.environ.setdefault("HF_HOME", hf_home)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(hf_home, "hub"))
    os.environ.setdefault("HF_HUB_OFFLINE", os.environ.get("HF_HUB_OFFLINE", "1"))

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        _die("faster-whisper is not installed")

    threads = int(os.environ.get("WHISPER_THREADS") or "4")
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
        download_root=model_dir,
        cpu_threads=threads,
    )
    audio = load_wav(path)
    if audio.size == 0:
        print("language=unknown")
        print("aucune parole détectée")
        return
    segments, info = model.transcribe(
        audio,
        language=None,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        without_timestamps=True,
    )
    parts = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            parts.append(text)
    lang = (getattr(info, "language", None) or "unknown").strip() or "unknown"
    print(f"language={lang}")
    if not parts:
        print("aucune parole détectée")
        return
    joined = " ".join(parts)
    joined = " ".join(joined.split())
    if len(joined) > MAX_CHARS:
        joined = joined[:MAX_CHARS].rstrip() + "…"
    print(f"transcript={joined}")


if __name__ == "__main__":
    main()
