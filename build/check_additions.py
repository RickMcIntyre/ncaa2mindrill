"""Check that a new docs/data.json only adds to an old one: the guard the Sunday job runs before it commits.

    python check_additions.py OLD.json NEW.json        # exit 0 if NEW is OLD plus additions, 1 otherwise

Every published drive must come out byte-identical (same JSON at the same index, written the way build.py and
merge_featured.py write it), every game row and every date in `featured` too, and every other key unchanged. What may
change: new drives appended after the last one (flagged `feat`, numbered by position), new games, new dates in
`featured` pointing at the new drives, and new seasons in `years`.
"""
import json, sys


def dump(x):
    return json.dumps(x, separators=(',', ':'), ensure_ascii=False)


def check(old, new):
    """The list of ways NEW changes OLD instead of adding to it (empty when it only adds)."""
    bad = []
    keys = set(old) | {'featured'}
    for k in sorted(set(new) - keys):
        bad.append(f'new top-level key {k!r}')
    for k in old:
        if k not in new:
            bad.append(f'top-level key {k!r} removed')
        elif k not in ('scen', 'games', 'featured', 'years') and dump(old[k]) != dump(new[k]):
            bad.append(f'{k!r} changed')
    if bad:
        return bad
    os_, ns = old['scen'], new['scen']
    if len(ns) < len(os_):
        bad.append(f'{len(os_) - len(ns)} drives removed')
    for i, s in enumerate(os_[:len(ns)]):
        if dump(s) != dump(ns[i]):
            bad.append(f'drive {i} ({s.get("coach")}, {s.get("year")}) changed')
    for i, s in enumerate(ns[len(os_):], len(os_)):
        if s.get('id') != i or not s.get('feat'):
            bad.append(f'new drive {i} is not a featured drive numbered {i}')
    for k, v in old['games'].items():
        if dump(new['games'].get(k)) != dump(v):
            bad.append(f'game {k} changed')
    for d, i in old.get('featured', {}).items():
        if new['featured'].get(d) != i:
            bad.append(f'featured {d} changed from drive {i} to {new["featured"].get(d)}')
    for d, i in new.get('featured', {}).items():
        if d not in old.get('featured', {}) and not (isinstance(i, int) and len(os_) <= i < len(ns)):
            bad.append(f'featured {d} points at drive {i}, not a new one')
    if not set(old['years']) <= set(new['years']):
        bad.append('a season was dropped from years')
    return bad


def check_text(old_text, new_text):
    """check() on two data.json texts, plus: both are written in the one form, so equal JSON per drive is equal bytes."""
    old, new = json.loads(old_text), json.loads(new_text)
    bad = check(old, new)
    bad += [f'the {n} data.json is not written the way build.py writes it' for n, t, d in (('old', old_text, old), ('new', new_text, new))
            if t != dump(d)]
    return bad, old, new


def summary(old, new):
    pins = sorted(set(new.get('featured', {})) - set(old.get('featured', {})))
    return (f'{len(new["scen"]) - len(old["scen"])} new drives, {len(new["games"]) - len(old["games"])} new games, '
            f'pinned {", ".join(pins) or "nothing"}; {len(old["scen"])} published drives unchanged')


if __name__ == '__main__':
    bad, old, new = check_text(*(open(f, encoding='utf-8').read() for f in sys.argv[1:3]))
    for b in bad[:50]:
        print('NOT AN ADDITION:', b)
    if bad:
        sys.exit(1)
    print('only additions:', summary(old, new))
