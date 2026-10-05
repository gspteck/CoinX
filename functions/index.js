const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const express = require("express");

admin.initializeApp();
const db = admin.firestore();

// === Published content configuration (multi-tenant: one Firebase project, N sites) ===
// Each site is a separate brand/domain with its own Firestore collection and media prefix.
// The webhook can disambiguate which site a publish targets via payload.site ("coindrop"|"coinx"),
// falling back to request-host detection, then to DEFAULT_SITE (coindrop) for backward compat.
const SITES = {
  coindrop: {
    key: "coindrop",
    baseUrl: "https://coindrop.website",
    collection: "coindropPages",
    canonicalHosts: ["coindrop.website"],
    mediaPrefix: "coindrop-media",
  },
  coinx: {
    key: "coinx",
    baseUrl: "https://coinx.gspteck.com",
    collection: "coinxPages",
    canonicalHosts: ["coinx.gspteck.com"],
    mediaPrefix: "coinx-media",
  },
};
const DEFAULT_SITE = SITES.coindrop;

// The root path for the "landing" of published content on the dedicated site.
const PUBLISHED_LANDING = "/";

function getRequestHost(req) {
  const forwarded = (req.get("x-forwarded-host") || "").split(",")[0].trim();
  const raw = forwarded || req.get("host") || "";
  return raw.toLowerCase().replace(/:\d+$/, "");
}

function siteApexName(host) {
  if (!host) return null;
  const apex = host.replace(/^www\./, "").trim();
  for (const key of Object.keys(SITES)) {
    if (SITES[key].canonicalHosts.includes(apex)) return key;
  }
  return null;
}

function getSiteForRequest(req) {
  const key = siteApexName(getRequestHost(req));
  return (key && SITES[key]) || DEFAULT_SITE;
}

/** Resolve the site a webhook payload targets (payload.site: "coindrop"|"coinx"). */
function siteFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const key = payload.site;
  return SITES[key] || null;
}

// Lazily obtain the default storage bucket only when needed (media uploads).
// This avoids errors during plain `require()` / syntax checks outside a real Firebase context.
let _bucket = null;
function getBucket() {
  if (!_bucket) {
    _bucket = admin.storage().bucket();
  }
  return _bucket;
}

// === Secret stored via: firebase functions:secrets:set CONTENTENGINE_SECRET ===
const contentengineSecret = defineSecret("CONTENTENGINE_SECRET");

// === contentengine contract v3 helpers ===

function getContentEngineHeaders(req) {
  // Header names are case-insensitive via req.get()
  return {
    event: (req.get("X-ContentEngine-Event") || "").trim(),
    timestamp: (req.get("X-ContentEngine-Timestamp") || "").trim(),
    signature: (req.get("X-ContentEngine-Signature") || "").trim(),
  };
}

function isTimestampFresh(tsStr) {
  const ts = parseInt(tsStr, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= 300; // 5 minutes
}

function verifyContentEngineSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !rawBody) return false;

  // Accept "sha256=..." (case-insensitive on the prefix)
  const match = signatureHeader.match(/^sha256=([a-f0-9]+)$/i);
  if (!match) return false;

  const providedHex = match[1].toLowerCase();
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody) // raw bytes exactly as received
    .digest("hex")
    .toLowerCase();

  // Constant-time comparison of the hash bytes (not the strings)
  if (providedHex.length !== expectedHex.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedHex, "hex"),
      Buffer.from(expectedHex, "hex")
    );
  } catch {
    return false;
  }
}

async function uploadMediaToStorage(filename, base64Data, contentType, postSlug, mediaPrefix) {
  const b = getBucket();
  const buffer = Buffer.from(base64Data, "base64");
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destPath = `${mediaPrefix || "coindrop-media"}/${postSlug}/${Date.now()}-${safeFilename}`;
  const file = b.file(destPath);

  await file.save(buffer, {
    contentType: contentType || "application/octet-stream",
    resumable: false,
  });

  // Make publicly readable (best effort)
  try {
    await file.makePublic();
  } catch (e) {
    // continue; some environments may use signed URLs instead
  }

  return `https://storage.googleapis.com/${b.name}/${destPath}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render contentengine related_articles as an internal-link list for crawl discovery.
 * Keep each title/url exactly; never add nofollow.
 */
function buildRelatedArticlesHtml(relatedArticles) {
  if (!Array.isArray(relatedArticles) || relatedArticles.length === 0) {
    return "";
  }

  const items = relatedArticles
    .filter((a) => a && typeof a.title === "string" && typeof a.url === "string" && a.title && a.url)
    .map(
      (a) =>
        `      <li><a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a></li>`
    )
    .join("\n");

  if (!items) return "";

  return `
  <aside class="related-articles" aria-labelledby="related-articles-heading">
    <h2 id="related-articles-heading">Related articles</h2>
    <ul>
${items}
    </ul>
  </aside>`;
}

/** Request host without port (prefers X-Forwarded-Host from Firebase Hosting). */
function isCanonicalPublishedHost(host, site) {
  const s = site || DEFAULT_SITE;
  return s.canonicalHosts.includes(host);
}

/** Absolute canonical URL for a clean path (e.g. "/" or "/my-slug"). */
function publishedCanonicalUrl(cleanPath, site) {
  const baseUrl = (site || DEFAULT_SITE).baseUrl;
  const path =
    !cleanPath || cleanPath === "/"
      ? "/"
      : `/${String(cleanPath).replace(/^\/+|\/+$/g, "")}`;
  return path === "/" ? `${baseUrl}/` : `${baseUrl}${path}`;
}

function redirectToPublishedCanonical(res, cleanPath, site) {
  const location = publishedCanonicalUrl(cleanPath, site);
  res.set("Cache-Control", "public, max-age=3600");
  res.redirect(301, location);
}

/**
 * Ensure a single <link rel="canonical"> pointing at the preferred URL.
 * Replaces any existing canonical so stored HTML and runtime stay consistent.
 */
function ensureCanonicalLink(html, canonicalHref) {
  if (!html || typeof html !== "string") return html;
  const linkTag = `<link rel="canonical" href="${escapeHtml(canonicalHref)}">`;
  if (/rel\s*=\s*["']canonical["']/i.test(html)) {
    return html.replace(
      /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i,
      linkTag
    );
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${linkTag}`);
  }
  return `${linkTag}\n${html}`;
}

function buildPublishedHtml(post, relatedArticles, site) {
  const s = site || DEFAULT_SITE;
  const title = post.title || "Published Page";
  const description = post.meta_description || "";
  const bodyHtml = post.body_html || "";
  const jsonLd = post.json_ld ? JSON.stringify(post.json_ld) : null;
  const relatedHtml = buildRelatedArticlesHtml(relatedArticles);
  const slug = sanitizeSlug(post.slug);
  const canonicalHref = slug
    ? publishedCanonicalUrl(`/${slug}`, s)
    : `${s.baseUrl}/`;

  const trimmed = bodyHtml.trim();
  const looksComplete = /^<!doctype|<html/i.test(trimmed);

  if (looksComplete) {
    // Inject ld+json into head if we have it and a head tag exists
    let html = bodyHtml;
    if (jsonLd) {
      const script = `<script type="application/ld+json">${jsonLd}</script>`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${script}`);
      } else {
        html = script + "\n" + html;
      }
    }
    // Append Related articles before </body> so internal links are crawlable
    if (relatedHtml) {
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${relatedHtml}\n</body>`);
      } else {
        html = html + relatedHtml;
      }
    }
    return ensureCanonicalLink(html, canonicalHref);
  }

  // Build a clean standalone HTML document
  const ldScript = jsonLd
    ? `<script type="application/ld+json">${jsonLd}</script>`
    : "";

  return `<!DOCTYPE html>
<html lang="${escapeHtml(post.language || "en")}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${escapeHtml(canonicalHref)}">
  ${description ? `<meta name="description" content="${escapeHtml(description)}">` : ""}
  ${ldScript}
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.7; max-width: 780px; margin: 40px auto; padding: 0 16px; }
    img, figure, video { max-width: 100%; height: auto; display: block; }
    pre, code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
    h1, h2, h3 { line-height: 1.25; }
    .related-articles { margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid #e5e7eb; }
    .related-articles h2 { font-size: 1.15rem; margin: 0 0 0.75rem; }
    .related-articles ul { margin: 0; padding-left: 1.25rem; }
    .related-articles li { margin: 0.35rem 0; }
  </style>
</head>
<body>
  <article>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </article>
  ${relatedHtml}
</body>
</html>`;
}

function sanitizeSlug(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim().replace(/^\/+|\/+$/g, "").replace(/\.html$/i, "");
  s = s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s || s.length === 0 || s.length > 64) return null;
  // Reserved paths on the dedicated published site (root-level).
  // Keep generic so the same functions can be reused for future projects.
  const reserved = new Set(["api", "assets", "index", "404", "sitemap", "robots"]);
  if (reserved.has(s)) return null;
  return s;
}

function isValidHtml(str) {
  if (!str || typeof str !== "string") return false;
  const t = str.trim();
  if (t.length < 30) return false;
  return /<!doctype|<html|<head|<body/i.test(t);
}

async function savePublishedPage(slug, html, collection) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection(collection || DEFAULT_SITE.collection).doc(slug).set({
    slug,
    html,
    publishedAt: now,
    updatedAt: now,
  }, { merge: true });
}

async function getPublishedPage(slug, collection) {
  const doc = await db.collection(collection || DEFAULT_SITE.collection).doc(slug).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function listPublishedSlugs(collection) {
  const snap = await db.collection(collection || DEFAULT_SITE.collection).select().get();
  return snap.docs.map((d) => d.id);
}

/** @returns {Promise<Array<{ slug: string, lastmod: string }>>} */
async function listPublishedPagesForSitemap(collection) {
  const snap = await db
    .collection(collection || DEFAULT_SITE.collection)
    .select("updatedAt", "publishedAt")
    .get();
  const today = new Date().toISOString().split("T")[0];
  return snap.docs.map((d) => {
    const data = d.data() || {};
    const ts = data.updatedAt || data.publishedAt;
    let lastmod = today;
    if (ts && typeof ts.toDate === "function") {
      lastmod = ts.toDate().toISOString().split("T")[0];
    }
    return { slug: d.id, lastmod };
  });
}

// === Shared sitemap helpers (use PUBLISHED_* constants for reuse) ===
// Served live by publishedSitemapXml / publishedRobotsTxt on each request.
// contentengine post.publish | post.update | post.delete write Firestore; the next
// crawl of /sitemap.xml and /robots.txt picks up the new set of slugs automatically.
// IMPORTANT: do not deploy static robots.txt / sitemap.xml on the coindrop
// hosting target — Firebase serves exact static files before rewrites.

function toIsoDate(value) {
  if (!value) return new Date().toISOString().split("T")[0];
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString().split("T")[0];
  }
  if (value instanceof Date) return value.toISOString().split("T")[0];
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return new Date().toISOString().split("T")[0];
}

async function getPublishedSitemapEntries(site) {
  const s = site || DEFAULT_SITE;
  const today = toIsoDate(new Date());
  const entries = [
    {
      loc: `${s.baseUrl}/`,
      lastmod: today,
      priority: "0.9",
      changefreq: "monthly",
    },
  ];
  try {
    const pages = await listPublishedPagesForSitemap(s.collection);
    // Stable order helps diffs / Search Console
    pages.sort((a, b) => a.slug.localeCompare(b.slug));
    for (const p of pages) {
      entries.push({
        loc: `${s.baseUrl}/${p.slug}`,
        lastmod: p.lastmod || today,
        priority: "0.8",
        changefreq: "monthly",
      });
    }
  } catch (e) {
    console.error("[sitemap] failed to list published pages", e);
    // continue with just the landing page
  }
  return entries;
}

function buildSitemapXml(entries) {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of entries) {
    const lastmod = u.lastmod || toIsoDate(new Date());
    xml.push("  <url>");
    xml.push(`    <loc>${u.loc}</loc>`);
    xml.push(`    <lastmod>${lastmod}</lastmod>`);
    xml.push(`    <changefreq>${u.changefreq}</changefreq>`);
    xml.push(`    <priority>${u.priority}</priority>`);
    xml.push("  </url>");
  }
  xml.push("</urlset>");
  return xml.join("\n");
}

// === 1. Webhook: POST /coindrop/api/contentengine-publish (contentengine contract v3) ===
//
// Correct implementation per contentengine webhook spec:
// - Verify X-ContentEngine-Signature (sha256=<hex>) against the **raw body bytes** (constant-time HMAC)
// - Check X-ContentEngine-Timestamp (reject if >5 min old)
// - Branch on X-ContentEngine-Event (or payload.event): ping | media.upload | post.publish | post.update | post.delete
// - v3: honour top-level `test` — full-shaped connection check; reply normally but do not save/publish
// - Always answer with the documented JSON shape within ~30s
//
// We use a tiny dedicated Express app + express.raw() as the very first middleware.
// This is the only reliable way in Cloud Functions to obtain the untouched bytes for the signature.

const contentengineApp = express();

// We must obtain the EXACT bytes contentengine signed with HMAC.
// Strategy (in order):
// 1. Attach a raw stream listener FIRST so we can capture bytes before anyone consumes the request.
// 2. Then register express.raw with a verify() callback (the normal body-parser way).
// 3. In the handler, use a defensive getRawBody + pre-parsed fallback.

function captureRawBodyFirst(req, res, next) {
  // Already captured?
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return next();
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    return next();
  }

  const chunks = [];
  req.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on("end", () => {
    const captured = Buffer.concat(chunks);
    if (!req.rawBody) req.rawBody = captured;
    // Make sure req.body is a Buffer for express.raw if it still runs.
    if (!Buffer.isBuffer(req.body)) req.body = captured;
    next();
  });
  req.on("error", (err) => next(err));
}

// MUST be the absolute first middleware for this app.
contentengineApp.use(captureRawBodyFirst);

// Standard express.raw with verify callback (this is the cleanest path when the stream is still available).
contentengineApp.use(
  express.raw({
    type: "*/*",
    limit: "20mb",
    verify: (req, res, buf) => {
      // This runs with the original bytes if the stream wasn't already drained.
      if (buf && Buffer.isBuffer(buf) && !req.rawBody) {
        req.rawBody = buf;
      }
    },
  })
);

// Use a wildcard so it doesn't matter what path the rewrite delivers to the function
// (some rewrites keep the original path, some mount at root).
contentengineApp.all(/.*/, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = contentengineSecret.value();
  if (!secret) {
    console.error("[contentengine] CONTENTENGINE_SECRET not set");
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  // === ROBUST RAW BODY + PAYLOAD ACQUISITION ===
  // Firebase Functions sometimes delivers a pre-parsed object instead of raw bytes.
  // We need:
  //   - raw bytes (or best-effort equivalent) ONLY for HMAC signature verification
  //   - a parsed payload object for the rest of the logic
  //
  // Strategy:
  //   1. Prefer req.rawBody (captured via express.raw verify or early stream listener)
  //   2. Prefer req.body if it is already a Buffer
  //   3. If body is a string, use it
  //   4. If body is already a parsed Object (the case that was 500ing), use it directly
  //      as the payload and stringify it (best effort) for signature verification.
  //   5. Never pass a raw Object to Buffer.from().

  let rawBody = Buffer.alloc(0);
  let payloadFromPreParsed = null;

  const b = req.body;
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
    rawBody = req.rawBody;
  } else if (Buffer.isBuffer(b)) {
    rawBody = b;
  } else if (typeof b === "string") {
    rawBody = Buffer.from(b);
  } else if (b && typeof b === "object") {
    // Pre-parsed object case (caused the original Buffer.from(Object) crash)
    console.warn(
      "[contentengine] req.body arrived pre-parsed as Object. Using JSON.stringify for signature bytes " +
        "(may cause signature mismatch if whitespace/key-order differs from what contentengine sent). " +
        "Payload will be taken directly from the parsed object."
    );
    try {
      rawBody = Buffer.from(JSON.stringify(b));
    } catch (e) {
      rawBody = Buffer.alloc(0);
    }
    payloadFromPreParsed = b;
  }

  // If we still have nothing, make sure we have an empty buffer (never undefined)
  if (!Buffer.isBuffer(rawBody)) {
    rawBody = Buffer.alloc(0);
  }

  const headers = getContentEngineHeaders(req);

  // Timestamp freshness check (5 minutes)
  if (!isTimestampFresh(headers.timestamp)) {
    res.status(400).json({ error: "timestamp too old or invalid" });
    return;
  }

  // === SIGNATURE VERIFICATION (must be on raw bytes, constant time) ===
  const sigOk = verifyContentEngineSignature(rawBody, headers.signature, secret);
  if (!sigOk) {
    // Safe diagnostic logging (never log the secret itself)
    console.warn("[contentengine] signature verification FAILED", {
      event: headers.event,
      timestamp: headers.timestamp,
      sigHeader: headers.signature ? headers.signature.substring(0, 20) + "..." : "(missing)",
      rawBodyLength: rawBody.length,
      bodyPrefix: rawBody.length > 0 ? rawBody.toString("utf8").substring(0, 300) : "(empty)",
    });
    res.status(401).json({ error: "bad signature" });
    return;
  }

  console.log("[contentengine] signature OK for event:", headers.event || "(from body)");

  // Signature OK → obtain payload.
  // If we captured a pre-parsed object earlier, use it (avoids double-stringify issues).
  // Otherwise parse from the raw bytes we will have used for the signature.
  let payload;
  if (payloadFromPreParsed && typeof payloadFromPreParsed === "object") {
    payload = payloadFromPreParsed;
  } else {
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (e) {
      res.status(400).json({ error: "invalid json body" });
      return;
    }
  }

  const event = (headers.event || (payload && payload.event) || "").trim();
  // v3: connection-check payloads carry test:true — verify & shape-check normally, never persist.
  const isTest = payload && payload.test === true;
  // Which site does this publish target? Explicit payload.site wins, else request host, else coindrop.
  const activeSite = siteFromPayload(payload) || getSiteForRequest(req) || DEFAULT_SITE;

  try {
    if (event === "ping") {
      // Contract v3 (test flag + post.delete)
      res.json({ ok: true, version: 3 });
      return;
    }

    if (event === "media.upload") {
      const postSlugRaw = payload.post_slug || "unknown";
      const postSlug = sanitizeSlug(postSlugRaw) || "unknown";
      const out = [];

      const items = Array.isArray(payload.media) ? payload.media : [];
      for (const m of items) {
        if (!m || !m.filename || !m.data_base64) continue;
        try {
          // test media: still return a real public URL so the follow-up test
          // post.publish can rewrite body_html; the post itself is discarded.
          const url = await uploadMediaToStorage(
            m.filename,
            m.data_base64,
            m.content_type,
            isTest ? `_test/${postSlug}` : postSlug,
            activeSite.mediaPrefix
          );
          out.push({ filename: m.filename, url });
        } catch (uploadErr) {
          console.error("[contentengine] media upload failed for", m.filename, uploadErr);
          // Omit entry → contentengine drops the file (per spec)
        }
      }

      if (isTest) {
        console.log("[contentengine] media.upload test: returned", out.length, "url(s); not linked to a live post");
      }

      res.json({ media: out });
      return;
    }

    if (event === "post.publish" || event === "post.update") {
      const post = payload.post || {};
      const slug = sanitizeSlug(post.slug);

      if (!slug) {
        res.status(400).json({ error: "invalid or missing post.slug" });
        return;
      }

      // Use the resolved site's generic published base URL (root-level slug on the dedicated hosting target)
      const publishedUrl = `${activeSite.baseUrl}/${slug}`;

      // v3 test flag: answer with the published_url we would have used, but do not
      // save, publish, or expose the page (sitemap/robots stay untouched).
      if (isTest) {
        console.log(
          `[contentengine] ${event} test[${activeSite.key}]: acknowledging ${slug} -> ${publishedUrl} (not saved)`
        );
        res.json({ published_url: publishedUrl });
        return;
      }

      // related_articles: internal links contentengine expects on the live page for crawl paths
      const fullHtml = buildPublishedHtml(post, payload.related_articles, activeSite);
      await savePublishedPage(slug, fullHtml, activeSite.collection);

      // Sitemap + robots are generated on the fly from Firestore by
      // publishedSitemapXml / publishedRobotsTxt — no static file write needed.
      console.log(
        `[contentengine] ${event}[${activeSite.key}]: ${slug} -> ${publishedUrl} (sitemap/robots will include via Firestore)`
      );

      res.json({
        published_url: publishedUrl,
        sitemap_url: `${activeSite.baseUrl}/sitemap.xml`,
        robots_url: `${activeSite.baseUrl}/robots.txt`,
      });
      return;
    }

    if (event === "post.delete") {
      // test deletes: acknowledge without touching storage
      if (isTest) {
        console.log("[contentengine] post.delete test: acknowledging without delete");
        res.json({ ok: true });
        return;
      }

      const slug = sanitizeSlug(payload.post && payload.post.slug);
      if (slug) {
        try {
          await db.collection(activeSite.collection).doc(slug).delete();
          console.log(
            `[contentengine] post.delete[${activeSite.key}]: removed ${slug} (dropped from sitemap/robots on next request)`
          );
        } catch (delErr) {
          // Idempotent: still return 200
        }
      }
      res.json({
        ok: true,
        sitemap_url: `${activeSite.baseUrl}/sitemap.xml`,
        robots_url: `${activeSite.baseUrl}/robots.txt`,
      });
      return;
    }

    // Forward compatibility: acknowledge unknown events
    res.json({ ok: true });
  } catch (err) {
    console.error("[contentengine] handler error for event", event, err);
    res.status(500).json({ error: "internal error" });
  }
});

// The Cloud Function is the Express app (Firebase will route POSTs here).
exports.contentenginePublish = onRequest(
  {
    region: "us-central1",
    secrets: [contentengineSecret],
    cors: false,
    maxInstances: 10,
  },
  contentengineApp
);

// === 2. Serve published pages dynamically (root-level on dedicated site) ===
// This function is mounted at the coindrop hosting target root.
// Matches: /slug   or   /slug.html   (root-level published content)
// Designed to be reusable for future projects by changing PUBLISHED_* constants.
//
// SEO normalizations (Search Console "doubled" URLs):
//  1. Non-canonical hosts (*.web.app / *.firebaseapp.com) → 301 to PUBLISHED_BASE_URL
//  2. /slug.html → 301 to /slug
//  3. Inject/replace <link rel="canonical"> on every response

exports.servePublishedPage = onRequest(
  {
    region: "us-central1",
    maxInstances: 30,
  },
  async (req, res) => {
    let slug = null;
    let requestedHtmlExt = false;

    const p = req.path || "";
    const host = getRequestHost(req);
    const site = getSiteForRequest(req);

    // Match root-level slug or slug.html  (e.g. /my-post or /my-post.html)
    // IMPORTANT: skip the root "/" itself — hosting will serve index.html for that.
    let m = p.match(/^\/([a-z0-9-]+)(\.html)?$/i);
    if (m && m[1]) {
      slug = sanitizeSlug(m[1]);
      requestedHtmlExt = Boolean(m[2]);
    } else if (req.query && req.query.slug) {
      slug = sanitizeSlug(req.query.slug);
    }

    if (!slug) {
      // Still collapse alternate hosts hitting unknown paths toward the canonical site.
      if (host && !isCanonicalPublishedHost(host, site)) {
        redirectToPublishedCanonical(res, "/", site);
        return;
      }
      res.status(404).send("Not found");
      return;
    }

    const cleanPath = `/${slug}`;

    // Prefer a single host in the index (coindrop.website over coindropapp.web.app).
    if (host && !isCanonicalPublishedHost(host, site)) {
      redirectToPublishedCanonical(res, cleanPath, site);
      return;
    }

    // Prefer clean URLs over .html twins (both used to 200 with identical bodies).
    if (requestedHtmlExt) {
      redirectToPublishedCanonical(res, cleanPath, site);
      return;
    }

    try {
      const page = await getPublishedPage(slug, site.collection);
      if (!page || !page.html) {
        res.status(404).send("Page not found");
        return;
      }

      const canonicalHref = publishedCanonicalUrl(cleanPath, site);
      const html = ensureCanonicalLink(page.html, canonicalHref);

      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", "public, max-age=300");
      res.set("Link", `<${canonicalHref}>; rel="canonical"`);
      res.status(200).send(html);
    } catch (err) {
      console.error("[servePublishedPage] error", err);
      res.status(500).send("Error loading page");
    }
  }
);

// === 3. Published site robots.txt ===
// Keep this simple: Allow: / already covers every slug. Dynamic per-slug Allow
// lines are unnecessary and the static file in coindrop-public/robots.txt is
// also deployed (Hosting serves exact static files before rewrites).

exports.publishedRobotsTxt = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
  },
  async (req, res) => {
    const host = getRequestHost(req);
    const site = getSiteForRequest(req);
    if (host && !isCanonicalPublishedHost(host, site)) {
      redirectToPublishedCanonical(res, "/robots.txt", site);
      return;
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    // Avoid sticky CDN/browser cache of stale Sitemap lines
    res.set("Cache-Control", "public, max-age=0, must-revalidate");

    const body = [
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${site.baseUrl}/sitemap.xml`,
      "",
    ].join("\n");

    res.status(200).send(body);
  }
);

// === 4. Published site sitemap.xml (landing + all published slugs) ===

exports.publishedSitemapXml = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
  },
  async (req, res) => {
    const host = getRequestHost(req);
    const site = getSiteForRequest(req);
    if (host && !isCanonicalPublishedHost(host, site)) {
      redirectToPublishedCanonical(res, "/sitemap.xml", site);
      return;
    }

    res.set("Content-Type", "application/xml; charset=utf-8");
    // Avoid sticky CDN/browser cache of old <loc> hosts after domain changes
    res.set("Cache-Control", "public, max-age=0, must-revalidate");

    const entries = await getPublishedSitemapEntries(site);
    res.status(200).send(buildSitemapXml(entries));
  }
);

