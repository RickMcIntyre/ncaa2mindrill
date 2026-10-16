# Shipping the app (iOS + Android)

The app is the website (`docs/`) wrapped with Capacitor, plus one in-app purchase that unlocks Saban mode and
Cignetti mode. Everything in this file that says **you** needs a human with the accounts; everything else is
already in the repo.

## 1. Accounts (you)

- **Apple Developer Program** — $99/yr. https://developer.apple.com/programs/enroll/ (takes 1–2 days to approve).
- **Google Play Console** — $25 once. https://play.google.com/console/signup (identity verification can take a few days).
- **RevenueCat** — free up to $2.5k/month in revenue. https://app.revenuecat.com — create a project "NCAA Two-Minute Drill", add an **iOS app** (bundle id `com.ncaa2mindrill.app`) and an **Android app** (package `com.ncaa2mindrill.app`).

## 2. The product (you, in each store, then RevenueCat)

One non-consumable in-app purchase in both stores. Use the same id everywhere: **`hard_modes`**, $0.99 (tier 1).

- App Store Connect → your app → In-App Purchases → `+` → Non-Consumable → reference name "Hard modes", product id `hard_modes`, price tier $0.99, localization "Saban mode + Cignetti mode".
- Google Play Console → your app → Monetize → In-app products → Create → id `hard_modes`, $0.99, "Saban mode + Cignetti mode". Activate it.
- RevenueCat → Products: import `hard_modes` from both stores. Entitlements: create **`hard_modes`** and attach both products. Offerings: the default offering gets one package ("Lifetime") pointing at the product.
- RevenueCat → Project settings → API keys: copy the **public** iOS key (`appl_…`) and Android key (`goog_…`) into `docs/native.js` (`RC_KEYS`). These are safe to ship.
- Apple also needs the App Store Connect **In-App Purchase Key** and shared secret pasted into RevenueCat (their setup page walks through it); Google needs the Play **service account JSON** (same).

## 3. Build (Android: this PC works; iOS: needs a Mac)

```bash
cd app
npm install
npm run web              # copies docs/ into app/www
npx cap add android      # once
npx cap add ios          # once, on a Mac
npm run assets           # icons + splash from app/assets/icon.png
npm run sync             # copies www/ into the native projects and installs plugins
npm run android          # opens Android Studio → Build → Generate Signed Bundle (AAB)
npm run ios              # on the Mac: opens Xcode → Product → Archive
```

Toolchain note: Capacitor's Android project uses Gradle 8.2, which needs a JDK 17–21; Android Studio's bundled JDK on this PC is 25, so a Temurin JDK 21 lives in `tools/jdk-21…` (git-ignored). Command-line builds: `source app/gradle-env.sh` first. In Android Studio: File → Settings → Build Tools → Gradle → Gradle JDK → pick the `tools/jdk-21…` folder once.

Android signing: in Android Studio, Build → Generate Signed Bundle/APK → create a keystore once and **back it up** (losing it means you can never update the app). Google Play app signing will wrap it.

iOS: in Xcode set the Team (your Apple Developer account) under Signing & Capabilities, add the **In-App Purchase** capability, then Archive and upload with the Organizer.

## 4. Store listings (you)

- Name: NCAA Two-Minute Drill. Subtitle: "Call a real college drive. Beat the coach."
- Screenshots: phone-size screenshots of the field mid-play, the pass screen with routes, the final screen with the percentile card, and the Saban paywall. (Run the site at phone width and screenshot; Apple wants 6.7" and 6.5" sizes, Google wants at least two.)
- Privacy policy URL: https://ncaa2mindrill.com/privacy.html (already live). Apple's "App Privacy" questionnaire: no data collected except purchase history (handled by RevenueCat, "not linked to you").
- Category: Games → Sports. Age rating: everyone.
- Review notes: "The hard modes are behind a single non-consumable purchase (hard_modes). Everything else is free. Use the Restore button on the paywall to re-check a purchase."

## 5. Flip the website

When the app is approved, in `docs/app.js` set `WEB_UNLOCKED = false` so Saban and Cignetti on the website show the "get the app" paywall, and put the real store links into `docs/app/index.html` (the two badges have ids `ios` and `android`).

## 6. Later

- Push a new web version → `npm run sync` in `app/` → rebuild and resubmit. The game logic and data ship inside the app, so a data refresh (new season) is a resubmission.
- RevenueCat's dashboard shows sales; Apple pays monthly, Google monthly.
