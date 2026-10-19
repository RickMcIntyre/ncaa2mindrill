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

### Featured drives from this season

To pin a drive from last weekend to a date without disturbing the rotation, download the current season's files into `raw/` (same names, e.g. `pbp_2026.parquet`, `rost_2026.parquet`, `sched_2026.csv`, `ct_2026.parquet`), then:

```bash
cd build
FEATURE="2026:401858488@03:05" python build.py           # game_id @ the clock on the drive's first snap
python merge_featured.py featured.json 401858488=2026-10-19
```

Every Sunday this runs on its own: `build/weekly_featured.py` downloads the season's files, ranks every late drive from Thursday-Saturday's FBS games (4th quarter, 0:20-4:00 left, trailing by 1-16 or tied, a live chance; one per game; weighted by how much the drive swung the game, how wild the game's fourth quarter was, program size by pregame Elo, and go-ahead or last-chance drives), builds the top seven, pins them Sunday through Saturday, commits `docs/data.json` and pushes. `--dry-run` prints the ranking only. Exit 3 means the feed doesn't have the whole Saturday slate yet; exit 2 means this weekend is already pinned. The desktop app's scheduled task "sunday-featured-drives" runs it at 6:30, 8:30, 10:30 and 12:30 on Sundays.

The build writes only those drives (to `build/featured.json`, never the live data). The merge appends them to `docs/data.json` with new ids, re-scores the coach's win chance with the live model, flags them `feat` so they stay out of the daily, Cignetti and Saban rotations, and pins them by local date in `featured`. The intro shows "From Saturday" for a week. Re-running the merge for the same game replaces that drive in place.

Inputs come from SportsDataverse GitHub releases (`cfbfastR_cfb_pbp`, `espn_cfb_coach_tendencies`, `espn_cfb_game_rosters`, `espn_cfb_schedules`, `espn_cfb_teams`). To add a season, download its files into `raw/` with the same names and add the year to `YEARS` in `build.py`.

## Run locally

```bash
python -m http.server 8765 --directory docs
```

Then open http://localhost:8765/. To deploy, upload the contents of `docs/` (index.html, app.js, data.json) to the ncaa2mindrill.com host.

## How the game works

- **Scenarios**: every FBS-vs-FBS drive that started in Q4 with 2:30 or less, trailing by 1–16 or tied, at least 20 yards from the end zone. The regular daily uses the one-score drives (trailing by 8 or fewer); **Cignetti mode** uses drives two scores down (trailing by 9–11) and **Saban mode** drives two touchdowns down (12–16), each with a minute or more left.
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
- **Sound** (`docs/sound.js`, off until the player turns it on): the crowd is real. Seven short recordings of actual crowds (`docs/sound/*.mp3`, ~670 KB, fetched only when sound is turned on) carry the stadium: a looping football-crowd bed, two big roars, a groan, an "ooh", booing for flags, and a bugle-and-"Charge!". They come from two public-domain (CC0) libraries on the Internet Archive: `SSE_Library_CROWDS` and `Red_Library_Crowds_Applause`. If the fetch fails, a synthesized crowd of individual voices stands in. The toggle applies across every open tab, and off suspends the audio engine. Everything else is synthesized with WebAudio and played through a generated stadium reverb. The QB's "Set... hut!" and the pads at the snap, a pop on the catch, a hit when the ball carrier goes down, the referee's pea whistle when the play is dead, a kick thump, the crowd on every popup, and the band's "Charge!" on a touchdown. The crowd is partisan: it cheers the home team's good plays and groans at its bad ones, so on the road a big play gets a quiet stadium and a loud visiting section. A murmuring crowd bed follows the situation (third downs, the red zone, the last minute; hostile when you have the ball on the road) and carries "hype": big plays raise it and it decays over about 40 seconds, so the stadium stays buzzing after a touchdown.
- **Share**: a 1200×630 card (canvas) with Web Share / X intent / copy / save.
- **Grading and difficulty**: three settings (`DIFF` in app.js). Saban mode is the cliff: green only within half a point of the best call, yellow within 3, and a simulated room that barely misses. Cignetti loosens both a notch (green within 1 point, yellow within 4.5). Everything free (Daily, Survival, the library) is graded on the coach's own curve (green within 2 points, yellow within 6) against a room that makes human mistakes. A hard drive replayed from a library or reached deep in a Survival run uses its own setting. Trophies are judged on the cliff whatever the screen showed. The free daily pool is one-score drives starting at 30–75% win chance.
- **Personnel**: 10, 11, 12, 13, 21 or 22 on every snap. The build keeps 4 WR, 3 TE and 2 RB per team-game (padded from the game roster with league-average hands when a tight end or back never caught a pass). Heavy groups add run advantage and a little pass protection and cost pass advantage; four wide does the reverse. The defensive look is drawn again when you sub, with loaded boxes more likely against tight ends and extra DBs against four wide. The fullback leads through the hole in the animation.
- **Bench**: every offensive chip under the field is a button when a backup exists at that spot (the build keeps 5 WR, 3 TE, 3 RB and a backup QB per team-game; backs carry their rushing line too). A sub swaps the two players in this game's own copy of the lineup, so the data is untouched and the coach is still graded with the lineup he actually had. The replacement's season numbers drive every outcome from then on.
- **Survival**: a run of random real drives, each round harder (rounds 1–2 start at 45%+ win chance, 3–4 at 35–50%, 5–6 at 28–40%, 7–9 from the Cignetti shelf, 10+ from the Saban pool). After each drive the rest of the game plays out at the model's odds: win to stay alive, one loss ends the run. Rounds 7+ need the unlock. The old Practice library lives under Survival → Drive library. Cignetti and Saban mode each have their own Survival view (Today's drive | Survival | Library): the run stays inside that mode's pool, easiest drives first (top 40% by starting win chance for rounds 1–2, the middle for 3–4, the hardest 40% from round 5). Best runs are kept per kind.
- **Retry**: any daily (Daily, Cignetti, Saban) can be retried from its final screen. The first attempt is the record: retries are labeled, never reach the leaderboard, never earn trophies or gift codes, and only count how many times you came back.
- **Libraries**: each paid tab has "Today's drive | Library". The Cignetti library is the two-score pool (down 9–11, 60+ seconds, 0.3%+ to win at the start); the Saban library is the two-touchdown pool (down 12–16, 60+ seconds, 0.1%+). The hopeless ones are excluded everywhere. One-score long shots (1–28%) are free: the library and Survival rounds 7–9. Library drives are practice drives: replayable, no trophies.
- **Gifts**: finish a Saban-mode drive at 50%+ and the site offers one gift code (issued by the worker against your unlock); a friend pastes it under "I already paid" and gets both modes. One code per unlock, redeemable once.
- **Trophies**: a *Saban* is a perfect game (5+ snaps, every call the best one, beat the coach); a *Cignetti* is no wrong calls with at least 60% best calls and a win over the coach. Both are stored in the browser and stamped on the share card.
