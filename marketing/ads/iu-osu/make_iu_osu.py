"""Ad images for Monday's daily (Ohio State at Indiana), built from real screenshots of the site.

    python marketing/ads/iu-osu/make_iu_osu.py      (from the repo root)

Writes ad-{feed,square,story}-{a,b}.png next to this file. Variant a leads with what happened Saturday,
variant b with the situation. No coach names and no school logos in the ad copy; the fan-made line stays on.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
NIGHT, LINE, CHALK, AMBER, MUTED, TURF = (12, 20, 32), (42, 61, 87), (238, 242, 246), (243, 178, 60), (142, 160, 184), (47, 107, 58)
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


def paste_shot(im, shot, box, radius=22):
    """Fit `shot` inside box (x, y, w, h), keep aspect, round the corners, draw a thin frame. Returns the used rect."""
    x, y, w, h = box
    s = min(w / shot.width, h / shot.height)
    sw, sh = int(shot.width * s), int(shot.height * s)
    sx, sy = x + (w - sw) // 2, y + (h - sh) // 2
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


COPY = {
    'a': dict(kicker='MONDAY\'S DAILY DRIVE',
              head='Indiana got to the\nOhio State 27.\nYou need 27 more.',
              sub='Down 4, 3:05 left, your ball at the IU 30. Saturday\'s real drive is Monday\'s daily. You call every snap.',
              hero='crop-down-by-4.png', second='crop-mossed-him.png'),
    'b': dict(kicker='OHIO STATE AT INDIANA · MONDAY',
              head='Down 4. 3:05 left.\nYour call.',
              sub='Call every snap of Indiana\'s last drive from Saturday. Real players, real clock, every snap animated. Then see how you stack up.',
              hero='crop-mossed-him.png', second='crop-down-by-4.png'),
}
CTA = 'Free at ncaa2mindrill.com'
FINE = 'Fan-made. Not affiliated with the NCAA or its schools.'


def make(kind, v):
    c = COPY[v]
    W, H = {'feed': (1200, 628), 'square': (1080, 1080), 'story': (1080, 1920)}[kind]
    im = Image.new('RGB', (W, H), NIGHT)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 10, H], fill=CRIMSON)                       # a thin team-color rail, no logos
    band = int(H * (0.05 if kind != 'feed' else 0.06))
    d.rectangle([0, H - band, W, H], fill=TURF)
    for x in range(0, W, 60):
        d.line([x, H - band, x, H], fill=(90, 140, 100), width=1)
    pad = int(W * 0.06)
    hero = Image.open(HERE / c['hero']).convert('RGB')
    second = Image.open(HERE / c['second']).convert('RGB')
    if kind == 'feed':
        col = int(W * 0.48)
        y = int(pad * 0.8)
        y = text_block(d, pad, y, col - pad - 24, [(c['kicker'], font(22, 'SemiBold'), AMBER), (c['head'], font(46), CHALK), (c['sub'], font(23, 'SemiLight'), MUTED)])
        d.text((pad, H - band - 92), CTA, font=font(32), fill=AMBER)
        d.text((pad, H - band - 46), FINE, font=font(16, 'SemiLight'), fill=MUTED)
        paste_shot(im, hero, (col + 10, pad, W - col - pad - 10, H - band - 2 * pad))
    elif kind == 'square':
        y = text_block(d, pad, pad, W - 2 * pad, [(c['kicker'], font(30, 'SemiBold'), AMBER), (c['head'], font(70), CHALK)], gap=0.25)
        top = y + 10
        _, sy, _, sh = paste_shot(im, hero, (pad, top, W - 2 * pad, H - band - top - 190))
        y = sy + sh + 28
        y = text_block(d, pad, y, W - 2 * pad, [(c['sub'], font(28, 'SemiLight'), MUTED)], gap=0.1)
        d.text((pad, H - band - 92), CTA, font=font(40), fill=AMBER)
        d.text((pad, H - band - 40), FINE, font=font(20, 'SemiLight'), fill=MUTED)
    else:  # story: hero and the second shot stacked, safe margins top and bottom for the app's chrome
        top = int(H * 0.08)
        y = text_block(d, pad, top, W - 2 * pad, [(c['kicker'], font(36, 'SemiBold'), AMBER), (c['head'], font(84), CHALK), (c['sub'], font(34, 'SemiLight'), MUTED)], gap=0.3)
        cta_y = H - band - 170                          # the CTA and fine print sit above the turf stripe
        room = cta_y - 40 - (y + 10)
        _, sy, _, sh = paste_shot(im, hero, (pad, y + 10, W - 2 * pad, int(room * 0.48)))
        paste_shot(im, second, (pad, sy + sh + 30, W - 2 * pad, cta_y - 40 - (sy + sh + 30)))
        d.text((pad, cta_y), CTA, font=font(54), fill=AMBER)
        d.text((pad, cta_y + 80), FINE, font=font(26, 'SemiLight'), fill=MUTED)
    out = HERE / f'ad-{kind}-{v}.png'
    im.save(out, optimize=True)
    return out.name


if __name__ == '__main__':
    for v in COPY:
        for kind in ('feed', 'square', 'story'):
            print(make(kind, v))
