"""Put the build's fixed inputs in raw/ on a machine that doesn't have them (the GitHub job): the 2023-2025 seasons and
the team table, pinned by SHA-256 to the copies the published data.json was built from (they matched SportsDataverse's
releases on Oct 26, 2026). weekly_featured.py downloads the current season itself.

    python fetch_inputs.py          # downloads only the files raw/ doesn't have (the job keeps them in its cache)

raw/wiki/ isn't needed here: build.py only uses it for team-seasons cached by wiki_coaches.py (2023-2025), and a
featured build writes current-season drives only. Upstream re-issues old seasons now and then; a download that isn't
the pinned copy is used anyway, with a notice. Past seasons' rosters, schedules and coach files don't enter a featured
build at all (on Nov 11, 2026 the job built byte-identical drives from re-issued 2023-25 rosters and coach files);
their play-by-play and the team table do, through league averages. Exit 1 only when a file can't be had.
Prints downloaded=true|false for the job's cache.
"""
import hashlib, os, sys, urllib.request
from weekly_featured import RAW, log, release, retry

PINNED = [  # release tag, asset, file in raw/, sha256
    ('cfbfastR_cfb_pbp', 'play_by_play_2023.parquet', 'pbp_2023.parquet', '167889e635679d2a745a0f73690bf51afcb28236d3bbaed32aeabb154b726be9'),
    ('cfbfastR_cfb_pbp', 'play_by_play_2024.parquet', 'pbp_2024.parquet', '60489da0c61c56b86698ee14be65cb521010f707e9a2f4ded8d561e9ef592bd4'),
    ('cfbfastR_cfb_pbp', 'play_by_play_2025.parquet', 'pbp_2025.parquet', '2290311f156083730b6b9d9e6662d121dc86953d71e11aafc9da4c0753819369'),
    ('espn_cfb_game_rosters', 'game_rosters_2023.parquet', 'rost_2023.parquet', 'b9bf31b65e879fff3cf42869815596b6d7301b90598b145cbaa2e692b0b637db'),
    ('espn_cfb_game_rosters', 'game_rosters_2024.parquet', 'rost_2024.parquet', 'bb39b3d58e0a0e5d0a063c8c6f889cfb65d49cbc328ec5fc5581eaedc9a3d9e6'),
    ('espn_cfb_game_rosters', 'game_rosters_2025.parquet', 'rost_2025.parquet', '37e241739e61f811e7f2a79e019d104e228717ffd3fc56ba861e75c6fa143d0c'),
    ('espn_cfb_schedules', 'cfb_schedule_2023.csv', 'sched_2023.csv', '5739569b8e7684ed6fa838c9e3cf13ab1d62f223cef0e7785e466544d5d0a7c1'),
    ('espn_cfb_schedules', 'cfb_schedule_2024.csv', 'sched_2024.csv', '6249cc0922e3fe3eade3634b733bd193b92b5b07e6ee4ca456b5efd2b670ca86'),
    ('espn_cfb_schedules', 'cfb_schedule_2025.csv', 'sched_2025.csv', '2b8e4e24f3c62c8833b7e15703675d9648f438aaa01de966e6498eae50b1d86f'),
    ('espn_cfb_coach_tendencies', 'coach_tendencies_2023.parquet', 'ct_2023.parquet', 'ee5cabd37682c83b2cc82c670bee8097e7f6163d64c52e6965c5add961fa3e08'),
    ('espn_cfb_coach_tendencies', 'coach_tendencies_2024.parquet', 'ct_2024.parquet', '08166a6b176cf2113b0274d9f8216c65994dbd59e52f35f74f35a089286904c9'),
    ('espn_cfb_coach_tendencies', 'coach_tendencies_2025.parquet', 'ct_2025.parquet', '500572c7736347af26c8832a64d4eb4a404e8d8c31a952f1fe6e35d46df73133'),
    ('espn_cfb_teams', 'cfb_teams_2025.csv', 'teams_2025.csv', '5446f91a8a0d27e112fa7369ba0e887ed27aa6eec61130e00f20339ef50e7abf'),
]


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def main():
    os.makedirs(RAW, exist_ok=True)
    downloaded, newer, assets = False, [], {}
    for tag, name, local, want in PINNED:
        dest = RAW + local
        if os.path.exists(dest):
            log(f'  {local}: have it' + ('' if sha(dest) == want else ' (a newer upstream copy than the pinned one)'))
            continue
        if tag not in assets:
            assets[tag] = {a['name']: a for a in retry(release, tag)['assets']}
        tmp = dest + '.part'
        retry(urllib.request.urlretrieve, assets[tag][name]['browser_download_url'], tmp)
        os.replace(tmp, dest)
        downloaded = True
        got = sha(dest)
        log(f'  {local}: downloaded {os.path.getsize(dest) // 1024} KB' + ('' if got == want else ', a newer upstream copy than the pinned one'))
        if got != want:
            newer.append(local)
    if newer:
        print(f'::notice title=Re-issued upstream::{", ".join(newer)} changed upstream since data.json was built; '
              f'using the new copies (see build/fetch_inputs.py). Nothing to do.', flush=True)
    print(f'downloaded={str(downloaded).lower()}')
    if os.environ.get('GITHUB_OUTPUT'):
        open(os.environ['GITHUB_OUTPUT'], 'a').write(f'downloaded={str(downloaded).lower()}\n')


if __name__ == '__main__':
    main()
