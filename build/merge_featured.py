"""Append hand-picked drives (built by `FEATURE=... python build.py`) to docs/data.json and pin them to dates.

    python merge_featured.py featured.json 401858488=2026-10-19 401858263=2026-10-20

The existing drives keep their ids and order, so no past or upcoming daily changes. Each new drive is flagged
`feat` (kept out of the daily, Cignetti and Saban rotations) and its coach's win chance is re-scored with the live
win-probability model, so player and coach are judged by the same numbers. D.featured maps a local date to a drive.
Running it again with the same game replaces that drive in place instead of adding a copy.
"""
import json, math, sys

DATA = 'C:/Users/pmcin/cfb-2min-drill/docs/data.json'


def clamp(x, a, b):
    return max(a, min(b, x))


def wp_live(W, s, T, ytg, down, dist, to_o, to_d, elo):
    """The site's wpModel (app.js), line for line."""
    if T <= 0:
        return 1.0 if s > 0 else 0.0 if s < 0 else clamp(0.5 + elo / 4000, 0.3, 0.7)
    q, v, e = clamp(T / 720, 0, 1), (100 - ytg) / 100, math.exp(-T / 30)
    f = [1, v, v * v, q, v * q, math.sqrt(q), 1 if down >= 3 else 0, math.log1p(min(dist, 30)) / 3, to_o / 3, to_d / 3,
         clamp(elo, -800, 800) / 400, 1 if down == 4 else 0, clamp(abs(s), 0, 24) / 8, e, e * v, e * v * v]
    c = next((i for i, (lo, hi) in enumerate(W['cats']) if lo <= s <= hi), 0)
    z = sum(W['w'][c * len(f) + i] * f[i] for i in range(len(f)))
    return 1 / (1 + math.exp(-z))


def main(src, pins):
    D = json.load(open(DATA, encoding='utf-8'))
    F = json.load(open(src, encoding='utf-8'))
    games = D['games']
    by_gid = {s['gid']: s for s in D['scen'] if s.get('feat')}
    D.setdefault('featured', {})
    for s in F['scen']:
        # the game row this drive points at, appended to the live game table
        row = F['games'][str(s['g'])] if str(s['g']) in F['games'] else F['games'][s['g']]
        gi = next((int(k) for k, v in games.items() if v == row), None)
        if gi is None:
            gi = max(int(k) for k in games) + 1
            games[str(gi)] = row
        s['g'] = gi
        st = s.pop('_cwp_state', None)
        if not st and s['result'] in ('DOWNS', 'TURNOVER ON DOWNS'):
            # the feed ends at the turnover: score it as the other team's ball at that spot
            last = [x for x in s['real'] if x.get('y') is not None and x.get('s') is not None and x['c'] not in ('timeout',)][-1]
            st = [s['ds'] - s['os'], float(last['s']), float(100 - last['y']), 1.0, 10.0, s['dto'], 0, s['elo'], False]
        if st:
            q_s, secs, ytg, down, dist, q_to, q_dto, elo, same = st
            s['cwp'] = round(wp_live(D['wp'], q_s, secs, ytg, down, dist, q_to, q_dto, elo) if same
                             else 1 - wp_live(D['wp'], q_s, secs, ytg, down, dist, q_to, q_dto, -elo), 3)
        s['feat'] = True
        old = by_gid.get(s['gid'])
        if old:  # replace in place, keep the id
            s['id'] = old['id']
            D['scen'][old['id']] = s
        else:
            s['id'] = len(D['scen'])
            D['scen'].append(s)
        for gid, day in pins:
            if gid == s['gid']:
                D['featured'][day] = s['id']
        print(f"drive {s['id']}: {s['coach']} ({s['os']}-{s['ds']}, {s['secs'] // 60}:{s['secs'] % 60:02d}, ytg {s['ytg']}, "
              f"TO {s['to']}/{s['dto']}) coach wp {s['cwp']} -> {[d for d, i in D['featured'].items() if i == s['id']]}")
    if 2026 not in D['years']:
        D['years'] = sorted(set(D['years']) | {s['year'] for s in D['scen']})
    json.dump(D, open(DATA, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    print('featured', D['featured'], '| drives', len(D['scen']))


if __name__ == '__main__':
    pins = [(int(a), b) for a, b in (x.split('=') for x in sys.argv[2:])]
    main(sys.argv[1], pins)
