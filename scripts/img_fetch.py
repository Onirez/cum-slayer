#!/usr/bin/env python3
"""Download Discord CDN images, resize to a 1024px JPEG, print local cache paths.

Never prints URLs or query tokens. Allowed hosts only.
Usage: img_fetch.py [--all] [--max 1024] <url> [url...]
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ALLOWED_HOSTS = frozenset({"cdn.discordapp.com", "media.discordapp.net"})
MAX_BYTES = 10 * 1024 * 1024
DEFAULT_TIMEOUT = 8  # seconds (was 15)
DEFAULT_MAX_EDGE = 1024
MAX_AGE_SEC = 24 * 60 * 60
GC_INTERVAL_SEC = 30 * 60
CONNECT_UA = "cum-slayer-bridge/img"

PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8\xff"
GIF87, GIF89 = b"GIF87a", b"GIF89a"


class ImgError(Exception):
    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def usage() -> None:
    print("Usage: img.sh [--all] [--max 1024] <url> [url...]", file=sys.stderr)
    raise SystemExit(2)


def cache_dir() -> Path:
    raw = os.environ.get("IMG_CACHE_DIR")
    if raw:
        p = Path(raw)
    else:
        here = Path(__file__).resolve().parent
        if (here / "data").is_dir():
            p = here / "data" / "img-cache"
        elif (here.parent / "data").is_dir():
            p = here.parent / "data" / "img-cache"
        else:
            p = here / "data" / "img-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p


def is_allowed_url(url: str) -> bool:
    try:
        u = urlparse(url)
    except Exception:
        return False
    host = (u.hostname or "").lower()
    if u.scheme != "https" or host not in ALLOWED_HOSTS:
        return False
    if u.username or u.password:
        return False
    if u.port not in (None, 443):
        return False
    return True


def preview_url(url: str, max_edge: int) -> str:
    """Rewrite a Discord CDN URL to the media proxy at max_edge JPEG, keeping signatures."""
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        return url
    q = dict(parse_qsl(u.query, keep_blank_values=True))
    # Do not set width/height: Discord's media proxy crops to a square when both are set.
    q["format"] = "jpeg"
    netloc = "media.discordapp.net"
    if u.port and u.port != 443:
        netloc = f"{netloc}:{u.port}"
    return urlunparse(("https", netloc, u.path, u.params, urlencode(q), ""))


def is_image(head: bytes) -> bool:
    if head.startswith(PNG) or head.startswith(JPEG):
        return True
    if head.startswith(GIF87) or head.startswith(GIF89):
        return True
    if head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WEBP":
        return True
    return False


def cache_key(url: str, max_edge: int) -> str:
    h = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return f"{h}-{max_edge}.jpg"


def maybe_gc(cache: Path) -> None:
    try:
        interval = int(os.environ.get("IMG_CACHE_GC_MIN", str(GC_INTERVAL_SEC // 60))) * 60
    except ValueError:
        interval = GC_INTERVAL_SEC
    stamp = cache / ".gc"
    now = time.time()
    try:
        age = now - stamp.stat().st_mtime
        if interval > 0 and age < interval:
            return
    except FileNotFoundError:
        pass
    cutoff = now - MAX_AGE_SEC
    try:
        for p in cache.iterdir():
            if p.name == ".gc" or not p.is_file():
                continue
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass
        stamp.touch()
    except OSError:
        pass


def download(url: str, dest: Path, timeout: int) -> None:
    req = Request(url, headers={"User-Agent": CONNECT_UA})
    try:
        with urlopen(req, timeout=timeout) as resp:
            # Do not follow to a non-allowlisted host (urlopen follows redirects).
            final = resp.geturl() or url
            if not is_allowed_url(final):
                raise ImgError("error: download failed")
            tmp_fd, tmp_name = tempfile.mkstemp(prefix="tmp.", dir=str(dest.parent))
            written = 0
            try:
                with os.fdopen(tmp_fd, "wb") as f:
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > MAX_BYTES:
                            raise ImgError("error: file exceeds 10 MB")
                        f.write(chunk)
                if written == 0:
                    raise ImgError("error: empty download")
                with open(tmp_name, "rb") as f:
                    head = f.read(32)
                if not is_image(head):
                    raise ImgError("error: downloaded file is not a recognized image (png, jpeg, webp, gif)")
                os.chmod(tmp_name, 0o600)
                os.replace(tmp_name, dest)
            finally:
                if os.path.exists(tmp_name):
                    try:
                        os.unlink(tmp_name)
                    except OSError:
                        pass
    except ImgError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError):
        raise ImgError("error: download failed")


def resize_to_jpeg(src: Path, dest: Path, max_edge: int) -> None:
    try:
        from PIL import Image
    except ImportError:
        # No PIL: if it's already a jpeg, copy; otherwise leave the original path.
        if src.resolve() != dest.resolve():
            dest.write_bytes(src.read_bytes())
        return
    with Image.open(src) as im:
        im.load()
        if im.mode in ("RGBA", "LA", "P"):
            rgba = im.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        w, h = im.size
        if max(w, h) > max_edge:
            im.thumbnail((max_edge, max_edge), Image.Resampling.BILINEAR)
        tmp_fd, tmp_name = tempfile.mkstemp(prefix="tmp.", suffix=".jpg", dir=str(dest.parent))
        os.close(tmp_fd)
        try:
            im.save(tmp_name, "JPEG", quality=85, optimize=True)
            os.chmod(tmp_name, 0o600)
            os.replace(tmp_name, dest)
        finally:
            if os.path.exists(tmp_name):
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass


def fetch_one(url: str, cache: Path, max_edge: int, timeout: int) -> Path:
    if not is_allowed_url(url):
        raise ImgError("error: only https URLs on cdn.discordapp.com or media.discordapp.net are allowed")
    dest = cache / cache_key(url, max_edge)
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    raw = cache / f"{hashlib.sha256(url.encode('utf-8')).hexdigest()}.src"
    preview = preview_url(url, max_edge)
    try:
        download(preview, raw, timeout)
    except ImgError:
        download(url, raw, timeout)
    resize_to_jpeg(raw, dest, max_edge)
    try:
        raw.unlink()
    except OSError:
        pass
    return dest


def parse_args(argv: list[str]) -> tuple[list[str], int, bool]:
    urls: list[str] = []
    max_edge = int(os.environ.get("IMG_MAX_EDGE", DEFAULT_MAX_EDGE))
    all_mode = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            usage()
        elif a == "--all":
            all_mode = True
            i += 1
        elif a == "--max":
            if i + 1 >= len(argv):
                usage()
            try:
                max_edge = int(argv[i + 1])
            except ValueError:
                usage()
            if max_edge < 64 or max_edge > 4096:
                print("error: --max must be between 64 and 4096", file=sys.stderr)
                raise SystemExit(2)
            i += 2
        elif a.startswith("--max="):
            try:
                max_edge = int(a.split("=", 1)[1])
            except ValueError:
                usage()
            i += 1
        elif a.startswith("-"):
            usage()
        else:
            urls.append(a)
            i += 1
    if not urls:
        usage()
    if not all_mode and len(urls) > 1:
        # Implicit --all when several URLs are passed.
        all_mode = True
    if len(urls) > 8:
        print("error: too many images (max 8)", file=sys.stderr)
        raise SystemExit(2)
    return urls, max_edge, all_mode


def main() -> None:
    timeout = int(os.environ.get("IMG_TIMEOUT", DEFAULT_TIMEOUT))
    urls, max_edge, all_mode = parse_args(sys.argv[1:])
    cache = cache_dir()
    maybe_gc(cache)
    if len(urls) == 1:
        try:
            path = fetch_one(urls[0], cache, max_edge, timeout)
        except ImgError as e:
            print(str(e), file=sys.stderr)
            raise SystemExit(e.code)
        print(path)
        return
    # Parallel fetch. Print paths in the same order as the URLs. Never print URLs.
    results: dict[int, Path | ImgError] = {}
    workers = min(4, len(urls))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(fetch_one, url, cache, max_edge, timeout): i for i, url in enumerate(urls)}
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                results[i] = fut.result()
            except ImgError as e:
                results[i] = e
    failed = 0
    for i in range(len(urls)):
        r = results.get(i)
        if isinstance(r, ImgError):
            print(str(r), file=sys.stderr)
            failed += 1
        elif r is None:
            print("error: download failed", file=sys.stderr)
            failed += 1
        else:
            print(r)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(1)
