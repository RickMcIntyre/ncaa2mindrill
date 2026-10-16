# NCAA Two-Minute Drill (ncaa2mindrill.com)

A college-football version of nfl2mindrill.com: one real late-game FBS drive a day (2023–2025), you call the snaps, and your win chance is compared with what the real head coach got.

## Layout

- `site/` — the static site, ready to upload as-is. `index.html` is the page, `app.js` is the engine/UI, `data.json` is generated. Bump `app.js?v=` in index.html when you change app.js so browsers refetch it.
- `build/build.py` — turns the raw play-by-play into `site/data.json` (scenarios, pools of real snaps, win-probability and field-goal models, team ratings, lineups).
- `build/wiki_coaches.py` — caches each team-season's Wikipedia infobox in `raw/wiki/` so interim head coaches get credited game by game.
- `raw/` — downloaded inputs (not needed to run the site).

## Rebuild the data

```bash
cd build
python wiki_coaches.py     # optional, only for new team-seasons
python build.py

```

Inputs come from SportsDataverse GitHub releases (`cfbfastR_cfb_pbp`, `espn_cfb_coach_tendencies`, `espn_cfb_game_rosters`, `espn_cfb_schedules`, `espn_cfb_teams`). To add a season, download its files into `raw/` with the same names and add the year to `YEARS` in `build.py`.

## Run locally

```bash
python -m http.server 8765 --directory site
```

Then open http://localhost:8765/. To deploy, upload the contents of `site/` (index.html, app.js, data.json) to the ncaa2mindrill.com host.

## How the game works

- **Scenarios**: every FBS-vs-FBS drive that started in Q4 with 2:30 or less, trailing by 1–8 or tied, at least 20 yards from the end zone. 608 drives.
- **Outcomes**: each call draws a real 2023–2025 snap from a pool keyed by call type (depth × side for passes, inside/outside for runs), field zone and down. The draw is tilted by both teams' season EPA ratings and the chosen player's season numbers.
- **Win probability**: a logistic model fitted on all Q4 FBS plays, by score bucket, with time, field position, down, distance, timeouts and pregame Elo gap. Calibrated within about one point in every decile.
- **Clock**: college rules. Stops on incompletions and out of bounds; restarts on the ready-for-play after a first down, except inside two minutes where it briefly stops.
- **Coach comparison**: the same model evaluated at the end of the real drive.
