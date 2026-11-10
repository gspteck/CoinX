"use strict";

/** Google AdSense publisher for all GSPTeck Content Engine sites. */
const ADSENSE_PUBLISHER_ID = "ca-pub-6628299939568043";

const ADSENSE_ACCOUNT_META =
  `<meta name="google-adsense-account" content="${ADSENSE_PUBLISHER_ID}">`;

const ADSENSE_SCRIPT =
  `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>`;

// Applied on published post responses only. Allows existing inline CSS/JS,
// first-party assets, HTTPS images, and the Google AdSense endpoints.
const ADSENSE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com https://www.googlesyndication.com https://www.google.com https://www.gstatic.com https://adservice.google.com https://partner.googleadservices.com https://tpc.googlesyndication.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://pagead2.googlesyndication.com https://www.googlesyndication.com https://googleads.g.doubleclick.net https://*.google.com https://*.g.doubleclick.net https://storage.googleapis.com https://*.googleapis.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
  "frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://www.google.com https://pagead2.googlesyndication.com https://*.googlesyndication.com https://www.youtube.com https://www.youtube-nocookie.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://www.google.com https://*.google.com",
].join("; ");

function injectHeadTag(html, tag, alreadyRe) {
  if (!html || typeof html !== "string") return html;
  if (alreadyRe.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
  }
  return `${tag}\n${html}`;
}

function ensureAdSenseAccountMeta(html) {
  return injectHeadTag(html, ADSENSE_ACCOUNT_META, /google-adsense-account/i);
}

function ensureAdSenseScriptInHead(html) {
  return injectHeadTag(
    html,
    ADSENSE_SCRIPT,
    /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i
  );
}

/** Meta + Auto ads script. Use on published posts only, never landings. */
function withAdSenseOnPost(html) {
  return ensureAdSenseScriptInHead(ensureAdSenseAccountMeta(html));
}

function setAdSenseCsp(res) {
  if (res && typeof res.set === "function") {
    res.set("Content-Security-Policy", ADSENSE_CSP);
  }
}

module.exports = {
  ADSENSE_PUBLISHER_ID,
  ADSENSE_ACCOUNT_META,
  ADSENSE_SCRIPT,
  ADSENSE_CSP,
  ensureAdSenseAccountMeta,
  ensureAdSenseScriptInHead,
  withAdSenseOnPost,
  setAdSenseCsp,
};
