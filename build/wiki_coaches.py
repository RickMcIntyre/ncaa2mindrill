"""Fetch head-coach info (incl. interim splits) from Wikipedia season pages, cached in raw/wiki."""
import json, os, re, sys, time, urllib.request, urllib.parse
import pandas as pd
RAW = 'C:/Users/pmcin/cfb-2min-drill/raw/'
D = json.load(open('C:/Users/pmcin/cfb-2min-drill/site/data.json', encoding='utf-8'))
tm = pd.read_csv(RAW + 'teams_2025.csv').set_index('team_id')
FIX = {'App State Mountaineers': 'Appalachian State Mountaineers', 'UConn Huskies': 'UConn Huskies',
       'Hawai\'i Rainbow Warriors': 'Hawaii Rainbow Warriors', 'San José State Spartans': 'San Jose State Spartans',
       'UL Monroe Warhawks': 'Louisiana–Monroe Warhawks', 'Louisiana Ragin\' Cajuns': 'Louisiana Ragin\' Cajuns',
       'Miami (OH) RedHawks': 'Miami RedHawks', 'Southern Miss Golden Eagles': 'Southern Miss Golden Eagles',
       'UTSA Roadrunners': 'UTSA Roadrunners', 'Sam Houston Bearkats': 'Sam Houston Bearkats'}
need = set()
for s in D['scen']:
    need.add((s['year'], s['off'])); need.add((s['year'], s['dfn']))
UA = {'User-Agent': 'cfb-drill-build/1.0 (personal project)'}


def get(url):
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            time.sleep(3 + 5 * i)
    return {}


for (y, tid) in sorted(need):
    fn = f'{RAW}wiki/{y}_{tid}.txt'
    if os.path.exists(fn):
        continue
    name = tm.loc[tid, 'display_name'] if tid in tm.index else None
    if not isinstance(name, str):
        continue
    name = FIX.get(name, name)
    title = f'{y} {name} football team'
    j = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode(
        dict(action='parse', page=title, prop='wikitext', format='json', formatversion=2, redirects=1)))
    w = j.get('parse', {}).get('wikitext', '')
    if not w:
        s = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode(
            dict(action='query', list='search', srsearch=title, format='json', srlimit=1)))
        hits = s.get('query', {}).get('search', [])
        if hits:
            time.sleep(1)
            j = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode(
                dict(action='parse', page=hits[0]['title'], prop='wikitext', format='json', formatversion=2, redirects=1)))
            w = j.get('parse', {}).get('wikitext', '')
    m = re.search(r'\{\{\s*Infobox (?:NCAA|college) football team season(.*?)\n\}\}', w, re.S | re.I)
    box = m.group(1) if m else w[:6000]
    open(fn, 'w', encoding='utf-8').write(box)
    print(y, name, 'ok' if m else 'NO INFOBOX', flush=True)
    time.sleep(1.2)
