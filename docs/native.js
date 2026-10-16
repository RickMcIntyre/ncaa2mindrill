/* Native bridge for the app build (Capacitor + RevenueCat). On the website this file does nothing.
 *
 * The hard modes (Saban, Cignetti) are one non-consumable in-app purchase, sold through the App Store / Google Play
 * and checked through RevenueCat's "hard_modes" entitlement. Fill in the two RevenueCat public API keys below
 * (Project settings → API keys): they are safe to ship in the app.
 */
(function () {
  'use strict';
  const RC_KEYS = { ios: 'appl_REPLACE_ME', android: 'goog_REPLACE_ME' };
  const ENTITLEMENT = 'hard_modes';
  const cap = window.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const N = { isNative, entitled: false, price: null, ready: false };
  let P = null;
  const cacheKey = 'cfb2md:premium';
  try { N.entitled = localStorage.getItem(cacheKey) === '1'; } catch { /* storage unavailable */ }

  function plugin() {
    if (P) return P;
    if (cap && typeof cap.registerPlugin === 'function') P = cap.registerPlugin('Purchases');
    return P;
  }
  function remember(v) { N.entitled = !!v; try { localStorage.setItem(cacheKey, v ? '1' : '0'); } catch { /* ignore */ } }
  function hasEntitlement(info) { return !!(info && info.entitlements && info.entitlements.active && info.entitlements.active[ENTITLEMENT]); }

  N.init = async function () {
    if (!isNative) return;
    const p = plugin(); if (!p) return;
    const platform = cap.getPlatform();
    const apiKey = RC_KEYS[platform] || RC_KEYS.android;
    try {
      await p.configure({ apiKey });
      const r = await p.getCustomerInfo();
      remember(hasEntitlement(r && r.customerInfo));
      const off = await p.getOfferings();
      const pkg = off && off.current && off.current.availablePackages && off.current.availablePackages[0];
      if (pkg && pkg.product) N.price = pkg.product.priceString || null;
      N.ready = true;
    } catch (e) { console.warn('store init', e); }
  };
  N.buy = async function () {
    const p = plugin(); if (!p) throw new Error('store unavailable');
    const off = await p.getOfferings();
    const pkg = off && off.current && off.current.availablePackages && off.current.availablePackages[0];
    if (!pkg) throw new Error('no product configured yet');
    try {
      const r = await p.purchasePackage({ aPackage: pkg });
      const ok = hasEntitlement(r && r.customerInfo);
      remember(ok);
      return ok;
    } catch (e) {
      if (e && (e.userCancelled || /cancel/i.test(String(e.message || e)))) return false;
      throw e;
    }
  };
  N.restore = async function () {
    const p = plugin(); if (!p) throw new Error('store unavailable');
    const r = await p.restorePurchases();
    const ok = hasEntitlement(r && r.customerInfo);
    remember(ok);
    return ok;
  };
  // open an outside link (X intent, the privacy page) in the system browser instead of inside the app's WebView
  N.open = async function (url) {
    try { const B = cap && cap.registerPlugin ? cap.registerPlugin('Browser') : null; if (B) { await B.open({ url }); return true; } } catch (e) { /* fall through */ }
    window.open(url, '_blank', 'noopener'); return false;
  };
  window.Native = N;
})();
