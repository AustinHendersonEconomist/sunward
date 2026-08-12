/* Page-view counting via GoatCounter — no cookies, no cross-site tracking, no
 * personal data, and therefore nothing to put a consent banner in front of.
 *
 * TO TURN ON: register the site at https://www.goatcounter.com, then put the
 * code from your dashboard URL (the MYCODE in https://MYCODE.goatcounter.com)
 * into SITE_CODE below. That is the only edit needed.
 *
 * Until then this file loads nothing and sends nothing — an empty SITE_CODE is
 * a hard off switch, not a broken request to a dead endpoint.
 *
 * It also refuses to count anywhere but the live host, so the local dev server
 * on :8080 and any file:// copy stay out of the real numbers. */
(function () {
  const SITE_CODE = "";                 // <-- your goatcounter code goes here
  const LIVE_HOST = "austinhendersoneconomist.github.io";

  if (!SITE_CODE || location.hostname !== LIVE_HOST) return;

  const s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.setAttribute(
    "data-goatcounter",
    "https://" + SITE_CODE + ".goatcounter.com/count"
  );
  document.head.appendChild(s);
})();
