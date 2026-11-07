"""Draws the PNG icons with Pillow: python brand/render_icons.py

Same geometry as brand/icon.svg (change both together). The Android launcher icon itself is the
adaptive vector in apk/res; these PNGs are the pre-Android-8 fallback and the web app's icons.
Drawn 8x larger and scaled down, which is how the edges come out smooth.
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = [
    ("apk/res/mipmap-mdpi/ic_launcher.png", 48, False), ("apk/res/mipmap-hdpi/ic_launcher.png", 72, False),
    ("apk/res/mipmap-xhdpi/ic_launcher.png", 96, False), ("apk/res/mipmap-xxhdpi/ic_launcher.png", 144, False),
    ("apk/res/mipmap-xxxhdpi/ic_launcher.png", 192, False),
    ("app/web/icon-192.png", 192, False), ("app/web/icon-512.png", 512, False),
    ("app/web/icon-maskable.png", 512, True),  # cropped by the platform, so it fills the square
]
TOP, BOTTOM = (0x1F, 0x6B, 0x51), (0x0D, 0x35, 0x27)
FACE, EYES, GOLD = (0xF4, 0xF1, 0xE8, 255), (0x12, 0x3F, 0x30, 255), (0xE9, 0xB9, 0x49, 255)
SS = 8


def render(size, full_bleed):
    n = size * SS
    u = n / 108  # one unit of the 108x108 design

    # Background: diagonal gradient, rounded corners unless the platform crops it anyway.
    grad = Image.new("RGBA", (n, n))
    px = grad.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,)
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=0 if full_bleed else 24 * u, fill=255)
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # The face, scaled by 0.94 around the centre as in the SVG.
    def p(v):
        return (54 + (v - 54) * 0.94) * u

    d = ImageDraw.Draw(img)
    w = 4 * 0.94 * u
    d.line([(p(54), p(37)), (p(54), p(28))], fill=FACE, width=round(w))
    for cx, cy in ((p(54), p(37)), (p(54), p(28))):  # round caps
        d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=FACE)
    r = 5.2 * 0.94 * u
    d.ellipse([p(54) - r, p(25) - r, p(54) + r, p(25) + r], fill=GOLD)
    d.rounded_rectangle([p(27), p(37), p(81), p(81)], radius=19 * 0.94 * u, fill=FACE)
    for x0 in (41, 59.5):
        d.rounded_rectangle([p(x0), p(51), p(x0 + 7.5), p(65)], radius=3.75 * 0.94 * u, fill=EYES)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for out, size, full_bleed in TARGETS:
        render(size, full_bleed).save(os.path.join(ROOT, out))
        print(out, size)
