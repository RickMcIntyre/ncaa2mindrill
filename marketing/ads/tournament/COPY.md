# Tournament mode ads

Images are in this folder (rebuild with `python marketing/ads/tournament/make_tournament.py` from the repo root).
Every screen is from one real run on the current site: 2025 Indiana (16–0, rating 99) was the 1 seed, had the bye,
and won the Quarterfinal, Semifinal and Title Game by taking the lead on each drive.

| Placement | Variant A: "Pick any team" | Variant B: "Three drives. One title." |
|---|---|---|
| Feed 4:5 (1080x1350) | `ad-feed-a.png` | `ad-feed-b.png` |
| Square (1080x1080) | `ad-square-a.png` | `ad-square-b.png` |
| Stories / Reels (1080x1920) | `ad-story-a.png` | `ad-story-b.png` |

## Variant A: pick any team

- **Primary text:** Pick any FBS team from 2023–2025. It gets seeded into a 12-team playoff against the best teams of the last three seasons, and every round is one real fourth-quarter drive. You call every snap. Beat what the real coach did, or go home.

  The daily drive is still free. The Tournament comes with the one-time $2.99 unlock.
- **Headline:** Pick a team. Win the playoff.
- **Description:** One real clutch drive a round
- **Button:** Play game
- **Link:** `https://ncaa2mindrill.com/?utm_source=meta&utm_medium=paid&utm_campaign=tournament_pick#tournament`

## Variant B: three drives, one title

- **Primary text:** One run, start to finish: 2025 Indiana as the 1 seed. A bye, then three real fourth-quarter drives, each one scored against what the real coach did. It took the lead all three times. Your team might not.

  Pick any team since 2023 and see your seed for free. Playing the bracket is part of the one-time $2.99 unlock.
- **Headline:** Three drives. One title.
- **Description:** Tournament mode is live
- **Button:** Play game
- **Link:** `https://ncaa2mindrill.com/?utm_source=meta&utm_medium=paid&utm_campaign=tournament_title#tournament`

The `#tournament` ending opens the Tournament tab directly. The two campaign names keep the variants apart on the
admin page's source table.

## X post

New: Tournament mode. Pick any team since 2023, get seeded into a 12-team playoff, and win it one real fourth-quarter drive at a time. Beat the real coach or you're out. ncaa2mindrill.com/#tournament

## Guardrails

- No school logos and no "College Football Playoff" or "CFP" in the art or copy; school names and colors only.
- The price is on every image and in every primary text, so nobody clicks expecting a free bracket.
- Keep the fan-made line on the art.
