"""Stitches docs/frames/*.png (from capture.mjs) into docs/timeline.gif."""

from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent.parent
paths = sorted((root / ".frames").glob("f*.png"))
if not paths:
    raise SystemExit("No frames found. Run scripts/capture.mjs first.")

WIDTH = 760
frames = []
for p in paths:
    im = Image.open(p).convert("RGB")
    im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
    frames.append(im)

# One shared palette keeps the background from shimmering between frames.
palette = frames[len(frames) // 2].quantize(colors=255, method=Image.Quantize.MEDIANCUT)
quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]

out = root / "public" / "shots" / "timeline.gif"
quantized[0].save(
    out,
    save_all=True,
    append_images=quantized[1:],
    duration=[100] * (len(quantized) - 1) + [2500],
    loop=0,
    optimize=True,
)
print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(frames)} frames)")
