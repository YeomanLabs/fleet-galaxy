"""Draws build/icon.png (1024x1024): the Fleet Galaxy mark on a dark tile."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 4096  # supersample, then shrink
out = Path(__file__).resolve().parent.parent / "build" / "icon.png"
out.parent.mkdir(exist_ok=True)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Rounded tile with a deep-space gradient.
tile = Image.new("RGBA", (S, S))
td = ImageDraw.Draw(tile)
for y in range(S):
    t = y / S
    td.line([(0, y), (S, y)], fill=(int(10 + 14 * t), int(12 + 8 * t), int(34 + 22 * (1 - t)), 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([160, 160, S - 160, S - 160], radius=900, fill=255)
img.paste(tile, (0, 0), mask)

# Scattered background stars.
import random

random.seed(7)
stars = ImageDraw.Draw(img)
for _ in range(140):
    x, y = random.randint(400, S - 400), random.randint(400, S - 400)
    r = random.choice([6, 8, 10, 14])
    a = random.randint(90, 200)
    stars.ellipse([x - r, y - r, x + r, y + r], fill=(220, 230, 255, a))

# Orbit ring, tilted.
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
cx, cy = S // 2, S // 2
rd.ellipse([cx - 1500, cy - 560, cx + 1500, cy + 560], outline=(165, 180, 252, 255), width=120)
ring = ring.rotate(25, resample=Image.BICUBIC, center=(cx, cy))
glow = ring.filter(ImageFilter.GaussianBlur(60))
img.alpha_composite(glow)
img.alpha_composite(ring)

# Glowing core.
core = Image.new("RGBA", (S, S), (0, 0, 0, 0))
cd = ImageDraw.Draw(core)
for r, a in [(900, 40), (650, 70), (450, 110)]:
    cd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(125, 211, 252, a))
core = core.filter(ImageFilter.GaussianBlur(160))
img.alpha_composite(core)
dot = ImageDraw.Draw(img)
dot.ellipse([cx - 330, cy - 330, cx + 330, cy + 330], fill=(160, 225, 255, 255))
dot.ellipse([cx - 200, cy - 200, cx + 200, cy + 200], fill=(240, 250, 255, 255))

# Clip everything to the tile.
final = Image.new("RGBA", (S, S), (0, 0, 0, 0))
final.paste(img, (0, 0), mask)
final.resize((1024, 1024), Image.LANCZOS).save(out)
print(f"wrote {out}")
