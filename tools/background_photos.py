"""Crop/resize public-domain images into DroidAgent's chat backgrounds (app/web/backgrounds/).

Sources (all public domain / CC0, downloaded at full size into <orig_dir> first):
- Utagawa Hiroshige, One Hundred Famous Views of Edo (1856-59), The Metropolitan Museum of Art,
  Open Access (CC0): images.metmuseum.org/CRDImages/as/original/<id>.jpg
  DP130157 Plum Garden at Kamata, DP130156 Sudden Shower over Shin-Ohashi Bridge,
  DP121524 Fireworks at Ryogoku, DP121529 Maples at Mama, DP121552 Kinryuzan Temple at Asakusa
- Vincent van Gogh, Cypresses and Wheat Field with Cypresses (1889), The Met, Open Access (CC0):
  images.metmuseum.org/CRDImages/ep/original/DP130999.jpg, DP-42549-001.jpg
- NASA, photographs from the International Space Station (public domain):
  images-assets.nasa.gov/image/iss072e159172/iss072e159172~orig.jpg, iss053e023965
The anime-style scenes and gradients are drawn by tools/background_scenes.py.
"""
import os
import sys

from PIL import Image

ORIG, OUT = sys.argv[1], sys.argv[2]
os.makedirs(f'{OUT}/thumbs', exist_ok=True)

# id: (source, trim (l, t, r, b) as fractions, portrait crop centre x as fraction or None)
JOBS = {
    'ukiyoe-plum': ('DP130157.jpg', (.045, .035, .045, .035), None),
    'ukiyoe-shower': ('DP130156.jpg', (.045, .035, .045, .035), None),
    'ukiyoe-fireworks': ('DP121524.jpg', (.045, .035, .045, .035), None),
    'ukiyoe-maples': ('DP121529.jpg', (.045, .035, .045, .035), None),
    'ukiyoe-snow': ('DP121552.jpg', (.045, .035, .045, .035), None),
    'vangogh-cypresses': ('DP130999.jpg', (.025, .02, .025, .03), .5),
    'vangogh-wheat': ('DP-42549-001.jpg', (.012, .035, .012, .035), .72),
    'aurora-red': ('iss072e159172.jpg', (0, 0, 0, 0), .5),
    'aurora-city': ('iss053e023965.jpg', (0, 0, 0, 0), .6),
}
ASPECT = .62   # wider than a phone (~.46) so taller/wider screens still have room to crop
MAX_H = 1600

for key, (src, (l, t, r, b), cx) in JOBS.items():
    im = Image.open(f'{ORIG}/{src}').convert('RGB')
    w, h = im.size
    im = im.crop((int(w * l), int(h * t), int(w * (1 - r)), int(h * (1 - b))))
    w, h = im.size
    if cx is not None and w / h > ASPECT:
        cw = int(h * ASPECT)
        x0 = min(max(0, int(w * cx - cw / 2)), w - cw)
        im = im.crop((x0, 0, x0 + cw, h))
        w, h = im.size
    if h > MAX_H:
        im = im.resize((round(w * MAX_H / h), MAX_H), Image.LANCZOS)
    im.save(f'{OUT}/{key}.jpg', 'JPEG', quality=74, optimize=True, progressive=True)
    # thumbnail: phone-shaped centre crop
    w, h = im.size
    tw = int(h * .5)
    th_img = im.crop(((w - tw) // 2, 0, (w - tw) // 2 + tw, h)) if w > tw else im
    th_img = th_img.resize((300, round(300 * th_img.height / th_img.width)), Image.LANCZOS)
    th_img.save(f'{OUT}/thumbs/{key}.jpg', 'JPEG', quality=74, optimize=True, progressive=True)
    print(f'{key:18} {im.size}  {os.path.getsize(f"{OUT}/{key}.jpg") // 1024} KB  thumb {os.path.getsize(f"{OUT}/thumbs/{key}.jpg") // 1024} KB')
