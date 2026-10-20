"""Add a 0-100 rating for every FBS team-season to docs/data.json (D.ratings), for Tournament mode.

    python add_ratings.py            # writes this checkout's docs/data.json
    python add_ratings.py --dry-run  # prints the top of each season, writes nothing

Like merge_featured.py it only ADDS a key: drives, pools, models, games and D.featured come out byte-identical
(checked before writing). Run it again after build.py adds a season; build.py carries D.ratings over otherwise.

The rating, per season, from what the build already reads (raw/sched_<year>.csv for every final score, FCS
opponents included; the play-by-play for each team's division and conference that season):
  - win %, over every game (bowls and the playoff count)
  - SRS: average scoring margin, capped at 24 a game so a 70-0 over an FCS school buys nothing extra, plus the
    average SRS of the opponents (strength of schedule). FCS opponents are pooled into one team.
  - composite = 0.45 z(win %) + 0.55 z(SRS), z-scored within the season over its FBS teams, then 100 * Phi(z).
So 50 is the median FBS team of that season and the season's best lands around 99, whatever the season.
Seasons are normalized separately, so 2023 and 2025 teams sit on the same scale and new seasons slot in.
"""
import json, math, os, sys
import pandas as pd

RAW = 'C:/Users/pmcin/cfb-2min-drill/raw/'
DATA = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'data.json'))  # this checkout's site
CAP = 24          # points of margin that count in one game
W_WIN = 0.45      # composite weight of win %; the rest is SRS


def dumps(obj):
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False)


def season(year):
    p = pd.read_parquet(RAW + f'pbp_{year}.parquet', columns=['game_id', 'home_team_id', 'away_team_id', 'home_team_division',
                                                              'away_team_division', 'home_team_conference', 'away_team_conference'])
    p = p.drop_duplicates('game_id')
    div, conf = {}, {}
    for side in ('home', 'away'):
        for tid, d, c in p[[f'{side}_team_id', f'{side}_team_division', f'{side}_team_conference']].itertuples(index=False):
            div[int(tid)] = d
            if isinstance(c, str):
                conf[int(tid)] = c
    fbs = {t for t, d in div.items() if d == 'fbs'}
    s = pd.read_csv(RAW + f'sched_{year}.csv')
    s = s[(s.status == 'STATUS_FINAL') & s.home_score.notna() & s.away_score.notna()]
    FCS = -1  # every non-FBS opponent, pooled
    node = lambda t: t if t in fbs else FCS
    games = []  # (team, opp, margin) from both sides
    for r in s.itertuples(index=False):
        h, a = node(int(r.home_id)), node(int(r.away_id))
        if h == FCS and a == FCS:
            continue
        m = float(r.home_score) - float(r.away_score)
        games.append((h, a, m))
        games.append((a, h, -m))
    teams = sorted(fbs)
    rec = {t: dict(w=0, l=0, pf=0.0, n=0, opp=[], mc=0.0) for t in teams + [FCS]}
    for t, o, m in games:
        g = rec[t]
        g['n'] += 1; g['pf'] += m; g['opp'].append(o); g['mc'] += max(-CAP, min(CAP, m))
        if m > 0: g['w'] += 1
        elif m < 0: g['l'] += 1
    teams = [t for t in teams if rec[t]['n'] >= 6]  # a real season, not a team that shows up once in the feed
    # SRS by iteration: rating = capped average margin + average opponent rating, FBS mean pinned at 0
    srs = {t: 0.0 for t in rec}
    for _ in range(500):
        new = {t: rec[t]['mc'] / rec[t]['n'] + sum(srs[o] for o in rec[t]['opp']) / rec[t]['n'] for t in rec if rec[t]['n']}
        mu = sum(new[t] for t in teams) / len(teams)
        srs = {t: v - mu for t, v in new.items()}
    out = {}
    wp = {t: rec[t]['w'] / max(1, rec[t]['w'] + rec[t]['l']) for t in teams}
    z = lambda d: (lambda m, sd: {k: (v - m) / sd for k, v in d.items()})(sum(d.values()) / len(d), (sum((v - sum(d.values()) / len(d)) ** 2 for v in d.values()) / len(d)) ** .5 or 1)
    zw, zs = z(wp), z({t: srs[t] for t in teams})
    comp = {t: W_WIN * zw[t] + (1 - W_WIN) * zs[t] for t in teams}
    sd = (sum(v * v for v in comp.values()) / len(comp)) ** .5 or 1
    order = sorted(teams, key=lambda t: -comp[t])
    for rank, t in enumerate(order, 1):
        g = rec[t]
        out[str(t)] = dict(r=round(100 * 0.5 * (1 + math.erf(comp[t] / sd / math.sqrt(2))), 1), rk=rank, w=g['w'], l=g['l'],
                           conf=conf.get(t, ''), pd=round(g['pf'] / g['n'], 1), srs=round(srs[t], 1),
                           sos=round(sum(srs[o] for o in g['opp']) / g['n'], 1))
    return out


def main(dry):
    raw = open(DATA, encoding='utf-8').read()
    D = json.loads(raw)
    base = {k: v for k, v in D.items() if k != 'ratings'}
    if 'ratings' not in D:
        assert dumps(D) == raw, 'data.json does not round-trip byte for byte; refusing to rewrite it'
    years = sorted({s['year'] for s in D['scen'] if not s.get('feat')})  # complete seasons; featured drives are the current one
    R = {str(y): season(y) for y in years}
    for y, ts in R.items():
        top = sorted(ts.items(), key=lambda kv: kv[1]['rk'])[:12]
        print(y, len(ts), 'teams |', ', '.join(f"{D['teams'].get(t, {}).get('school', t)} {v['w']}-{v['l']} {v['r']}" for t, v in top))
    if dry:
        return
    before = dumps(base)
    after = dumps({**base, 'ratings': R})
    assert after.startswith(before[:-1]) and after.endswith('}'), 'only the ratings key may change'
    with open(DATA, 'w', encoding='utf-8') as f:
        f.write(after)
    print('wrote', DATA, 'ratings for', {y: len(v) for y, v in R.items()})


if __name__ == '__main__':
    main('--dry-run' in sys.argv)
