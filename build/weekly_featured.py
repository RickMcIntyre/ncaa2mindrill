"""Every Sunday: put last Saturday's biggest late drives on the site, one a day, biggest first.

    python weekly_featured.py                 # the real run: fetch, rank, build, pin Sun..Sat, commit, push
    python weekly_featured.py --dry-run       # fetch and rank only, print the picks
    python weekly_featured.py --saturday 2026-10-17 --start 2026-10-19 --days 2 --no-push

Exit codes: 0 done, 2 already done for this weekend, 3 the feed doesn't have the whole slate yet (try again later),
1 anything else. Safe to run several times: once this Sunday is pinned it stops at exit 2.

A drive qualifies when the offense starts it in the 4th quarter with 0:20-4:00 left, trailing by 1-16 or tied, at
least 20 yards from the end zone, with a live chance (5-92% by the feed's win probability). Each game contributes its
best drive. "Biggest" weighs how much the drive swung the game, how wild the game's fourth quarter was, how big the
two programs are (pregame Elo), and a bonus for go-ahead scores and true last chances.
"""
import argparse, datetime as dt, json, math, os, re, subprocess, sys, urllib.request
import numpy as np
import pandas as pd

ROOT = 'C:/Users/pmcin/cfb-2min-drill'
RAW = ROOT + '/raw/'
DATA = ROOT + '/docs/data.json'
REL = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/'
FILES = [('cfbfastR_cfb_pbp', 'play_by_play_{y}.parquet', 'pbp_{y}.parquet'),
         ('espn_cfb_game_rosters', 'game_rosters_{y}.parquet', 'rost_{y}.parquet'),
         ('espn_cfb_schedules', 'cfb_schedule_{y}.csv', 'sched_{y}.csv'),
         ('espn_cfb_coach_tendencies', 'coach_tendencies_{y}.parquet', 'ct_{y}.parquet')]
ET = dt.timezone(dt.timedelta(hours=-4))  # games are dated by Eastern kickoff (EDT through early Nov is close enough)


def log(*a):
    print(*a, flush=True)


def fetch(season, after_utc):
    """Download this season's files; return False if the play-by-play wasn't refreshed after `after_utc`."""
    fresh = True
    for tag, name, local in FILES:
        meta = json.load(urllib.request.urlopen(REL + tag, timeout=60))
        asset = next((a for a in meta['assets'] if a['name'] == name.format(y=season)), None)
        if not asset:
            raise SystemExit(f'no {name.format(y=season)} in {tag}')
        upd = dt.datetime.fromisoformat(asset['updated_at'].replace('Z', '+00:00'))
        if tag == 'cfbfastR_cfb_pbp' and upd < after_utc:
            fresh = False
        dest = RAW + local.format(y=season)
        tmp = dest + '.part'
        urllib.request.urlretrieve(asset['browser_download_url'], tmp)
        os.replace(tmp, dest)
        log(f'  {local.format(y=season)}: {os.path.getsize(dest) // 1024} KB, feed updated {asset["updated_at"]}')
    return fresh


def possession_over(pt):
    pt = str(pt)
    return ('Interception' in pt or 'Touchdown' in pt or 'Fumble Recovery (Opponent)' in pt or pt.startswith('Punt')
            or pt == 'Blocked Punt' or pt == 'Safety' or pt.startswith('Field Goal') or pt == 'Blocked Field Goal')


def clock_of(text):
    m = re.match(r'\((\d+):(\d+)\)', str(text))
    return (f'{m.group(1)}:{m.group(2)}', int(m.group(1)) * 60 + int(m.group(2))) if m else (None, None)


def rank(season, saturday):
    s = pd.read_csv(RAW + f'sched_{season}.csv')
    s['et'] = pd.to_datetime(s.game_date, utc=True).dt.tz_convert(ET).dt.date
    week = s[(s.et >= saturday - dt.timedelta(days=2)) & (s.et <= saturday)]          # Thursday through Saturday
    if not len(week):
        raise SystemExit(3)
    cols = ['game_id', 'pos_team', 'def_pos_team', 'period', 'down', 'distance', 'yards_to_goal', 'play_type', 'play_text',
            'pos_team_score', 'def_pos_team_score', 'wp_before', 'game_play_number', 'home', 'away', 'pass', 'rush', 'sack',
            'home_team_division', 'away_team_division', 'home_team_pregame_elo', 'away_team_pregame_elo']
    p = pd.read_parquet(RAW + f'pbp_{season}.parquet', columns=cols)
    p = p[p.game_id.isin(week.game_id) & (p.home_team_division == 'fbs') & (p.away_team_division == 'fbs')]
    fbs_games = set(p.game_id)
    finals = week[week.game_id.isin(fbs_games)]
    # the whole FBS slate has to be final and in the feed through the 4th quarter
    sat = finals[finals.et == saturday]
    have_q4 = set(p[p.period >= 4].game_id)
    missing = [r.game_id for r in sat.itertuples() if r.status != 'STATUS_FINAL' or r.game_id not in have_q4]
    if not len(sat) or len(missing) > max(1, len(sat) // 20):
        log(f'feed not ready: {len(sat)} Saturday FBS games, {len(missing)} missing or unfinished')
        raise SystemExit(3)
    meta = finals.set_index('game_id')
    rows = []
    for gid, g in p.sort_values(['game_id', 'game_play_number']).groupby('game_id'):
        m = meta.loc[gid]
        hs, as_ = m.home_score, m.away_score
        # game chaos: 4th quarter / OT win-chance swing, the winner's lowest point, lead changes, overtime
        hw = np.where(g.pos_team == g.home, g.wp_before, 1 - g.wp_before).astype(float)
        late = (g.period >= 4).values
        hwl = hw[late]; hwl = hwl[~np.isnan(hwl)]
        if len(hwl) < 5:
            continue
        diff = np.where(g.pos_team == g.home, g.pos_team_score - g.def_pos_team_score, g.def_pos_team_score - g.pos_team_score)[late]
        sign = np.sign(diff)
        chaos = (np.abs(np.diff(hwl)).sum() + 2 * (1 - (hwl if hs > as_ else 1 - hwl).min())
                 + 0.5 * int(((sign[1:] != sign[:-1]) & (sign[1:] != 0)).sum()) + 0.7 * int((g.period > 4).any()) + 0.5 * (abs(hs - as_) <= 3))
        elo = np.nanmean([g.home_team_pregame_elo.iloc[0], g.away_team_pregame_elo.iloc[0]])
        prom = float(np.clip((elo - 1500) / 350, -1, 1.6)) if not math.isnan(elo) else 0.0   # big programs draw people
        # possessions: follow the offense (drive ids are unreliable); scrimmage plays and kneels, Q4 and overtime
        kneel = g.play_text.fillna('').str.contains('kneel', case=False)
        sc = g[((g['pass'] == 1) | (g.rush == 1) | (g.sack == 1) | kneel) & (g.period >= 4)]
        poss, cur, ended = [], None, False
        for r in sc.itertuples(index=False):
            if cur is None or r.pos_team != cur['team'] or ended:   # the feed sometimes keeps the team after a score or turnover
                cur = dict(team=r.pos_team, rows=[]); poss.append(cur)
            cur['rows'].append(r)
            ended = possession_over(r.play_type)
        for i, d in enumerate(poss):
            r0 = d['rows'][0]
            if r0.period != 4 or any('kneel' in str(x.play_text).lower() for x in d['rows']):
                continue                                                   # a team that knelt chose not to play it
            clk, secs = clock_of(r0.play_text)
            if not clk or not (20 <= secs <= 240):
                continue
            sdiff = r0.pos_team_score - r0.def_pos_team_score
            wp0 = r0.wp_before
            if not (-16 <= sdiff <= 0) or not (20 <= r0.yards_to_goal <= 99) or pd.isna(wp0) or not (0.05 <= wp0 <= 0.92):
                continue
            nxt = poss[i + 1]['rows'][0] if i + 1 < len(poss) else None
            if nxt is not None and not pd.isna(nxt.wp_before):
                wp1 = nxt.wp_before if nxt.pos_team == d['team'] else 1 - nxt.wp_before
            else:
                mine = hs if d['team'] == g.home.iloc[0] else as_
                theirs = as_ if d['team'] == g.home.iloc[0] else hs
                wp1 = 1.0 if mine > theirs else 0.0 if mine < theirs else 0.5
            last = d['rows'][-1]
            after = (last.pos_team_score - last.def_pos_team_score)
            clutch = 0.5 if (sdiff <= 0 and after > 0) or (sdiff < 0 and after == 0) else 0.0
            if nxt is None or nxt.period > 4 or (clock_of(nxt.play_text)[1] or 0) < 20:
                clutch += 0.3                                                          # the last real chance in regulation
            score = 0.08 * chaos + 1.2 * abs(wp1 - wp0) + 1.2 * prom + clutch + (0.2 if secs <= 150 else 0)
            rows.append(dict(gid=int(gid), clock=clk, secs=secs, team=d['team'], opp=r0.def_pos_team, down=f'{sdiff:+d}',
                             ytg=int(r0.yards_to_goal), wp0=round(float(wp0), 2), wp1=round(float(wp1), 2), chaos=round(chaos, 1),
                             elo=round(float(elo)), score=round(score, 2), game=f'{m.away_team} at {m.home_team} {as_}-{hs}'))
    df = pd.DataFrame(rows)
    if not len(df):
        raise SystemExit('no qualifying drives')
    return df.sort_values('score', ascending=False).drop_duplicates('gid')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--saturday', help='YYYY-MM-DD (default: the most recent Saturday)')
    ap.add_argument('--start', help='first date to pin (default: the Sunday after that Saturday)')
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--no-fetch', action='store_true')
    ap.add_argument('--no-push', action='store_true')
    a = ap.parse_args()
    today = dt.date.today()
    saturday = dt.date.fromisoformat(a.saturday) if a.saturday else today - dt.timedelta(days=(today.weekday() - 5) % 7)
    start = dt.date.fromisoformat(a.start) if a.start else saturday + dt.timedelta(days=1)
    season = saturday.year if saturday.month >= 7 else saturday.year - 1
    days = [start + dt.timedelta(days=i) for i in range(a.days)]
    log(f'Saturday {saturday}, season {season}, pinning {days[0]}..{days[-1]}')

    D = json.load(open(DATA, encoding='utf-8'))
    if not a.dry_run and str(days[0]) in D.get('featured', {}):
        pinned = D['scen'][D['featured'][str(days[0])]]
        if pinned.get('date', '') >= str(saturday - dt.timedelta(days=2)):
            log(f'already done: {days[0]} is {pinned["coach"]} ({pinned["date"]})')
            sys.exit(2)

    if not a.no_fetch:
        after = dt.datetime.combine(saturday + dt.timedelta(days=1), dt.time(6, 0), dt.timezone.utc)   # 2am ET Sunday
        if not fetch(season, after):
            log('feed not refreshed since Saturday night yet')
            sys.exit(3)
    df = rank(season, saturday)
    pd.set_option('display.width', 240)
    log(df.head(12).to_string(index=False))
    picks = df.head(len(days))
    if a.dry_run:
        return

    feature = f'{season}:' + ','.join(f'{r.gid}@{r.clock}' for r in picks.itertuples())
    out = ROOT + '/build/featured.json'
    log('building', feature)
    env = dict(os.environ, FEATURE=feature, FEATURE_OUT=out)
    subprocess.run([sys.executable, 'build.py'], cwd=ROOT + '/build', env=env, check=True)
    pins = [f'{r.gid}={d}' for r, d in zip(picks.itertuples(), days)]
    subprocess.run([sys.executable, 'merge_featured.py', out, *pins], cwd=ROOT + '/build', check=True)

    # sanity: every pinned day resolves to a playable drive
    D = json.load(open(DATA, encoding='utf-8'))
    for d in days[:len(picks)]:
        s = D['scen'][D['featured'][str(d)]]
        L = s['lineup']
        assert L['qb']['name'] and len([r for r in L['rec'] if r['pos'] == 'WR']) >= 3 and s['real'], f'thin drive on {d}'
        log(f'  {d}: {s["coach"]} vs {s["dcoach"]}, {s["os"]}-{s["ds"]}, {s["secs"] // 60}:{s["secs"] % 60:02d} at own {100 - s["ytg"]}, coach {s["cwp"]:.0%}')
    if a.no_push:
        return
    msg = (f'Featured drives for {days[0]:%b %d}-{days[-1]:%b %d}: the biggest late drives of Saturday {saturday:%b %d}\n\n'
           + '\n'.join(f'{d}: {r.game} ({r.team}, {r.clock})' for r, d in zip(picks.itertuples(), days))
           + '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n')
    git = ['git', '-c', 'user.name=Rick McIntyre', '-c', 'user.email=pmcintyre1823@gmail.com']
    subprocess.run(git + ['add', 'docs/data.json'], cwd=ROOT, check=True)
    subprocess.run(git + ['commit', '-q', '-m', msg], cwd=ROOT, check=True)
    subprocess.run(['git', 'push', '-q', 'origin', 'HEAD'], cwd=ROOT, check=True)
    log('pushed')


if __name__ == '__main__':
    main()
