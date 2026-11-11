"""Ad images for Tournament mode, built from real screens of one real run (2025 Indiana, the 1 seed, won the title).

    python marketing/ads/tournament/make_tournament.py      (from the repo root)

Writes ad-{feed,square,story}-{a,b}.png next to this file: feed is Meta's 4:5 (1080x1350), square 1080x1080,
story 1080x1920. Variant a sells the pick-any-team playoff, variant b the three-drives-to-a-title run.
No logos and no "College Football Playoff" mark; the price and the fan-made line stay on every size.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
NIGHT, LINE, CHALK, AMBER, MUTED, TURF = (12, 20, 32), (42, 61, 87), (238, 242, 246), (243, 178, 60), (167, 181, 200), (47, 107, 58)
CRIMSON = (153, 0, 0)
FONTS = Path('C:/Windows/Fonts')


def font(size, weight='Bold'):
    try:
        f = ImageFont.truetype(str(FONTS / 'bahnschrift.ttf'), size)
        try:
            f.set_variation_by_name(f'{weight} SemiCondensed')
        except Exception:
            pass
        return f
    except Exception:
        return ImageFont.truetype(str(FONTS / 'arialbd.ttf'), size)


def wrap(d, text, f, width):
    out, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=f) <= width:
            cur = t
        else:
            out.append(cur); cur = w
    return out + ([cur] if cur else [])


def paste_shot(im, shot, box, radius=22, top=False):
    """Fit `shot` inside box (x, y, w, h), keep aspect, round the corners, draw a thin frame. Returns the used rect.
    Centered in the box, or pinned to its top edge so side-by-side screens line up."""
    x, y, w, h = box
    s = min(w / shot.width, h / shot.height)
    sw, sh = int(shot.width * s), int(shot.height * s)
    sx, sy = x + (w - sw) // 2, y if top else y + (h - sh) // 2
    img = shot.resize((sw, sh), Image.LANCZOS)
    mask = Image.new('L', (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=radius, fill=255)
    im.paste(img, (sx, sy), mask)
    ImageDraw.Draw(im).rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=radius, outline=LINE, width=3)
    return sx, sy, sw, sh


def text_block(d, x, y, width, lines, gap=0.3):
    """lines: [(text, font, color)]; returns the y after the block."""
    for text, f, color in lines:
        for part in text.split('\n'):                  # an explicit break keeps a punchline on its own line
            for ln in wrap(d, part, f, width):
                d.text((x, y), ln, font=f, fill=color)
                y += int(f.size * 1.12)
        y += int(f.size * gap)
    return y


# the screens, cropped to what the ad needs (captured at 390 css px wide, 1.5x)
SEEDING = lambda: Image.open(HERE / 'screen-seeding.jpg').convert('RGB').crop((24, 238, 561, 1112))      # your team, the seed, the bracket
CHAMPS = lambda: Image.open(HERE / 'screen-champions.jpg').convert('RGB').crop((24, 238, 561, 872))      # the verdict and the three wins
CARD = lambda: Image.open(HERE / 'card-champions.png').convert('RGB').crop((0, 0, 800, 618))             # the share card from that run

COPY = {
    'a': dict(kicker='NEW · TOURNAMENT MODE',
              head='Pick any team since 2023.\nWin a 12-team playoff.',
              sub='Seeded by rating against the best teams of 2023–2025. Every round is one real late-game drive: beat the real coach to advance.'),
    'b': dict(kicker='NEW · TOURNAMENT MODE',
              head='Three drives.\nOne title.',
              sub='One run: 2025 Indiana, the 1 seed. Three real fourth-quarter drives, and the real coaches\' numbers to beat in every one. Pick your team.'),
}
CTA = 'Play at ncaa2mindrill.com'
PRICE = 'Daily drive free · Tournament + hard modes: $2.99 once'
FINE = 'Fan-made. Not affiliated with the NCAA or its schools.'


def frame(W, H):
    im = Image.new('RGB', (W, H), NIGHT)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 10, H], fill=CRIMSON)                       # a thin team-color rail, no logos
    band = int(H * 0.045)
    d.rectangle([0, H - band, W, H], fill=TURF)
    for x in range(0, W, 60):
        d.line([x, H - band, x, H], fill=(90, 140, 100), width=1)
    return im, d, band


def footer(d, x, y, sizes):
    cta, price, fine = sizes
    d.text((x, y), CTA, font=font(cta), fill=AMBER)
    y += int(cta * 1.25)
    d.text((x, y), PRICE, font=font(price, 'SemiBold'), fill=CHALK)
    y += int(price * 1.35)
    d.text((x, y), FINE, font=font(fine, 'SemiLight'), fill=MUTED)


def make(kind, v):
    c = COPY[v]
    W, H = {'feed': (1080, 1350), 'square': (1080, 1080), 'story': (1080, 1920)}[kind]
    im, d, band = frame(W, H)
    pad = 64
    if kind == 'feed':
        y = text_block(d, pad, 56, W - 2 * pad, [(c['kicker'], font(30, 'SemiBold'), AMBER), (c['head'], font(72), CHALK), (c['sub'], font(30, 'SemiLight'), MUTED)], gap=0.3)
        foot = H - band - 170
        box_h = foot - 30 - (y + 6)
        if v == 'a':                                    # pick a team, then win it: the two screens side by side
            half = (W - 2 * pad - 28) // 2
            paste_shot(im, SEEDING(), (pad, y + 6, half, box_h), top=True)
            paste_shot(im, CHAMPS(), (pad + half + 28, y + 6, half, box_h), top=True)
        else:
            paste_shot(im, CARD(), (pad, y + 6, W - 2 * pad, box_h))
        footer(d, pad, foot, (44, 27, 22))
    elif kind == 'square':
        y = text_block(d, pad, 48, W - 2 * pad, [(c['kicker'], font(28, 'SemiBold'), AMBER), (c['head'], font(64), CHALK)], gap=0.25)
        foot = H - band - 150
        box_h = foot - 24 - (y + 4)
        if v == 'a':
            half = (W - 2 * pad - 24) // 2
            paste_shot(im, SEEDING(), (pad, y + 4, half, box_h), top=True)
            paste_shot(im, CHAMPS(), (pad + half + 24, y + 4, half, box_h), top=True)
        else:
            paste_shot(im, CARD(), (pad, y + 4, W - 2 * pad, box_h))
        footer(d, pad, foot, (40, 24, 19))
    else:  # story: safe margins top and bottom for the app's chrome, screens stacked
        top = int(H * 0.08)
        y = text_block(d, pad, top, W - 2 * pad, [(c['kicker'], font(36, 'SemiBold'), AMBER), (c['head'], font(86), CHALK), (c['sub'], font(36, 'SemiLight'), MUTED)], gap=0.3)
        foot = H - band - 250                           # above the reply bar
        room = foot - 40 - (y + 10)
        if v == 'a':
            half, seed = (W - 2 * pad - 28) // 2, SEEDING()
            y0 = y + 10 + max(0, (room - int(seed.height * half / seed.width)) // 2)   # the pair, centered in the room
            paste_shot(im, seed, (pad, y0, half, room), top=True)
            paste_shot(im, CHAMPS(), (pad + half + 28, y0, half, room), top=True)
        else:
            paste_shot(im, CARD(), (pad, y + 10, W - 2 * pad, room))        # the card alone, as big as the width allows
        footer(d, pad, foot, (54, 32, 26))
    out = HERE / f'ad-{kind}-{v}.png'
    im.save(out, optimize=True)
    return out.name


if __name__ == '__main__':
    for v in COPY:
        for kind in ('feed', 'square', 'story'):
            print(make(kind, v))
