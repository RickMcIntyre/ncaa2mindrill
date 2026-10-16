"""Static ad creatives for NCAA Two-Minute Drill, in the three sizes the platforms want.

Run from the repo root:  python marketing/ads/make_ads.py
Writes marketing/ads/<size>-<variant>.png using the product shots in marketing/.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'marketing' / 'ads'
SHOT = ROOT / 'marketing' / 'field-pass-routes.png'
NIGHT, PANEL, LINE, CHALK, AMBER, MUTED = (12, 20, 32), (19, 32, 49), (42, 61, 87), (238, 242, 246), (243, 178, 60), (142, 160, 184)
FONTS = Path('C:/Windows/Fonts')


def font(size, bold=True):
    """Bahnschrift condensed when available (closest installed thing to the site's Saira Condensed), else Arial."""
    try:
        f = ImageFont.truetype(str(FONTS / 'bahnschrift.ttf'), size)
        try:
            f.set_variation_by_name('Bold SemiCondensed' if bold else 'SemiBold SemiCondensed')
        except Exception:
            pass
        return f
    except Exception:
        return ImageFont.truetype(str(FONTS / ('arialbd.ttf' if bold else 'arial.ttf')), size)


VARIANTS = {
    'a': ('ONE REAL COLLEGE DRIVE A DAY.', 'You call every snap. Then you are graded against the coach who actually called it.'),
    'b': ('DOWN 3. 1:46 LEFT. YOUR BALL.', 'The real score, clock and players from a real FBS game. Beat the head coach.'),
    'c': ('HE HAS A STAFF. YOU HAVE A BROWSER.', 'Call a real late-game drive, snap by snap, and see who did it better.'),
}
SIZES = {'feed-1200x628': (1200, 628), 'square-1080x1080': (1080, 1080), 'story-1080x1920': (1080, 1920)}


def wrap(draw, text, f, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=f) <= width:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines


def rounded(img, radius):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
    out = Image.new('RGBA', img.size)
    out.paste(img, (0, 0), mask)
    return out


def make(size_name, wh, variant, head, sub):
    W, H = wh
    im = Image.new('RGB', (W, H), NIGHT)
    d = ImageDraw.Draw(im)
    # a faint turf band at the bottom, like the share card
    band = int(H * 0.055)
    d.rectangle([0, H - band, W, H], fill=(47, 107, 58))
    for x in range(0, W, 60):
        d.line([x, H - band, x, H], fill=(255, 255, 255, 60), width=1)
    story = H > W
    pad = int(W * 0.06)
    shot = Image.open(SHOT).convert('RGB')
    if story:
        hf, sf, cf = font(int(W * 0.095)), font(int(W * 0.042), bold=False), font(int(W * 0.05))
        lines = wrap(d, head, hf, W - 2 * pad)
        y = int(H * 0.11)
        for ln in lines:
            d.text((pad, y), ln, font=hf, fill=CHALK); y += int(hf.size * 1.08)
        y += int(W * 0.02)
        for ln in wrap(d, sub, sf, W - 2 * pad):
            d.text((pad, y), ln, font=sf, fill=MUTED); y += int(sf.size * 1.35)
        sw = W - 2 * pad; sh = int(shot.height * sw / shot.width)
        sy = y + int(W * 0.05)
        im.paste(rounded(shot.resize((sw, sh)), 24), (pad, sy), rounded(shot.resize((sw, sh)), 24))
        d.rounded_rectangle([pad, sy, pad + sw, sy + sh], radius=24, outline=LINE, width=3)
        cy = sy + sh + int(W * 0.07)
        d.text((pad, cy), 'ncaa2mindrill.com', font=cf, fill=AMBER)
        d.text((pad, cy + int(cf.size * 1.2)), 'Free. Hard modes $0.99 once.', font=font(int(W * 0.034), bold=False), fill=MUTED)
    else:
        colw = int(W * 0.5)
        hf, sf, cf = font(int(W * 0.056)), font(int(W * 0.024), bold=False), font(int(W * 0.03))
        # centre the text block vertically beside the shot
        block = len(wrap(d, head, hf, colw - pad)) * int(hf.size * 1.08) + int(H * 0.03) + len(wrap(d, sub, sf, colw - pad)) * int(sf.size * 1.4) + int(H * 0.05) + int(cf.size * 1.25) + int(W * 0.02 * 1.3)
        y = max(pad, (H - band - block) // 2)
        for ln in wrap(d, head, hf, colw - pad):
            d.text((pad, y), ln, font=hf, fill=CHALK); y += int(hf.size * 1.08)
        y += int(H * 0.03)
        for ln in wrap(d, sub, sf, colw - pad):
            d.text((pad, y), ln, font=sf, fill=MUTED); y += int(sf.size * 1.4)
        y += int(H * 0.05)
        d.text((pad, y), 'ncaa2mindrill.com', font=cf, fill=AMBER)
        d.text((pad, y + int(cf.size * 1.25)), 'Free. Hard modes $0.99 once.', font=font(int(W * 0.02), bold=False), fill=MUTED)
        sw = W - colw - pad; sh = int(shot.height * sw / shot.width)
        if sh > H - band - 2 * pad:
            sh = H - band - 2 * pad; sw = int(shot.width * sh / shot.height)
        sx, sy = W - pad - sw, (H - band - sh) // 2
        r = rounded(shot.resize((sw, sh)), 20)
        im.paste(r, (sx, sy), r)
        d.rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=20, outline=LINE, width=3)
    out = OUT / f'{size_name}-{variant}.png'
    im.save(out, optimize=True)
    return out


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for sn, wh in SIZES.items():
        for v, (head, sub) in VARIANTS.items():
            print(make(sn, wh, v, head, sub).name)
