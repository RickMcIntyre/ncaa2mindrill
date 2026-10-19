# Paid media plan — ncaa2mindrill.com

Everything here is ready to paste. Account creation, the card on file, and every "publish" click are yours; campaign setup inside the ad managers I can drive in your Chrome with your approval on each step. Copy voice stays the site's: dry, specific, no exclamation points, never a joke at a real coach.

## 0. Read this first: the math

The product is free with a $0.99 unlock. Stripe keeps about $0.33 of that, so one unlock nets **$0.66**. Daily-game sites convert roughly 1–3% of visitors to a paid upgrade, which puts revenue per paid visitor at **$0.01–0.02**. Paid clicks in this audience cost $0.20–$2.00. Paid ads cannot pay for themselves on direct unlocks; they lose 20–100× on every visitor.

So paid media is a seeding play, not a sales engine. It works only if the people it brings share (the share card, the daily link, the challenge-a-friend link when it exists) and come back on their own. Run it as a two-week test with fixed spend, measure the loop, then decide. If the loop isn't there, the money is better spent on the app launch or on one good creator.

What would make paid viable later:
- **Price.** $2.99–$3.99 in the app, with the free site as the funnel. Each unlock then nets $2–2.70, and a $1–2 cost per install starts to work.
- **A yearly pass** on the web ($4.99: libraries, Survival deep end, both hard modes) instead of a one-time $0.99.
- **Sponsorship, not display ads.** A sportsbook or a CFB newsletter sponsoring "today's drive" pays far more per visitor than any ad network. (Sportsbook affiliate deals have state-by-state rules; get the contract reviewed before taking one.)

**Budget for the test: $420 over 14 days ($30/day).** Kill rules are in section 6.

## 1. Tracking (done on the site)

- Every ad link carries `utm_source` and `utm_campaign`. The site stores the first source per browser and the worker tallies visits, people and unlocks by source. Read it at **ncaa2mindrill.com/admin.html** ("Where they came from").
- Link format: `https://ncaa2mindrill.com/?utm_source=SOURCE&utm_campaign=CAMPAIGN`
  - sources: `google`, `x`, `meta`, `reddit`, `tiktok`
  - campaigns: `search`, `launch`, `saban`, `survival`, `daily-YYYYMMDD`
- Platform pixels load only when their ids are pasted into `window.ADS` at the top of the scripts in `docs/index.html` (Google tag id, Meta Pixel id, X Pixel id plus X's two event ids). Then the site sends: `drive_start`, `drive_done`, `begin_checkout`, `purchase` (value 0.99 USD). Optimise campaigns on `purchase` once there are 20+ a week; before that, on `drive_start`.
- The privacy page already says ad tags may load when ads run.

## 2. Google Search — $5/day

Why: intent. Someone typing "college football play calling game" is the whole audience.

**Campaign:** Search, US only, English, "Maximize clicks" for the first week, then "Maximize conversions" on `drive_start`. Landing: `https://ncaa2mindrill.com/?utm_source=google&utm_campaign=search`. Mobile and desktop both on.

**Ad group A — the game (phrase match):**
"college football play calling game", "cfb play calling game", "football play calling simulator", "call the plays game", "football coach simulator free", "two minute drill game", "2 minute drill game", "college football daily game", "wordle for college football", "ncaa football browser game", "college football game online free"

**Ad group B — the competitor (exact match):**
[nfl two minute drill], [nfl2mindrill], [two minute drill nfl game]
Ad copy for B: "The college version. Real FBS drives, real coaches."

**Negatives (campaign level):** ea, ea sports, cfb 25, cfb 26, ps5, xbox, madden, roster, download, dynasty, recruiting, tickets, schedule, scores, odds, picks, betting

**Responsive search ad (headlines ≤30 chars, pick all 15):**
1. One Real College Drive a Day
2. You Call Every Snap
3. Beat the Real Head Coach
4. Free College Football Game
5. Real FBS Drives, 2023–2025
6. Graded Against the Coach
7. Call It Better Than He Did
8. Full Route Tree, Every Play
9. Trick Plays on Every Down
10. Survival Mode: Win to Stay
11. Saban Mode for the Brave
12. No Download. Plays in Browser
13. Real Score, Clock and Players
14. New Drive Every Day
15. NCAA Two-Minute Drill

**Descriptions (≤90 chars, all 4):**
1. Take over a real late-game FBS drive. Call every snap. See if you out-call the head coach.
2. Real scores, clocks, players and outcomes from three seasons. Every snap animated. Free.
3. Runs, routes, trick plays, two-point tries, tempo. Then a grade, a percentile and a verdict.
4. Hard modes for $0.99 once: Cignetti and Saban. The rest stays free, every day.

Sitelinks: Today's drive (/), Survival (/#survival), Saban mode (/#saban), Coaches (/#coaches).

## 3. X Ads — $10/day

Why: this is where college football argues about play calls in real time, and the share card is built for it.

**Objective:** Website traffic for week one; Conversions on `purchase` later. **Targeting:** US, 18–54; interests: College football; follower look-alikes of @ESPNCFB, @CFBPlayoff, @Brett_McMurphy, @BarstoolCFB, @RedditCFB, @PFF_College; keywords: "college football", "CFB", "play call", "clock management", "go for two". Devices: all. **Schedule:** 2× weight Thursday 6pm – Sunday 2pm ET; Saturday evening is the peak.

**Creative:** `marketing/ads/feed-1200x628-{a,b,c}.png` (one ad each) plus a 15-second screen recording of one drive with the animation (see section 8). Video will beat the statics; make it as soon as you can.

**Copy (≤280, one link, no hashtags in ads):**
- A: One real late-game college drive a day. The real score, clock and players. You call every snap, then you're graded against the coach who actually called it. Free. {link}
- B: Down 3, 1:46 left, your ball. That drive happened. Now it's yours. Beat the head coach or hear about it. {link}
- C: He has a staff and a headset. You have a browser. Same drive, same clock. Who calls it better? {link}
- D (Saban): Saban mode: two touchdowns down, a minute or two left. The 28–3 drives. Nobody is expected to win them. Some people do. {link}
- E (Survival): Survival: a real drive, then a harder one, then a harder one. Win to stay alive. One loss ends the run. {link}

Promote the organic daily post too (the "today's drive" template in LAUNCH-KIT.md), $5 behind it on Saturdays with the day's two team tags.

## 4. Meta (Instagram + Facebook) — $10/day

Why: the largest CFB audience is on Facebook, and Reels is where a 15-second animation clip travels.

**Campaign:** Sales objective once the pixel has purchases; Traffic before that. Advantage+ placements (feed, Stories, Reels, Facebook feed). US, 18–54. **Interests:** College football, NCAA Football, ESPN College GameDay, College Football Playoff, EA Sports College Football, SEC, Big Ten, Bleacher Report; or let Advantage+ audience run with a 1% lookalike of site visitors once the pixel has 1,000. **Schedule:** always on, budget skewed to Thursday–Saturday.

**Creative:** `square-1080x1080-{a,b,c}.png` for feed, `story-1080x1920-{a,b,c}.png` for Stories and Reels placements, then the vertical video.

**Primary text (≤125 chars ideally):**
- A: One real college drive a day. You call every snap, then you're graded against the coach who actually called it. Free.
- B: Down 3, 1:46 left, your ball. That drive happened. Now it's yours.
- C: He has a staff. You have a browser. Same drive. Who calls it better?

**Headline (≤40):** "Beat the real head coach" / "A real drive a day. Free." / "Call every snap." **Description:** "Real FBS drives, 2023–2025." **CTA button:** Play Game.

## 5. Reddit Ads — $5/day

Why: cheapest clicks in this audience, and the communities are exact.

**Targeting:** communities r/CFB, r/NCAAFBseries, r/footballstrategy, r/CFBAnalysis, plus the ten biggest team subs (r/rolltide, r/LonghornNation, r/OhioStateFootball, r/Georgiafootball, r/ufl? check names), US only. **Format:** promoted post, conversation-style, with the r/CFB post from LAUNCH-KIT.md as the body (it reads like a post, which is the point). **Bid:** CPC, start at $0.35.

Organic note: r/CFB removes plain self-promotion. Message the mods first, post it as [OC] with the honest caveats, answer every comment. Do that once; the ads carry the rest.

## 6. Measurement and kill rules

Watch the tally page by source, and inside each platform: CPC and cost per `drive_start`.

| Metric | Keep going | Pause the source |
|---|---|---|
| Cost per visit | ≤ $0.50 | > $0.80 after $50 spent |
| Visitors who start a drive | ≥ 35% | < 20% |
| Starters who finish | ≥ 50% | < 30% |
| Unlock rate per person | ≥ 1.5% | < 0.5% after 400 people |
| Share-card saves or shares | ≥ 5% of finishers | — |
| Day-7 return (people seen again) | ≥ 15% | < 5% |

After 14 days: total spend ÷ people brought = cost per person. Compare with organic growth over the same window. If paid people share and return at the organic rate, scale the best source to $20/day. If not, stop and put the money into the app launch.

## 7. Two-week calendar

- Day 1 (Thu): accounts live, pixels pasted into `window.ADS`, test one click per source and confirm it on the tally page. Launch Google Search and Reddit.
- Day 2 (Fri): launch X and Meta statics. Post the organic X thread and the r/CFB post (with mod approval) the same morning so the ads land on a site people are already talking about.
- Day 3 (Sat): daily post at 10am ET with the two team tags; $5 promoted behind it. Watch the evening.
- Day 4–7: no changes except pausing anything above the kill line. Record the video creative (section 8) and swap it in on day 5.
- Day 8: first read. Move budget toward the two best sources.
- Day 10 (Sat): second promoted daily post; try the Saban-mode copy (D) on X.
- Day 14: full read against section 6. Decide: scale, hold, or stop.

## 8. The video creative (make this; it will outperform everything above)

15 seconds, vertical for Reels/TikTok, 16:9 crop for X. Screen recording of one drive at 1.25× with sound off, captions on:
1. (0–2s) The intro card: "2024 · Oklahoma at Missouri · Down 3 · 1:46 left"
2. (2–8s) Two snaps called and animated: a deep shot that gets MOSSED HIM, then the 2-point try from the 3.
3. (8–12s) The final screen: your win chance vs the coach's, the grade grid.
4. (12–15s) Text: "One real college drive a day. ncaa2mindrill.com". No voiceover needed; if you want one, read the three lines in the dry voice.

Same clip, three cuts: a win, a loss to the coach, and a Saban-mode collapse. Rotate them.

## 9. What I need from you to start

1. Create the four ad accounts (Google Ads, X Ads, Meta Ads Manager, Reddit Ads) and put the card on each. I can't do that part.
2. Paste the Google tag id, Meta Pixel id and X Pixel id into `window.ADS` in `docs/index.html` (or send them to me and I'll push them).
3. Say which day is day 1. Then open Chrome, and I'll build the campaigns with you approving each save.
