# NCAA Two-Minute Drill (ncaa2mindrill.com)

A college-football version of nfl2mindrill.com: one real late-game FBS drive a day (2023–2025), you call the snaps, and your win chance is compared with what the real head coach got.

## Layout

- `docs/` — the static site, ready to upload as-is. `index.html` is the page, `app.js` is the engine/UI, `anim.js` animates each snap (routes, coverage, pursuit, ball flight, big-play popups), `data.json` is generated. Bump `app.js?v=` in index.html when you change app.js so browsers refetch it.
- `build/build.py` — turns the raw play-by-play into `docs/data.json` (scenarios, pools of real snaps, win-probability and field-goal models, team ratings, lineups).
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
python -m http.server 8765 --directory docs
```

Then open http://localhost:8765/. To deploy, upload the contents of `docs/` (index.html, app.js, data.json) to the ncaa2mindrill.com host.

## How the game works

- **Scenarios**: every FBS-vs-FBS drive that started in Q4 with 2:30 or less, trailing by 1–16 or tied, at least 20 yards from the end zone. The regular daily uses the one-score drives (trailing by 8 or fewer); **Saban mode** uses drives that start at 10% win chance or worse, or two scores down.
- **Outcomes**: each call draws a real 2023–2025 snap from a pool keyed by call type (depth × side for passes, inside/outside for runs), field zone and down. The draw is tilted by both teams' season EPA ratings and the chosen player's season numbers.
- **Trick plays**: the whole bag is on the board every down (flea flicker, halfback pass, reverse, jet sweep, wildcat, Statue of Liberty, hook and ladder, Philly Special, plus fake field goal in range and fake punt on fourth down). Each rides a base pool (deep pass, short pass, inside or outside run) with its own tilt by defensive look, its own sack/interception/fumble multipliers, and a chance of being blown up in the backfield. They are scored like every other option, so the grade says when a trick was the wrong call. Each has its own choreography in `anim.js`.
- **Two-point try**: a real snap from the 3, untimed. Every option's conversion chance comes from the goal-line pools, anchored so the board's average equals the measured college two-point rate; the call is animated and graded like any other snap.
- **Win probability**: a logistic model fitted on all Q4 FBS plays, by score bucket, with time, field position, down, distance, timeouts and pregame Elo gap. Calibrated within about one point in every decile.
- **Clock**: college rules. Stops on incompletions and out of bounds; restarts on the ready-for-play after a first down, except inside two minutes where it briefly stops.
- **Coach comparison**: the same model evaluated at the end of the real drive, plus a snap-by-snap grid of your calls against the coach's.
- **Defensive looks**: each snap the defense shows a look (base, loaded box, light box, blitz, prevent), sampled from the situation; it tilts every option and the animation aligns to it.
- **Penalties, scrambles, strip sacks, kicker quality**: flag rate and types from late-game snaps (pre-snap flags wipe the play, live-ball flags bring it back), QB scrambles at the measured rate, 1 in 10 sacks is a strip, and each team-season's kicker is rated against the distance model.
- **Tempo**: when the clock is running you choose hustle (≈5 s off), neutral (the measured median), or milk it (≈34 s), or burn a timeout.
- **Percentile**: 300 synthetic play-callers (different sharpness, run/pass lean, timeout habits) replay the same drive through the engine; your finish is ranked against theirs.
- **Coach resemblance**: your pass rate overall, on early downs and on passing downs is matched to the nearest real FBS head coach's 2023–25 tendencies.
- **Share**: a 1200×630 card (canvas) with Web Share / X intent / copy / save.
- **Grading and difficulty**: three settings (`DIFF` in app.js). Saban mode is the cliff: green only within half a point of the best call, yellow within 3, and a simulated room that barely misses. Cignetti loosens both a notch (green within 1 point, yellow within 4.5). Everything free (Daily, Survival, the library) is graded on the coach's own curve (green within 2 points, yellow within 6) against a room that makes human mistakes. A hard drive replayed from a library or reached deep in a Survival run uses its own setting. Trophies are judged on the cliff whatever the screen showed. The free daily pool is one-score drives starting at 30–75% win chance.
- **Personnel**: 10, 11, 12, 13, 21 or 22 on every snap. The build keeps 4 WR, 3 TE and 2 RB per team-game (padded from the game roster with league-average hands when a tight end or back never caught a pass). Heavy groups add run advantage and a little pass protection and cost pass advantage; four wide does the reverse. The defensive look is drawn again when you sub, with loaded boxes more likely against tight ends and extra DBs against four wide. The fullback leads through the hole in the animation.
- **Survival**: a run of random real drives, each round harder (rounds 1–2 start at 40%+ win chance, 3–4 at 28–45%, 5–6 at 25–36%, 7–9 from the Cignetti shelf, 10+ from the Saban pool). After each drive the rest of the game plays out at the model's odds: win to stay alive, one loss ends the run. Rounds 7+ need the unlock. The old Practice library lives under Survival → Drive library.
- **Libraries**: each paid tab has "Today's drive | Library". The Saban library is the attainable brutal pool (one score down at 1–10% with 25+ seconds, or two scores down with 60+ seconds and a pulse in the model; the hopeless ones are excluded everywhere); the Cignetti library is the 10–25% pool. Library drives are practice drives: replayable, no trophies.
- **Gifts**: finish a Saban-mode drive at 50%+ and the site offers one gift code (issued by the worker against your unlock); a friend pastes it under "I already paid" and gets both modes. One code per unlock, redeemable once.
- **Trophies**: a *Saban* is a perfect game (5+ snaps, every call the best one, beat the coach); a *Cignetti* is no wrong calls with at least 60% best calls and a win over the coach. Both are stored in the browser and stamped on the share card.
