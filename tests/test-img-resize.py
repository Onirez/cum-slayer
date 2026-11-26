#!/usr/bin/env python3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else ".")
from img_fetch import resize_to_jpeg, preview_url, is_allowed_url
from PIL import Image

assert is_allowed_url("https://cdn.discordapp.com/attachments/1/2/a.png")
assert not is_allowed_url("https://evil.example/a.png")
u = preview_url("https://cdn.discordapp.com/attachments/1/2/big.png?ex=1&hm=2", 1024)
assert "media.discordapp.net" in u and "format=jpeg" in u and "ex=1" in u and "width=" not in u
d = Path(tempfile.mkdtemp())
src = d / "big.png"
Image.new("RGB", (2000, 1500), (200, 10, 10)).save(src, "PNG")
dest = d / "out.jpg"
resize_to_jpeg(src, dest, 1024)
im = Image.open(dest)
assert im.size == (1024, 768), im.size
assert dest.stat().st_size < src.stat().st_size
print("resize-ok", *im.size, dest.stat().st_size)
