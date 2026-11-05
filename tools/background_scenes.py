"""Original anime-style scenery for DroidAgent's chat backgrounds, drawn as portrait SVG.

Usage: python3 scenes.py <out_dir>
Every scene is generated from shapes and gradients here (seeded randomness), nothing traced or
copied, so they can ship with the app under its own licence.
"""
import math
import random
import sys

W, H = 390, 844
OUT = sys.argv[1]


def svg(body, defs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W * 3}" height="{H * 3}" viewBox="0 0 {W} {H}" '
            f'preserveAspectRatio="xMidYMid slice"><defs>{defs}</defs>{body}</svg>')


def lin(id_, stops, x2=0, y2=1):
    s = ''.join(f'<stop offset="{o}" stop-color="{c}"{f" stop-opacity={chr(34)}{a}{chr(34)}" if a is not None else ""}/>' for o, c, a in stops)
    return f'<linearGradient id="{id_}" x1="0" y1="0" x2="{x2}" y2="{y2}">{s}</linearGradient>'


def rad(id_, stops, cx=.5, cy=.5, r=.5):
    s = ''.join(f'<stop offset="{o}" stop-color="{c}" stop-opacity="{a}"/>' for o, c, a in stops)
    return f'<radialGradient id="{id_}" cx="{cx}" cy="{cy}" r="{r}">{s}</radialGradient>'


def blur(id_, sd):
    return f'<filter id="{id_}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{sd}"/></filter>'


def cumulus(rng, cx, base, width, height, shade, light, glow):
    """A towering cloud: shadowed underside, white body, sunlit bumps on the upper left."""
    puffs = []
    for i in range(int(width / 9)):
        t = i / max(1, int(width / 9) - 1)
        x = cx - width / 2 + t * width + rng.uniform(-6, 6)
        hump = math.sin(t * math.pi) ** 0.8
        y = base - hump * height * rng.uniform(.75, 1.0)
        r = 18 + hump * 34 * rng.uniform(.7, 1.1)
        puffs.append((x, y, r))
    for i in range(int(width / 14)):
        x = cx - width / 2 + rng.uniform(.05, .95) * width
        puffs.append((x, base - rng.uniform(0, height * .35), rng.uniform(16, 30)))
    out = [f'<circle cx="{x + 5:.1f}" cy="{y + 9:.1f}" r="{r:.1f}" fill="{shade}"/>' for x, y, r in puffs]
    out += [f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#ffffff"/>' for x, y, r in puffs]
    out += [f'<circle cx="{x - r * .28:.1f}" cy="{y - r * .3:.1f}" r="{r * .55:.1f}" fill="{light}" opacity=".9"/>' for x, y, r in puffs if y < base - height * .35]
    out.append(f'<rect x="{cx - width / 2 - 30:.1f}" y="{base - 6:.1f}" width="{width + 60:.1f}" height="40" fill="{shade}" opacity=".55" filter="url(#soft)"/>')
    return f'<g filter="url(#{glow})">' + ''.join(out) + '</g>'


def summer():
    rng = random.Random(4)
    defs = lin('sky', [(0, '#1D54A0', None), (.35, '#3F8BD0', None), (.7, '#9ECDEB', None), (.82, '#E6F2F8', None)])
    defs += lin('sea', [(0, '#3D8DC2', None), (1, '#1F5E92', None)])
    defs += rad('sun', [(0, '#ffffff', .95), (.4, '#fffbe8', .45), (1, '#ffffff', 0)], cx=.18, cy=.1, r=.45)
    defs += blur('soft', 6) + blur('cloudglow', .6)
    b = f'<rect width="{W}" height="{H}" fill="url(#sky)"/><rect width="{W}" height="{H}" fill="url(#sun)"/>'
    # far cloud banks along the horizon, then the big tower
    b += cumulus(rng, 90, 680, 230, 70, '#BCD5E8', '#FFFDF6', 'cloudglow')
    b += cumulus(rng, 330, 690, 200, 55, '#BCD5E8', '#FFFDF6', 'cloudglow')
    b += cumulus(rng, 215, 670, 260, 330, '#B4CEE3', '#FFF9EC', 'cloudglow')
    # sea and its glints
    b += f'<rect y="690" width="{W}" height="{H - 690}" fill="url(#sea)"/><rect y="688" width="{W}" height="3" fill="#E9F5FB" opacity=".8"/>'
    for _ in range(60):
        x, y = rng.uniform(0, W), rng.uniform(700, H)
        b += f'<rect x="{x:.1f}" y="{y:.1f}" width="{rng.uniform(4, 18):.1f}" height="1.2" fill="#ffffff" opacity="{rng.uniform(.25, .7):.2f}"/>'
    # utility pole and wires, the summer-afternoon staple
    pole = '#24384C'
    b += f'<g fill="{pole}"><rect x="318" y="170" width="9" height="700"/><rect x="286" y="236" width="76" height="6" rx="2"/><rect x="296" y="276" width="56" height="5" rx="2"/>'
    b += ''.join(f'<rect x="{x}" y="226" width="4" height="10" rx="1.5"/>' for x in (290, 312, 334, 356)) + '</g>'
    for x0, y0, x1, y1, sag in ((290, 236, -20, 300, 70), (312, 236, -20, 352, 64), (356, 236, 420, 300, 30), (334, 236, -20, 410, 60), (300, 278, -20, 470, 50)):
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2 + sag
        b += f'<path d="M{x0} {y0}Q{mx} {my} {x1} {y1}" stroke="{pole}" stroke-width="1.3" fill="none"/>'
    for x, y in ((120, 210), (148, 196), (170, 232)):
        b += f'<path d="M{x} {y}l6 4 6-4" stroke="{pole}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".8"/>'
    return svg(b, defs)


def dusk():
    rng = random.Random(9)
    defs = lin('sky', [(0, '#262A57', None), (.32, '#5D4783', None), (.55, '#C9708A', None), (.7, '#F09A6B', None), (.78, '#F8C27A', None)])
    defs += rad('sun', [(0, '#FFF1C9', 1), (.25, '#FFD08A', .9), (.6, '#F8A86B', .25), (1, '#F8A86B', 0)], cx=.5, cy=.5, r=.5)
    defs += blur('soft', 2.5) + blur('glow', 4) + blur('cloud', 7)
    b = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    b += f'<circle cx="250" cy="610" r="150" fill="url(#sun)"/><circle cx="250" cy="610" r="42" fill="#FFF0C8"/>'
    # long clouds lit from below
    # soft cloud banks, their undersides catching the low sun
    for _ in range(6):
        y = rng.uniform(200, 500); x = rng.uniform(-120, 200); w = rng.uniform(200, 360); hh = rng.uniform(16, 34)
        b += f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{hh:.0f}" rx="{hh / 2:.0f}" fill="#6A4577" opacity=".5" filter="url(#cloud)"/>'
        b += f'<rect x="{x + 30:.0f}" y="{y + hh - 6:.0f}" width="{w - 70:.0f}" height="5" rx="3" fill="#F9A77C" opacity=".38" filter="url(#soft)"/>'
    # town on the horizon
    x, city = -5, ''
    while x < W + 10:
        w = rng.uniform(14, 34); h = rng.uniform(12, 60)
        city += f'<rect x="{x:.0f}" y="{640 - h:.0f}" width="{w:.0f}" height="{h + 10:.0f}"/>'
        x += w + rng.uniform(0, 4)
    b += f'<g fill="#3B2C4D">{city}</g>'
    # the train crossing the embankment, windows lit
    b += '<rect y="648" width="400" height="200" fill="#241A31"/><rect y="640" width="400" height="10" fill="#2E2140"/>'
    b += '<g fill="#1A1224"><rect x="-10" y="600" width="250" height="44" rx="6"/><rect x="246" y="600" width="170" height="44" rx="6"/></g>'
    for i in range(14):
        cx = 4 + i * 28
        if 236 < cx < 252:
            continue
        b += f'<rect x="{cx}" y="610" width="18" height="13" rx="2" fill="#FFD48C" opacity=".92"/>'
    b += '<rect x="-10" y="596" width="430" height="3" fill="#1A1224"/>'
    # catenary poles and wires
    for px in (40, 190, 340):
        b += f'<rect x="{px}" y="430" width="5" height="220" fill="#1A1224"/><rect x="{px - 14}" y="452" width="40" height="4" fill="#1A1224"/>'
    b += '<path d="M-10 470Q115 490 240 468T430 470" stroke="#1A1224" stroke-width="1.4" fill="none"/><path d="M-10 458Q115 476 240 456T430 458" stroke="#1A1224" stroke-width="1" fill="none"/>'
    # level crossing in the foreground, its lamps on
    b += '<g fill="#140E1C"><rect x="70" y="650" width="7" height="140"/><rect x="40" y="664" width="66" height="6" transform="rotate(-24 73 667)"/><rect x="40" y="664" width="66" height="6" transform="rotate(24 73 667)"/>'
    b += '<rect x="56" y="700" width="36" height="16" rx="8"/></g>'
    b += '<circle cx="64" cy="708" r="9" fill="#FF5A4E" filter="url(#glow)" opacity=".9"/><circle cx="64" cy="708" r="4.5" fill="#FFB3A8"/>'
    b += '<circle cx="84" cy="708" r="4" fill="#4A1E24"/>'
    b += f'<rect y="790" width="{W}" height="60" fill="#140E1C"/>'
    return svg(b, defs)


def starry_hill():
    rng = random.Random(21)
    defs = lin('sky', [(0, '#070B24', None), (.4, '#16205A', None), (.72, '#3A3C7C', None), (.86, '#7A5E96', None)])
    defs += lin('band', [(0, '#B9B7F0', 0), (.5, '#D8CFF7', .55), (1, '#B9B7F0', 0)], x2=1, y2=0)
    defs += blur('band', 14) + blur('glow', 2.2) + blur('fly', 2.5)
    b = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    b += '<g transform="rotate(-58 195 380)"><rect x="-120" y="330" width="630" height="110" fill="url(#band)" filter="url(#band)"/></g>'
    stars = ''
    for i in range(420):
        if i < 180:  # crowd along the band
            t = rng.uniform(-1, 1)
            x = 195 + t * 300 * math.cos(math.radians(-58)) + rng.gauss(0, 26)
            y = 380 + t * 300 * math.sin(math.radians(-58)) * -1 + rng.gauss(0, 26)
        else:
            x, y = rng.uniform(0, W), rng.uniform(0, 640) ** 1.0
        r = rng.choice((.4, .5, .6, .7, .9, 1.2))
        stars += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#ffffff" opacity="{rng.uniform(.35, 1):.2f}"/>'
    b += stars
    for x, y in ((80, 150), (300, 90), (220, 300)):
        b += f'<circle cx="{x}" cy="{y}" r="2.2" fill="#ffffff" filter="url(#glow)"/><path d="M{x - 7} {y}H{x + 7}M{x} {y - 7}V{y + 7}" stroke="#ffffff" stroke-width=".6" opacity=".8"/>'
    for x, y, l in ((260, 120, 70), (120, 240, 50)):
        b += f'<path d="M{x} {y}l{-l} {l * .45}" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round" opacity=".85"/>'
    # hills and the lone tree
    b += '<path d="M0 690Q120 640 230 668T390 650V844H0Z" fill="#141A3E"/><path d="M-10 735Q140 680 300 720T400 730V844H-10Z" fill="#0A0E26"/>'
    # the lone tree: trunk, a few limbs, a ragged crown of leaf clumps
    b += '<g fill="#0A0E26" stroke="#0A0E26" stroke-linecap="round"><path d="M269 716C270 680 266 650 272 610" stroke-width="8" fill="none"/>'
    b += '<path d="M271 640L244 612M272 628L300 600M270 652L292 640" stroke-width="3.5" fill="none"/>'
    for _ in range(26):
        a = rng.uniform(0, math.pi * 2); d = rng.uniform(0, 1) ** .6
        cx, cy = 271 + math.cos(a) * d * 46, 588 + math.sin(a) * d * 34
        b += f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{rng.uniform(8, 17):.1f}" stroke="none"/>'
    for _ in range(14):  # stray leaf bunches breaking the outline
        a = rng.uniform(0, math.pi * 2)
        b += f'<circle cx="{271 + math.cos(a) * 54:.1f}" cy="{588 + math.sin(a) * 40:.1f}" r="{rng.uniform(3, 7):.1f}" stroke="none"/>'
    b += '</g>'
    for _ in range(22):
        x, y = rng.uniform(10, 380), rng.uniform(700, 820)
        b += f'<circle cx="{x:.0f}" cy="{y:.0f}" r="2.6" fill="#F7E58A" opacity=".6" filter="url(#fly)"/><circle cx="{x:.0f}" cy="{y:.0f}" r=".9" fill="#FFF6C4"/>'
    return svg(b, defs)


def mesh(name, bg, blobs):
    defs = blur('m', 60)
    b = f'<rect width="{W}" height="{H}" fill="{bg}"/><g filter="url(#m)">'
    b += ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}"/>' for x, y, r, c in blobs)
    return svg(b + '</g>', defs)


SCENES = {
    'anime-summer': summer(),
    'anime-dusk': dusk(),
    'anime-stars': starry_hill(),
    'mesh-peach': mesh('peach', '#F6E7E1', [(60, 120, 170, '#F7B7A3'), (330, 260, 160, '#F9D8A8'), (120, 520, 190, '#E9A8C0'), (320, 720, 170, '#BFC8F2'), (60, 820, 140, '#F7C9B5')]),
    'mesh-aurora': mesh('aurora', '#0E1630', [(80, 180, 170, '#1F7A8C'), (320, 330, 170, '#5B3E9C'), (110, 560, 180, '#2C9C7E'), (330, 760, 170, '#2D4C9C'), (40, 860, 120, '#7A3E8C')]),
}
for k, v in SCENES.items():
    with open(f'{OUT}/{k}.svg', 'w') as f:
        f.write(v)
    print(k, len(v) // 1024, 'KB')
