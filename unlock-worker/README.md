# Web unlock: Stripe + a Cloudflare Worker

**Current state:** Payment Link `https://buy.stripe.com/4gMcN47ic63E3UZ9dedAk00` is live and wired into `docs/app.js`. The Worker is deployed at `https://ncaa2mindrill-unlock.unlock-worker.workers.dev` with the D1 database bound (`ncaa2mindrill`, table `results`) and `UNLOCK_SECRET` set. `STRIPE_SECRET` is set by running `npx wrangler secret put STRIPE_SECRET` in this folder and pasting the restricted key (Checkout Sessions: Read).

Twenty minutes, all in your own accounts. Nothing here stores customer data; Stripe keeps the receipts.

## 1. Stripe (dashboard.stripe.com)

1. **Product**: Products → Add product → name "NCAA Two-Minute Drill: Hard modes", one-time price **$0.99**.
2. **Payment Link**: Payment Links → New → pick that price. In the link's settings:
   - After payment: **Don't show confirmation page, redirect customers to your website**, URL
     `https://ncaa2mindrill.com/?unlock={CHECKOUT_SESSION_ID}#saban`
   - Collect customer email: on (it is by default; it's what "I already paid" uses).
3. Copy the link (looks like `https://buy.stripe.com/abc123…`).
4. **Restricted key**: Developers → API keys → Create restricted key → name "ncaa2mindrill unlock", permissions: **Checkout Sessions: Read** (nothing else). Copy it once; it's shown once.

## 2. Cloudflare Worker (free)

```bash
cd unlock-worker
npx wrangler login                       # opens the browser, log into (or create) your Cloudflare account
npx wrangler secret put STRIPE_SECRET    # paste the restricted key
npx wrangler secret put UNLOCK_SECRET    # paste any long random string (e.g. 40 random characters); never change it later
npx wrangler deploy                      # prints the URL, like https://ncaa2mindrill-unlock.<you>.workers.dev
```

Check it: open `https://ncaa2mindrill-unlock.<you>.workers.dev/` and you should see `{"ok":true,"service":"ncaa2mindrill unlock"}`.

## 3. Wire the site

In `docs/app.js` set `STRIPE_LINK` to the Payment Link and `UNLOCK_API` to the Worker URL, bump the `app.js?v=` tag in `docs/index.html`, commit, push.

## 4. Daily leaderboard (optional, same Worker)

The final screen can show "you beat 73% of today's 1,204 players" from real results. It needs a Cloudflare D1 database (free tier): run the two commands commented in `wrangler.toml`, paste the database id into the `[[d1_databases]]` block, uncomment it, and `npx wrangler deploy` again. The site submits one anonymous row per finished daily drive (day number, mode, win chance, a random per-browser token); nothing identifies a person.

## How it works

- "Unlock both · $0.99" opens the Payment Link. After paying, Stripe sends the player back with the session id; the site asks the Worker to confirm it with Stripe and gets a signed **unlock code**, which it keeps in the browser.
- The code is shown on the Saban/Cignetti intro screens with a Copy button, so it works on another device via "I already paid".
- "I already paid" also accepts the receipt email: the Worker looks up paid sessions for that email.
- Test mode: use Stripe's test Payment Link + a test restricted key first, pay with card `4242 4242 4242 4242`, then swap to live.
