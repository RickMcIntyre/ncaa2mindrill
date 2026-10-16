"""Build data.json for the college Two-Minute Drill game from cfbfastR play-by-play.

Inputs live in ../raw (see README). Output: ../site/data.json
"""
import json, re, math, random
import numpy as np
import pandas as pd
from load import load

RAW = 'C:/Users/pmcin/cfb-2min-drill/raw/'
OUT = 'C:/Users/pmcin/cfb-2min-drill/docs/data.json'
YEARS = (2023, 2024, 2025)
rng = random.Random(7)

p = load(YEARS).sort_values(['game_id', 'game_play_number']).reset_index(drop=True)
p['text'] = p.play_text.fillna('').astype(str)
p['play_type'] = p.play_type.fillna('Uncategorized')
p['secs'] = p.adj_TimeSecsRem
print('plays', len(p))

# ---------- teams ----------
tm = pd.read_csv(RAW + 'teams_2025.csv')
tm = tm[['team_id', 'abbreviation', 'location', 'nickname', 'name', 'color', 'alternate_color', 'conference_short_name']]
team_name_to_id = {}
for side in ('home', 'away'):
    for n, i in p[[side, f'{side}_team_id']].drop_duplicates().itertuples(index=False):
        team_name_to_id[n] = int(i)
used_ids = set(team_name_to_id.values())
teams = {}
for r in tm.itertuples(index=False):
    if int(r.team_id) in used_ids:
        teams[int(r.team_id)] = dict(abbr=r.abbreviation, school=r.location, mascot=r.name,
                                     color='#' + str(r.color or '444444'), alt='#' + str(r.alternate_color or 'ffffff'),
                                     conf=r.conference_short_name if isinstance(r.conference_short_name, str) else '')
for n, i in team_name_to_id.items():
    teams.setdefault(i, dict(abbr=n[:4].upper(), school=n, mascot='', color='#444444', alt='#ffffff', conf=''))
    teams[i]['school'] = n  # use pbp naming for consistency

# ---------- coaches (one head coach per team-season) ----------
coach = {}
for y in YEARS:
    c = pd.read_parquet(RAW + f'ct_{y}.parquet', columns=['season', 'pos_team_id', 'coach', 'role', 'games'])
    c = c[c.role == 'HC'].sort_values('games', ascending=False).drop_duplicates('pos_team_id')
    for r in c.itertuples(index=False):
        coach[(int(r.season), int(r.pos_team_id))] = r.coach

# interim coaches: parse the wikipedia infobox cached by wiki_coaches.py
import glob, os
WIKI = {}
def clean(v):
    v = re.sub(r'<ref[^>]*/>|<ref.*?</ref>|<!--.*?-->', '', v, flags=re.S)
    v = re.sub(r'\[\[([^\]|]*\|)?([^\]]*)\]\]', r'\2', v)
    v = re.sub(r'\{\{[^}]*\}\}', '', v)
    return re.sub(r'\s+', ' ', v).strip(' *')
WORDS = dict(one=1, two=2, three=3, four=4, five=5, six=6, seven=7, eight=8, nine=9, ten=10, eleven=11, twelve=12)
for fn in glob.glob(RAW + 'wiki/*.txt'):
    y, tid = os.path.basename(fn)[:-4].split('_')
    w = open(fn, encoding='utf-8').read()
    w = re.sub(r'\[\[([^\]|]*\|)?([^\]]*)\]\]', r'\2', w)  # unlink before splitting fields on '|'
    f = dict(re.findall(r'\|\s*(\w+)\s*=\s*([^\n|]*)', w))
    hc = clean(f.get('head_coach', ''))
    if not hc:
        continue
    entry = dict(hc=hc, splits=[])
    for k in ('', '2', '3'):
        g = f.get('hc_games' + k, '').lower()
        if 'regular season' in g and clean(f.get('head_coach' + (str(int(k or 1) + 1)), '')):
            entry['splits'].append((99, '', clean(f.get('head_coach' + (str(int(k or 1) + 1)), ''))))
        m = re.search(r'first (\w+) games?', g)
        if m and (m.group(1).isdigit() or m.group(1) in WORDS):
            entry['splits'].append((int(m.group(1)) if m.group(1).isdigit() else WORDS[m.group(1)], clean(f.get('head_coach' + (k or ''), '')), clean(f.get('head_coach' + (str(int(k or 1) + 1)), ''))))
    WIKI[(int(y), int(tid))] = entry
print('wiki coaches', len(WIKI), 'with splits', sum(1 for e in WIKI.values() if e['splits']))

# game number within the season for each team (regular + post, by date)
gdates = p.groupby('game_id').agg(d=('start_date', 'first'), h=('home_team_id', 'first'), a=('away_team_id', 'first'), y=('year', 'first'))
GAMENO = {}
for y in YEARS:
    gy = gdates[gdates.y == y].sort_values('d')
    cnt = {}
    for gid, r in gy.iterrows():
        for tid in (int(r.h), int(r.a)):
            cnt[tid] = cnt.get(tid, 0) + 1
            GAMENO[(gid, tid)] = cnt[tid]


def coach_for(year, tid, gid):
    e = WIKI.get((year, tid))
    if e:
        n = GAMENO.get((gid, tid), 1)
        name = e['hc']
        for first_n, a, b in e['splits']:
            if first_n == 99:
                if gmeta.loc[gid].st == 'postseason':
                    name = b
            elif n > first_n and b:
                name = b
        return name
    return coach.get((year, tid), 'Unknown')


# ---------- play classification ----------
SCRIM = {'Rush', 'Rushing Touchdown', 'Pass Reception', 'Pass Incompletion', 'Passing Touchdown', 'Sack',
         'Interception Return', 'Interception Return Touchdown', 'Pass Completion', 'Fumble Recovery (Opponent)',
         'Fumble Recovery (Own)', 'Fumble Return Touchdown', 'Fumble Recovery (Opponent) Touchdown', 'Safety'}
t = p.text
p['kneel'] = t.str.contains('kneel', case=False)
p['spike'] = t.str.contains(r'\bspike', case=False)
p['is_int'] = p.play_type.str.startswith('Interception')
p['is_sack'] = (p.play_type == 'Sack') | t.str.contains(' sacked ', case=False)
p['is_passplay'] = p.play_type.isin(['Pass Reception', 'Pass Incompletion', 'Passing Touchdown', 'Pass Completion']) | p.is_int
p['is_rushplay'] = p.play_type.isin(['Rush', 'Rushing Touchdown']) | (
    p.play_type.str.startswith('Fumble') & p.position_rush.notna())
p['fumble_lost'] = p.play_type.isin(['Fumble Recovery (Opponent)', 'Fumble Recovery (Opponent) Touchdown', 'Fumble Return Touchdown'])
p['td'] = p.play_type.isin(['Rushing Touchdown', 'Passing Touchdown'])
p['oob'] = t.str.contains('out of bounds', case=False)
dd = t.str.extract(r'pass (?:complete|incomplete) (short|deep) (left|middle|right)', flags=re.I)
p['depth'] = dd[0].str.lower()
p['pdir'] = dd[1].str.lower()
rd = t.str.extract(r'\brush (left|middle|right)\b', flags=re.I)
p['rdir'] = rd[0].str.lower()
p['complete'] = p.play_type.isin(['Pass Reception', 'Passing Touchdown', 'Pass Completion'])
p['yg'] = p.yards_gained.fillna(0).clip(-30, 100)


def zone(ytg):
    return 'g' if ytg <= 10 else 'r' if ytg <= 20 else 'o' if ytg <= 50 else 'w'


p['zone'] = p.yards_to_goal.fillna(75).map(zone)
p['dg'] = np.where(p.down.fillna(1) >= 3, 'L', 'E')
p['sy'] = np.where(p.distance.fillna(10) <= 2, 'S', 'N')

# ---------- games ----------
games = {}
sched = []
for y in YEARS:
    s = pd.read_csv(RAW + f'sched_{y}.csv')
    sched.append(s[['game_id', 'game_date', 'home_score', 'away_score', 'venue']])
sched = pd.concat(sched).drop_duplicates('game_id').set_index('game_id')

gmeta = p.groupby('game_id').agg(year=('year', 'first'), week=('week', 'first'), st=('season_type', 'first'),
                                  home=('home', 'first'), away=('away', 'first'), hid=('home_team_id', 'first'),
                                  aid=('away_team_id', 'first'), neutral=('neutral_site', 'first'),
                                  helo=('home_team_pregame_elo', 'first'), aelo=('away_team_pregame_elo', 'first'),
                                  date=('start_date', 'first'))
game_idx = {}


def game_ref(gid):
    if gid not in game_idx:
        g = gmeta.loc[gid]
        game_idx[gid] = len(game_idx)
        games[game_idx[gid]] = [int(g.year), int(g.week), 1 if g.st == 'postseason' else 0, int(g.hid), int(g.aid),
                                1 if g.neutral else 0]
    return game_idx[gid]


# ---------- team ratings (EPA/play) ----------
sc = p[(p.is_passplay | p.is_sack | p.is_rushplay) & ~p.kneel & ~p.spike & p.EPA.notna()].copy()
sc['kind'] = np.where(sc.is_rushplay, 'rush', 'pass')
sc['off_id'] = sc.pos_team.map(team_name_to_id)
sc['def_id'] = sc.def_pos_team.map(team_name_to_id)
lg = sc.groupby('kind').EPA.mean().to_dict()
offr = sc.groupby(['year', 'off_id', 'kind']).EPA.agg(['mean', 'count'])
defr = sc.groupby(['year', 'def_id', 'kind']).EPA.agg(['mean', 'count'])


def shrink(m, n, prior, k=150):
    return (m * n + prior * k) / (n + k)


def rating(year, tid):
    r = {}
    for kind in ('pass', 'rush'):
        o = offr.loc[(year, tid, kind)] if (year, tid, kind) in offr.index else None
        d = defr.loc[(year, tid, kind)] if (year, tid, kind) in defr.index else None
        r['o' + kind[0]] = round(shrink(o['mean'], o['count'], lg[kind]) - lg[kind], 3) if o is not None else 0
        r['d' + kind[0]] = round(shrink(d['mean'], d['count'], lg[kind]) - lg[kind], 3) if d is not None else 0
    return r


# player season stats
# position by (team, name): taken from the ESPN participant columns where present
pos_rows = []
for nm, ps_ in (('target_player', 'position_target'), ('rush_player', 'position_rush')):
    d_ = sc[[nm, ps_, 'off_id']].dropna()
    pos_rows.append(d_.rename(columns={nm: 'name', ps_: 'pos'}))
pos_df = pd.concat(pos_rows)
POS = pos_df.groupby(['off_id', 'name']).pos.agg(lambda x: x.value_counts().index[0]).to_dict()
# jersey numbers from game rosters
JERSEY = {}
for y in YEARS:
    ro = pd.read_parquet(RAW + f'rost_{y}.parquet', columns=['team_id', 'full_name', 'jersey'])
    ro = ro.dropna().drop_duplicates(['team_id', 'full_name'], keep='last')
    for r in ro.itertuples(index=False):
        JERSEY[(y, int(r.team_id), r.full_name)] = str(r.jersey)

tg = sc[sc.is_passplay & sc.receiver_player_name.notna()].copy()
tg['pos'] = [POS.get((o, n), 'WR') for o, n in zip(tg.off_id, tg.receiver_player_name)]
rec = tg.groupby(['year', 'off_id', 'receiver_player_name']).agg(n=('EPA', 'size'), epa=('EPA', 'mean'), pos=('pos', 'first'),
                                                                 c=('complete', 'mean'), yds=('yg', 'mean'))
ru = sc[sc.is_rushplay & sc.rush_player.notna()]
rus = ru.groupby(['year', 'off_id', 'rush_player']).agg(n=('EPA', 'size'), epa=('EPA', 'mean'), pos=('position_rush', 'first'), yds=('yg', 'mean'))
qbs = sc[sc.kind == 'pass'].groupby(['year', 'off_id', 'passer_player_name']).agg(n=('EPA', 'size'), epa=('EPA', 'mean'),
                                                                                   ints=('is_int', 'mean'), sacks=('is_sack', 'mean'))
lg_tgt = tg.groupby('pos').EPA.mean().to_dict()
lg_int = sc[sc.kind == 'pass'].is_int.mean()
lg_sack = sc[sc.kind == 'pass'].is_sack.mean()
REC_IDX = set(rec.index.droplevel(2))
RUS_IDX = set(rus.index.droplevel(2))
QB_IDX = set(qbs.index.droplevel(2))


def nkey(name):
    """'Jeremiyah Love Jr.' -> 'j love' so roster and play-by-play spellings line up."""
    parts = [x for x in re.sub(r'[^a-z ]', '', str(name).lower().replace('.', ' ')).split() if x not in ('jr', 'sr', 'ii', 'iii', 'iv')]
    return f'{parts[0][0]} {parts[-1]}' if len(parts) >= 2 else ' '.join(parts)


JERSEY2 = {}
for (y, tid, name), j in JERSEY.items():
    JERSEY2.setdefault((y, tid, nkey(name)), j)


def num(year, tid, name):
    return JERSEY.get((year, tid, name)) or JERSEY2.get((year, tid, nkey(name)), '')


def lineup(year, tid, gid):
    """Players who touched the ball for this team in this game, with their season numbers."""
    gp = p[(p.game_id == gid) & (p.pos_team.map(team_name_to_id) == tid)]
    out = {}
    q = qbs.loc[(year, tid)] if (year, tid) in QB_IDX else None
    gq = gp.passer_player_name.value_counts()
    qname = gq.index[0] if len(gq) else (q.n.idxmax() if q is not None else 'QB')
    if q is not None and qname in q.index:
        r = q.loc[qname]
        lq = sc[sc.kind == 'pass'].EPA.mean()
        out['qb'] = dict(name=qname, num=num(year, tid, qname), epa=round(r.epa, 2), n=int(r.n), int=round(r.ints, 3),
                         sack=round(r.sacks, 3), adj=round(shrink(r.epa, r.n, lq, 80) - lq, 3))
    else:
        out['qb'] = dict(name=qname, num='', epa=0, n=0, int=round(lg_int, 3), sack=round(lg_sack, 3), adj=0)
    recs = rec.loc[(year, tid)] if (year, tid) in REC_IDX else pd.DataFrame()
    in_game = set(gp.receiver_player_name.dropna()) | set(gp.rush_player.dropna())
    picks = []
    for pos, k in (('WR', 3), ('TE', 1), ('RB', 1)):
        if not len(recs):
            break
        sub = recs[(recs.pos == pos) & recs.index.isin(in_game)].sort_values('n', ascending=False).head(k)
        if len(sub) < k:
            more = recs[(recs.pos == pos) & ~recs.index.isin(sub.index)].sort_values('n', ascending=False).head(k - len(sub))
            sub = pd.concat([sub, more])
        for name, r in sub.iterrows():
            picks.append(dict(name=name, num=num(year, tid, name), pos=pos, n=int(r.n), c=round(r.c, 2), yds=round(r.yds, 1),
                              adj=round(shrink(r.epa, r.n, lg_tgt.get(pos, 0), 40) - lg_tgt.get(pos, 0), 3)))
    out['rec'] = picks
    rr = rus.loc[(year, tid)] if (year, tid) in RUS_IDX else pd.DataFrame()
    rb = rr[(rr.pos == 'RB') & rr.index.isin(in_game)].sort_values('n', ascending=False) if len(rr) else rr
    if len(rr) and not len(rb):
        rb = rr[rr.pos == 'RB'].sort_values('n', ascending=False)
    if len(rr) and len(rb):
        name, r = next(rb.iterrows())
        lgr = ru[ru.position_rush == 'RB'].EPA.mean()
        out['rb'] = dict(name=name, num=num(year, tid, name), n=int(r.n), ypc=round(r.yds, 1),
                         adj=round(shrink(r.epa, r.n, lgr, 60) - lgr, 3))
    else:
        out['rb'] = dict(name='RB', num='', n=0, ypc=4.5, adj=0)
    return out


# ---------- pools of real snaps ----------
pools = {}
CAP = 110


AIR_RE = re.compile(r'caught at ([A-Za-z]+)\s?(\d+).*?to the ([A-Za-z]+)\s?(\d+)', re.I)


def air_yards(text, gained):
    """Air yards of a completion when the text says where it was caught; None otherwise."""
    m = AIR_RE.search(text or '')
    if not m:
        return None
    t1, c, t2, e = m.group(1).upper(), int(m.group(2)), m.group(3).upper(), int(m.group(4))
    yac = abs(e - c) if t1 == t2 else (50 - c) + (50 - e)
    if yac > abs(gained) + 15:
        return None
    air = gained - yac if gained >= 0 else gained
    return int(max(-10, min(air, gained if gained > 0 else 0)))


def add_pool(key, df, with_text=True):
    df = df.sample(min(len(df), CAP), random_state=11) if len(df) else df
    rows = []
    for r in df.itertuples(index=False):
        flags = (1 if r.complete else 0) | (2 if r.td else 0) | (4 if r.oob else 0) | \
                (8 if (r.is_int or r.fumble_lost) else 0) | (16 if r.is_sack else 0) | \
                (32 if r.play_type.endswith('Touchdown') and (r.is_int or r.fumble_lost) else 0)
        row = [int(round(r.yg)), flags, round(float(r.EPA), 2) if not pd.isna(r.EPA) else 0, game_ref(r.game_id)]
        if with_text:
            txt = re.sub(r'^\(\d+:\d+\)\s*', '', r.text)
            row.append(txt if len(txt) <= 200 else txt[:200].rsplit(' ', 1)[0] + '…')
        if r.complete:
            row.append(air_yards(r.text, int(round(r.yg))))
        rows.append(row)
    pools[key] = rows
    return len(rows)


base = sc[(sc.penalty_flag != True)]
lab_pass = base[base.depth.notna() & ~base.is_sack]
for depth in ('short', 'deep'):
    for side in ('side', 'mid'):
        d = lab_pass[(lab_pass.depth == depth) & ((lab_pass.pdir == 'middle') == (side == 'mid'))]
        for z in 'grow':
            for g in 'EL':
                sub = d[(d.zone == z) & (d.dg == g)]
                if len(sub) < 60:
                    sub = d[d.zone == z]
                add_pool(f'p_{depth}_{side}_{z}{g}', sub)
rbp = base[base.is_passplay & (base.position_target == 'RB') & ~base.is_int]
for z in 'grow':
    add_pool(f'p_rb_{z}', rbp[rbp.zone == z])
lab_run = base[base.is_rushplay & base.rdir.notna() & (base.position_rush == 'RB')]
for side in ('in', 'out'):
    d = lab_run[(lab_run.rdir == 'middle') == (side == 'in')]
    for z in 'grow':
        for s_ in 'SN':
            sub = d[(d.zone == z) & (d.sy == s_)]
            if len(sub) < 60:
                sub = d[d.zone == z]
            add_pool(f'r_{side}_{z}{s_}', sub)
qbr = base[base.is_rushplay & (base.position_rush == 'QB') & ~base.kneel]
for z in 'grow':
    add_pool(f'r_qb_{z}', qbr[(qbr.zone == z) & (qbr.distance > 2)])
add_pool('r_sneak', qbr[(qbr.distance <= 2) & qbr.text.str.contains('middle|sneak', case=False)])
for z in 'grow':
    add_pool(f'sack_{z}', base[base.is_sack & (base.zone == z)])
ints = base[base.is_int]
add_pool('int', ints)
# turnover / sack rates by depth, estimated from all passes
pass_all = base[base.is_passplay | base.is_sack]
rates = dict(
    sack=round(float(pass_all.is_sack.mean()), 4),
    sackL=round(float(pass_all[pass_all.dg == 'L'].is_sack.mean()), 4),
    int=round(float(pass_all[pass_all.is_passplay].is_int.mean()), 4),
    fumble=round(float(base[base.is_rushplay].fumble_lost.mean()), 4),
)
# how long a snap really takes off the clock late in the 4th, by what happened (time to the next snap)
p['nextT'] = p.groupby('game_id').secs.shift(-1)
p['el'] = p.secs - p.nextT
late = p[(p.period == 4) & (p.secs <= 300) & p.el.between(0, 45)]
lk = late[late.is_passplay & ~late.complete & ~late.is_int]
rates['el_inc'] = float(lk.el.median())
rates['el_comp_in'] = float(late[late.complete & ~late.oob & ~late.td].el.median())
rates['el_oob'] = float(late[late.oob & ~late.td].el.median())
rates['el_rush'] = float(late[late.is_rushplay & ~late.oob & ~late.td & ~late.fumble_lost].el.median())
rates['el_sack'] = float(late[late.is_sack].el.median())
rates['el_first'] = float(late[(late.is_rushplay | late.complete) & ~late.oob & late.text.str.contains('1ST DOWN|1st down', case=False)].el.median())
# penalties: share of late-game snaps that draw an accepted flag, and what the flags are
lateall = p[(p.period == 4) & (p.secs <= 150)]
scrim = lateall[lateall.is_passplay | lateall.is_rushplay | lateall.is_sack]
flags = lateall[(lateall.play_type == 'Penalty') & (lateall.penalty_declined != True) & lateall.yds_penalty.notna() & (lateall.yds_penalty != 0)]
rates['pen'] = round(len(flags) / max(1, len(scrim) + len(flags)), 4)
allflags = p[(p.play_type == 'Penalty') & (p.penalty_declined != True) & p.yds_penalty.notna() & (p.yds_penalty != 0)]
PRE = {'False Start', 'Delay of Game', 'Offside', 'Illegal Formation', 'Illegal Shift', 'Illegal Motion', 'Encroachment', 'Illegal Substitution', 'Too Many Men on the Field'}
OFF_FOULS = ('false start', 'delay of game', 'intentional grounding', 'illegal formation', 'illegal shift', 'illegal motion', 'ineligible', 'chop block', 'illegal forward pass', 'illegal touching', 'offensive')
DEF_FOULS = ('offside', 'encroachment', 'pass interference', 'roughing', 'targeting', 'neutral zone', 'defensive', 'illegal contact', 'horse collar')
ABBR = {n: teams[i]['abbr'] for n, i in team_name_to_id.items()}


def pen_side(r):
    """Which side the flag is on: the text names the penalized team; the foul type settles the rest."""
    t = str(r.text); tl = t.lower(); d = str(r.penalty_detail).lower()
    for team, side in ((r.pos_team, 'off'), (r.def_pos_team, 'def')):
        if not isinstance(team, str):
            continue
        first = team.split(' ')[0].lower()
        if re.search(r'^\s*(\(\d+:\d+\)\s*)?' + re.escape(team.lower()) + r' penalty', tl) or ('penalty ' + ABBR.get(team, '~~').lower() + ' ') in tl or ('penalty ' + first + ' ') in tl:
            return side
    if any(k in d for k in OFF_FOULS):
        return 'off'
    if any(k in d for k in DEF_FOULS):
        return 'def'
    return 'off' if r.yds_penalty < 0 else 'def'


def pen_rows(df):
    out = []
    for r in df.sample(min(len(df), 200), random_state=5).itertuples(index=False):
        side = pen_side(r)
        yds = abs(int(r.yds_penalty))
        if yds == 0 or yds > 50:
            continue
        out.append([yds if side == 'def' else -yds, str(r.penalty_detail), 1 if (side == 'def' and r.penalty_1st_conv) else 0, 1 if 'grounding' in str(r.penalty_detail).lower() else 0])
    return out
ispass = allflags.text.str.contains('pass', case=False)
pools['pen_pre'] = pen_rows(allflags[allflags.penalty_detail.isin(PRE)])
pools['pen_pass'] = pen_rows(allflags[~allflags.penalty_detail.isin(PRE) & ispass])
pools['pen_run'] = pen_rows(allflags[~allflags.penalty_detail.isin(PRE) & ~ispass])
rates['pen_pre_share'] = round(float(allflags.penalty_detail.isin(PRE).mean()), 3)
# extra points, two-point tries, onside kicks
tdt = p[p.td].text.str.lower()
xp_try = tdt.str.contains(r'kick\)|kick failed|kick blocked|kick missed|extra point', regex=True)
xp_good = tdt.str.contains(r'[a-z\'\.\- ]+ kick\)', regex=True) & ~tdt.str.contains('failed|blocked|missed|no good')
rates['xp'] = round(float(xp_good[xp_try].mean()), 3)
two_try = tdt.str.contains('two-point|two point')
two_good = two_try & ~tdt.str.contains('failed|no good|unsuccessful')
rates['two'] = round(float(two_good[two_try].mean()), 3)
ons = p[p.play_type.str.startswith('Kickoff') & p.text.str.contains('onside|on-side', case=False)]
rec_txt = ons.text.str.contains('recovered by', case=False)
kick_team_rec = ons[rec_txt].apply(lambda r: str(r.pos_team).split()[0].lower() in str(r.text).lower(), axis=1) if len(ons[rec_txt]) else pd.Series(dtype=bool)
rates['onside'] = round(float(kick_team_rec.mean()) * float(rec_txt.mean()), 3) if len(ons) else 0.1
rates['onside'] = float(min(max(rates['onside'], 0.06), 0.18))
# quarterback scrambles: QB rushes that weren't designed, as a share of dropbacks (ESPN text rarely says 'scramble'; use QB rushes on passing downs)
qbr = sc[(sc.position_rush == 'QB') & ~sc.kneel]
rates['scramble'] = round(float(len(qbr[qbr.dg == 'L']) / max(1, len(sc[(sc.kind == 'pass') & (sc.dg == 'L')]) + len(qbr[qbr.dg == 'L']))) * 0.5, 3)
print('rates', rates)

# ---------- field goal + conversion models ----------
fg = p[p.play_type.isin(['Field Goal Good', 'Field Goal Missed', 'Blocked Field Goal', 'Blocked Field Goal Touchdown', 'Missed Field Goal Return'])]
fg = fg[fg.yards_to_goal.notna()]
X = np.c_[np.ones(len(fg)), fg.yards_to_goal + 17]
yv = (fg.play_type == 'Field Goal Good').astype(float).values


def logit_fit(X, y, l2=1e-3, iters=40):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        z = X @ w
        mu = 1 / (1 + np.exp(-z))
        W = mu * (1 - mu) + 1e-9
        H = X.T @ (X * W[:, None]) + l2 * np.eye(X.shape[1]) * len(y)
        g = X.T @ (y - mu) - l2 * len(y) * w
        w = w + np.linalg.solve(H, g)
    return w


wfg = logit_fit(X, yv, l2=0)
print('fg', wfg, [round(1 / (1 + math.exp(-(wfg[0] + wfg[1] * d))), 2) for d in (30, 40, 50, 55)])

# ---------- kicker ratings (per team-season, residual vs the distance model) ----------
fgk = fg.copy()
fgk['pred'] = 1 / (1 + np.exp(-(wfg[0] + wfg[1] * (fgk.yards_to_goal + 17))))
fgk['made'] = (fgk.play_type == 'Field Goal Good').astype(float)
fgk['tid'] = fgk.pos_team.map(team_name_to_id)
kres = fgk.groupby(['year', 'tid']).apply(lambda d: pd.Series({'res': (d.made - d.pred).mean(), 'n': len(d)}))
KICK = {k: round(float(v.res * v.n / (v.n + 12)), 3) for k, v in kres.iterrows()}
print('kickers', len(KICK), 'best', sorted(KICK.values())[-3:], 'worst', sorted(KICK.values())[:3])


# ---------- win probability model ----------
fin = gmeta.join(sched[['home_score', 'away_score']], how='left')
q4 = p[(p.secs <= 720) & (p.secs > 0) & p.down.between(1, 4) & (p.is_passplay | p.is_rushplay | p.is_sack)].copy()
q4 = q4.join(fin[['home_score', 'away_score', 'helo', 'aelo']], on='game_id')
q4 = q4[q4.home_score.notna() & (q4.home_score != q4.away_score)]
is_home = q4.pos_team == q4.home
q4['won'] = np.where(is_home, q4.home_score > q4.away_score, q4.away_score > q4.home_score).astype(float)
q4['elo'] = np.where(is_home, q4.helo - q4.aelo, q4.aelo - q4.helo)
q4['s'] = q4.pos_score_diff_start


def tos(df):
    return df.off_timeouts_rem_before.fillna(2).clip(0, 3), df.def_timeouts_rem_before.fillna(2).clip(0, 3)


CATS = [(-99, -9), (-8, -4), (-3, -1), (0, 0), (1, 3), (4, 8), (9, 99)]


def feats(s, T, ytg, down, dist, to_o, to_d, elo):
    q = np.clip(T / 720.0, 0, 1)
    v = (100 - ytg) / 100.0
    base = np.c_[np.ones_like(q), v, v * v, q, v * q, np.sqrt(q), (down >= 3).astype(float),
                 np.log1p(np.minimum(dist, 30)) / 3, to_o / 3, to_d / 3, np.clip(elo, -800, 800) / 400,
                 (down == 4).astype(float), np.clip(np.abs(s), 0, 24) / 8,
                 np.exp(-T / 30.0), np.exp(-T / 30.0) * v, np.exp(-T / 30.0) * v * v]
    cols = []
    for lo, hi in CATS:
        m = ((s >= lo) & (s <= hi)).astype(float)
        cols.append(base * m[:, None])
    return np.hstack(cols)


to_o, to_d = tos(q4)
Xw = feats(q4.s.values, q4.secs.values, q4.yards_to_goal.values, q4.down.values, q4.distance.values,
           to_o.values, to_d.values, q4.elo.fillna(0).values)
ww = logit_fit(Xw, q4.won.values, l2=2e-5)
pred = 1 / (1 + np.exp(-(Xw @ ww)))
print('wp model n', len(q4), 'brier', round(float(np.mean((pred - q4.won.values) ** 2)), 4))
for b in np.linspace(0, 1, 11)[:-1]:
    m = (pred >= b) & (pred < b + .1)
    if m.sum():
        print(f'  {b:.1f}-{b + .1:.1f}: pred {pred[m].mean():.3f} actual {q4.won.values[m].mean():.3f} n={m.sum()}')


def wp(s, T, ytg, down, dist, to_o, to_d, elo=0):
    x = feats(np.array([s], float), np.array([T], float), np.array([ytg], float), np.array([down], float),
              np.array([dist], float), np.array([to_o], float), np.array([to_d], float), np.array([elo], float))
    return float(1 / (1 + np.exp(-(x @ ww)[0])))


for st in [(-7, 110, 75, 1, 10, 2, 3), (-3, 30, 30, 1, 10, 1, 3), (-3, 5, 25, 1, 10, 0, 3), (-7, 10, 5, 1, 5, 0, 3),
           (0, 60, 75, 1, 10, 3, 3), (3, 100, 75, 1, 10, 3, 3), (-1, 20, 20, 1, 10, 1, 3)]:
    print('  wp', st, round(wp(*st), 3))

# ---------- scenarios ----------
first = p[(p.is_passplay | p.is_rushplay | p.is_sack | (p.play_type == 'Penalty')) & ~p.kneel].groupby('id_drive').head(1)
cand = first[(first.period == 4) & (first.TimeSecsRem <= 150) & (first.TimeSecsRem >= 20) &
             (first.pos_team_score - first.def_pos_team_score).between(-16, 0) & first.yards_to_goal.between(20, 99)]

tout = p[p.play_type == 'Timeout'].copy()
tout['who'] = tout.text.str.extract(r'^Timeout ([^,]+),')[0]


def timeouts_left(gid, team, upto_play):
    g = tout[(tout.game_id == gid) & (tout.period >= 3) & (tout.game_play_number < upto_play)]
    return max(0, 3 - int((g.who == team).sum()))


def call_of(r):
    """Label a real play with the game's call vocabulary."""
    if r.spike:
        return 'spike'
    if r.kneel:
        return 'kneel'
    if r.play_type.startswith('Field Goal') or r.play_type.startswith('Blocked Field'):
        return 'fg'
    if r.play_type.startswith('Punt') or r.play_type == 'Blocked Punt':
        return 'punt'
    if r.is_sack or r.is_passplay:
        if r.position_target == 'RB':
            return 'p_rb'
        if isinstance(r.depth, str):
            return f'p_{r.depth}_{"mid" if r.pdir == "middle" else "side"}'
        return 'pass'
    if r.is_rushplay:
        if r.position_rush == 'QB':
            return 'r_sneak' if (r.distance or 10) <= 2 else 'r_qb'
        if isinstance(r.rdir, str):
            return 'r_in' if r.rdir == 'middle' else 'r_out'
        return 'run'
    if r.play_type == 'Timeout':
        return 'timeout'
    if r.play_type == 'Penalty':
        return 'penalty'
    return 'other'


scen = []
for r in cand.itertuples(index=False):
    gid = r.game_id
    off_id = team_name_to_id.get(r.pos_team)
    def_id = team_name_to_id.get(r.def_pos_team)
    if off_id is None or def_id is None or gid not in sched.index:
        continue
    drive = p[(p.id_drive == r.id_drive)]
    if drive.kneel.all():
        continue
    # include timeouts / penalties that occur during the drive window
    lo, hi = drive.game_play_number.min(), drive.game_play_number.max()
    window = p[(p.game_id == gid) & (p.game_play_number >= lo) & (p.game_play_number <= hi + 1) &
               ~p.play_type.isin(['End Period', 'End of Game', 'End of Half', 'End of Regulation', 'Kickoff', 'placeholder'])]
    real = []
    for w in window.itertuples(index=False):
        if w.game_play_number > hi and w.play_type not in ('Timeout',) and not w.play_type.startswith('Field Goal'):
            continue
        if w.play_type == 'Timeout' and w.game_play_number > hi:
            continue
        real.append(dict(c=call_of(w), t=re.sub(r'^\(\d+:\d+\)\s*', '', w.text)[:200], s=int(w.secs) if not pd.isna(w.secs) else None,
                         d=int(w.down) if not pd.isna(w.down) else None, dist=int(w.distance) if not pd.isna(w.distance) else None,
                         y=int(w.yards_to_goal) if not pd.isna(w.yards_to_goal) else None,
                         wp=round(float(w.wp_before), 3) if not pd.isna(w.wp_before) else None))
    g = gmeta.loc[gid]
    sres = sched.loc[gid]
    is_home = r.pos_team == g.home
    off_final = int(sres.home_score if is_home else sres.away_score)
    def_final = int(sres.away_score if is_home else sres.home_score)
    elo = (g.helo - g.aelo) if is_home else (g.aelo - g.helo)
    year = int(r.year)
    scen.append(dict(
        gid=int(gid), g=game_ref(gid), year=year, week=int(r.week), post=g.st == 'postseason',
        date=str(sres.game_date)[:10], venue=str(sres.venue) if isinstance(sres.venue, str) else '',
        home=bool(is_home), neutral=bool(g.neutral),
        off=off_id, dfn=def_id, coach=coach_for(year, off_id, gid), dcoach=coach_for(year, def_id, gid),
        os=int(r.pos_team_score), ds=int(r.def_pos_team_score), secs=int(r.secs), ytg=int(r.yards_to_goal),
        down=int(r.down), dist=int(r.distance),
        to=timeouts_left(gid, r.pos_team, r.game_play_number), dto=timeouts_left(gid, r.def_pos_team, r.game_play_number),
        elo=round(float(elo), 1) if not pd.isna(elo) else 0,
        orat=rating(year, off_id), drat=rating(year, def_id), kick=KICK.get((year, off_id), 0.0),
        lineup=lineup(year, off_id, gid),
        result=str(r.drive_result), final=[off_final, def_final], won=off_final > def_final, real=real,
    ))
    # coach's win chance at the end of the real drive (same model the player is scored on)
    elo_v = float(elo) if not pd.isna(elo) else 0.0
    nxt = p[(p.game_id == gid) & (p.game_play_number > hi)]
    nxt = nxt[nxt.down.between(1, 4) & nxt.secs.notna()]
    if len(nxt):
        q = nxt.iloc[0]
        q_to = timeouts_left(gid, q.pos_team, q.game_play_number)
        q_dto = timeouts_left(gid, q.def_pos_team, q.game_play_number)
        q_s = int(q.pos_team_score) - int(q.def_pos_team_score)
        if q.pos_team == r.pos_team:
            cwp = wp(q_s, q.secs, q.yards_to_goal, q.down, q.distance, q_to, q_dto, elo_v)
        else:
            cwp = 1 - wp(q_s, q.secs, q.yards_to_goal, q.down, q.distance, q_to, q_dto, -elo_v)
    else:
        cwp = 1.0 if off_final > def_final else 0.0 if off_final < def_final else 0.5
    scen[-1]['cwp'] = round(float(cwp), 3)
print('scenarios', len(scen))

# coach tendencies (2023-25 combined): pass rate overall, on early downs, on passing downs, when trailing, explosive-pass rate
tend = {}
for y in YEARS:
    c = pd.read_parquet(RAW + f'ct_{y}.parquet', columns=['season', 'pos_team_id', 'pos_team', 'coach', 'role', 'plays', 'passes', 'plays_early_down', 'passes_early_down', 'plays_passing_down', 'passes_passing_down', 'plays_trailing', 'passes_trailing', 'explosives_pass', 'plays_one_score', 'passes_one_score'])
    c = c[(c.role == 'HC') & c.pos_team_id.isin(teams.keys())]
    for r in c.itertuples(index=False):
        t = tend.setdefault(r.coach, dict(school=teams[int(r.pos_team_id)]['school'], plays=0, passes=0, pe=0, ppe=0, pp=0, ppp=0, pt=0, ppt=0, ex=0))
        t['school'] = teams[int(r.pos_team_id)]['school']  # latest school
        for a, b in (('plays', 'plays'), ('passes', 'passes'), ('pe', 'plays_early_down'), ('ppe', 'passes_early_down'), ('pp', 'plays_passing_down'), ('ppp', 'passes_passing_down'), ('pt', 'plays_trailing'), ('ppt', 'passes_trailing'), ('ex', 'explosives_pass')):
            v = getattr(r, b)
            t[a] += int(v) if not pd.isna(v) else 0
TEND = {k: [v['school'], round(v['passes'] / v['plays'], 3), round(v['ppe'] / max(1, v['pe']), 3), round(v['ppp'] / max(1, v['pp']), 3), round(v['ppt'] / max(1, v['pt']), 3), round(v['ex'] / max(1, v['passes']), 3), v['plays']]
        for k, v in tend.items() if v['plays'] >= 700}
print('tendencies', len(TEND))

# coach table (all FBS head coaches in window)
coaches = {}
for (y, tid), name in coach.items():
    if tid in teams:
        coaches.setdefault(name, []).append([y, tid])

# deterministic daily order: seeded shuffle, marquee (higher combined elo) games front-loaded a bit
# two-score drives (Saban mode) use their own generator and sort after the one-score pool, so the daily order of
# the one-score drives never shifts when they are added
rng2 = random.Random(99)
for s in scen:
    g = gmeta.loc[s['gid']]
    if s['os'] - s['ds'] >= -8:
        s['_k'] = rng.random() - ((g.helo + g.aelo) / 2 - 1500) / 1500.0
    else:
        s['_k'] = 10 + rng2.random()
scen.sort(key=lambda s: s['_k'])
for i, s in enumerate(scen):
    s.pop('_k')
    s['id'] = i

data = dict(
    built='2026-10-15', years=list(YEARS), launch='2026-10-15',
    teams=teams, games=games, coaches=coaches, tend=TEND, scen=scen, pools=pools, rates=rates,
    fg=[round(float(w), 5) for w in wfg], wp=dict(cats=CATS, w=[round(float(w), 5) for w in ww]),
)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
import os
print('wrote', OUT, round(os.path.getsize(OUT) / 1e6, 2), 'MB')
