"use strict";

/** Google AdSense publisher ID. The adsbygoogle script is injected only on published post pages via withAdSenseOnPost. Homepage, /blog, /sitemap, policy, pricing, tools, author, 404 and other main pages must not load the script; they may include the google-adsense-account meta for site verification only. */
const ADSENSE_PUBLISHER_ID = "ca-pub-1134522531752598";

const ADSENSE_ACCOUNT_META =
  `<meta name="google-adsense-account" content="${ADSENSE_PUBLISHER_ID}">`;

const ADSENSE_SCRIPT =
  `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>`;


/** Paths/slugs that must never receive the adsbygoogle script (main pages, not posts). */
const ADSENSE_SCRIPT_DENIED_SLUGS = new Set([
  "",
  "index",
  "blog",
  "sitemap",
  "policy",
  "pricing",
  "delete-account",
  "thanks",
]);

function shouldLoadAdSenseScript(pathOrSlug) {
  if (pathOrSlug == null) return true;
  const raw = String(pathOrSlug).trim();
  const slug = raw.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.html$/i, "").toLowerCase();
  if (ADSENSE_SCRIPT_DENIED_SLUGS.has(slug)) return false;
  if (slug.startsWith("tools/") || slug.startsWith("author/") || slug.startsWith("views/")) return false;
  return true;
}

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
function withAdSenseOnPost(html, pathOrSlug) {
  if (!shouldLoadAdSenseScript(pathOrSlug)) {
    return ensureAdSenseAccountMeta(html);
  }
  return ensureAdSenseScriptInHead(ensureAdSenseAccountMeta(html));
}

function setAdSenseCsp(res) {
  if (res && typeof res.set === "function") {
    res.set("Content-Security-Policy", ADSENSE_CSP);
  }
}


function stripAdSense(html) {
  if (!html || typeof html !== "string") return html;
  return html
    .replace(/\s*<meta\s+name=["']google-adsense-account["'][^>]*>/gi, "")
    .replace(/\s*<script[^>]*pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js[^>]*>\s*<\/script>/gi, "");
}

/** coinx.gspteck.com is not in the AdSense ads.txt list; never add script or meta there. */
function adsenseEnabledForSite(site) {
  return !(site && site.key === "coinx");
}

function withAdSenseOnPostForSite(html, site, pathOrSlug) {
  if (!adsenseEnabledForSite(site)) return stripAdSense(html);
  return withAdSenseOnPost(html, pathOrSlug);
}

function ensureAdSenseAccountMetaForSite(html, site) {
  if (!adsenseEnabledForSite(site)) return stripAdSense(html);
  return ensureAdSenseAccountMeta(html);
}

function setAdSenseCspForSite(res, site, pathOrSlug) {
  if (!adsenseEnabledForSite(site) || !shouldLoadAdSenseScript(pathOrSlug)) return;
  setAdSenseCsp(res);
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
  stripAdSense,
  adsenseEnabledForSite,
  withAdSenseOnPostForSite,
  ensureAdSenseAccountMetaForSite,
  setAdSenseCspForSite,
};
