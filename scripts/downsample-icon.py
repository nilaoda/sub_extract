"""Downsample an SVG raster from stdin with pixel coverage averaging."""
import io
import sys
from PIL import Image

size = int(sys.argv[1])
with Image.open(io.BytesIO(sys.stdin.buffer.read())) as rendered:
    # The icon has an opaque background. RGB avoids alpha fringes on export.
    icon = rendered.convert("RGB").resize((size, size), Image.Resampling.BOX)
    icon.save(sys.argv[2], format="PNG", optimize=True)
