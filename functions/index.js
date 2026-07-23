const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const express = require("express");

admin.initializeApp();
const db = admin.firestore();

// Lazily obtain the default storage bucket only when needed (media uploads).
// This avoids errors during plain `require()` / syntax checks outside a real Firebase context.
let _bucket = null;
function getBucket() {
  if (!_bucket) {
    _bucket = admin.storage().bucket();
  }
  return _bucket;
}

// === Secret stored via: firebase functions:secrets:set RANKGOAT_SECRET ===
const rankgoatSecret = defineSecret("RANKGOAT_SECRET");

// === RankGoat contract v2 helpers ===

function getRankGoatHeaders(req) {
  // Header names are case-insensitive via req.get()
  return {
    event: (req.get("X-RankGoat-Event") || "").trim(),
    timestamp: (req.get("X-RankGoat-Timestamp") || "").trim(),
    signature: (req.get("X-RankGoat-Signature") || "").trim(),
  };
}

function isTimestampFresh(tsStr) {
  const ts = parseInt(tsStr, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= 300; // 5 minutes
}

function verifyRankGoatSignature(rawBody, signatureHeader, secret) {
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

async function uploadMediaToStorage(filename, base64Data, contentType, postSlug) {
  const b = getBucket();
  const buffer = Buffer.from(base64Data, "base64");
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destPath = `coindrop-media/${postSlug}/${Date.now()}-${safeFilename}`;
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

function buildPublishedHtml(post) {
  const title = post.title || "Published Page";
  const description = post.meta_description || "";
  const bodyHtml = post.body_html || "";
  const jsonLd = post.json_ld ? JSON.stringify(post.json_ld) : null;

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
    return html;
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
  ${description ? `<meta name="description" content="${escapeHtml(description)}">` : ""}
  ${ldScript}
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.7; max-width: 780px; margin: 40px auto; padding: 0 16px; }
    img, figure, video { max-width: 100%; height: auto; display: block; }
    pre, code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
    h1, h2, h3 { line-height: 1.25; }
  </style>
</head>
<body>
  <article>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </article>
</body>
</html>`;
}

function sanitizeSlug(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim().replace(/^\/+|\/+$/g, "").replace(/\.html$/i, "");
  s = s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s || s.length === 0 || s.length > 64) return null;
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

async function savePublishedPage(slug, html) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("coindropPages").doc(slug).set({
    slug,
    html,
    publishedAt: now,
    updatedAt: now,
  }, { merge: true });
}

async function getPublishedPage(slug) {
  const doc = await db.collection("coindropPages").doc(slug).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function listPublishedSlugs() {
  const snap = await db.collection("coindropPages").select().get();
  return snap.docs.map(d => d.id);
}

// === Shared sitemap helpers ===

async function getCoindropSitemapEntries() {
  const entries = [
    { loc: "https://coinx.gspteck.com/coindrop", priority: "0.9", changefreq: "monthly" },
  ];
  try {
    const slugs = await listPublishedSlugs();
    for (const s of slugs) {
      entries.push({
        loc: `https://coinx.gspteck.com/coindrop/${s}.html`,
        priority: "0.8",
        changefreq: "monthly",
      });
    }
  } catch (e) {
    // continue with just the landing page
  }
  return entries;
}

function buildSitemapXml(entries) {
  const today = new Date().toISOString().split("T")[0];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of entries) {
    xml.push("  <url>");
    xml.push(`    <loc>${u.loc}</loc>`);
    xml.push(`    <lastmod>${today}</lastmod>`);
    xml.push(`    <changefreq>${u.changefreq}</changefreq>`);
    xml.push(`    <priority>${u.priority}</priority>`);
    xml.push("  </url>");
  }
  xml.push("</urlset>");
  return xml.join("\n");
}

// === 1. Webhook: POST /coindrop/api/rankgoat-publish (RankGoat contract v2) ===
//
// Correct implementation per RankGoat webhook spec:
// - Verify X-RankGoat-Signature (sha256=<hex>) against the **raw body bytes** (constant-time HMAC)
// - Check X-RankGoat-Timestamp (reject if >5 min old)
// - Branch on X-RankGoat-Event (or payload.event): ping | media.upload | post.publish | post.update | post.delete
// - Always answer with the documented JSON shape within ~30s
//
// We use a tiny dedicated Express app + express.raw() as the very first middleware.
// This is the only reliable way in Cloud Functions to obtain the untouched bytes for the signature.

const rankgoatApp = express();

// We must obtain the EXACT bytes RankGoat signed with HMAC.
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
rankgoatApp.use(captureRawBodyFirst);

// Standard express.raw with verify callback (this is the cleanest path when the stream is still available).
rankgoatApp.use(
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
rankgoatApp.all(/.*/, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = rankgoatSecret.value();
  if (!secret) {
    console.error("[rankgoat] RANKGOAT_SECRET not set");
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
      "[rankgoat] req.body arrived pre-parsed as Object. Using JSON.stringify for signature bytes " +
        "(may cause signature mismatch if whitespace/key-order differs from what RankGoat sent). " +
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

  const headers = getRankGoatHeaders(req);

  // Timestamp freshness check (5 minutes)
  if (!isTimestampFresh(headers.timestamp)) {
    res.status(400).json({ error: "timestamp too old or invalid" });
    return;
  }

  // === SIGNATURE VERIFICATION (must be on raw bytes, constant time) ===
  const sigOk = verifyRankGoatSignature(rawBody, headers.signature, secret);
  if (!sigOk) {
    // Safe diagnostic logging (never log the secret itself)
    console.warn("[rankgoat] signature verification FAILED", {
      event: headers.event,
      timestamp: headers.timestamp,
      sigHeader: headers.signature ? headers.signature.substring(0, 20) + "..." : "(missing)",
      rawBodyLength: rawBody.length,
      bodyPrefix: rawBody.length > 0 ? rawBody.toString("utf8").substring(0, 300) : "(empty)",
    });
    res.status(401).json({ error: "bad signature" });
    return;
  }

  console.log("[rankgoat] signature OK for event:", headers.event || "(from body)");

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

  try {
    if (event === "ping") {
      // Contract v2
      res.json({ ok: true, version: 2 });
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
          const url = await uploadMediaToStorage(
            m.filename,
            m.data_base64,
            m.content_type,
            postSlug
          );
          out.push({ filename: m.filename, url });
        } catch (uploadErr) {
          console.error("[rankgoat] media upload failed for", m.filename, uploadErr);
          // Omit entry → RankGoat drops the file (per spec)
        }
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

      const fullHtml = buildPublishedHtml(post);
      await savePublishedPage(slug, fullHtml);

      const publishedUrl = `https://coinx.gspteck.com/coindrop/${slug}.html`;
      console.log(`[rankgoat] ${event}: ${slug} -> ${publishedUrl}`);

      res.json({ published_url: publishedUrl });
      return;
    }

    if (event === "post.delete") {
      const slug = sanitizeSlug(payload.post && payload.post.slug);
      if (slug) {
        try {
          await db.collection("coindropPages").doc(slug).delete();
          console.log(`[rankgoat] post.delete: removed ${slug}`);
        } catch (delErr) {
          // Idempotent: still return 200
        }
      }
      res.json({ ok: true });
      return;
    }

    // Forward compatibility: acknowledge unknown events
    res.json({ ok: true });
  } catch (err) {
    console.error("[rankgoat] handler error for event", event, err);
    res.status(500).json({ error: "internal error" });
  }
});

// The Cloud Function is the Express app (Firebase will route POSTs here).
exports.rankgoatPublish = onRequest(
  {
    region: "us-central1",
    secrets: [rankgoatSecret],
    cors: false,
    maxInstances: 10,
  },
  rankgoatApp
);

// === 2. Serve published pages dynamically ===
// Matches: /coindrop/anything   or   /coindrop/anything.html

exports.serveCoindropPage = onRequest(
  {
    region: "us-central1",
    maxInstances: 30,
  },
  async (req, res) => {
    let slug = null;

    const p = req.path || "";

    // Match /coindrop/slug or /coindrop/slug.html
    let m = p.match(/^\/coindrop\/([a-z0-9-]+)(?:\.html)?$/i);
    if (m) {
      slug = sanitizeSlug(m[1]);
    } else if (req.query && req.query.slug) {
      slug = sanitizeSlug(req.query.slug);
    }

    if (!slug) {
      res.status(404).send("Not found");
      return;
    }

    // Never let the function serve the main landing page
    if (slug === "coindrop") {
      res.status(404).send("Not found");
      return;
    }

    try {
      const page = await getPublishedPage(slug);
      if (!page || !page.html) {
        res.status(404).send("Page not found");
        return;
      }

      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", "public, max-age=300");
      res.status(200).send(page.html);
    } catch (err) {
      console.error("[serveCoindropPage] error", err);
      res.status(500).send("Error loading page");
    }
  }
);

// === 3. Global robots.txt (includes all published coindrop pages) ===

exports.robotsTxt = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
  },
  async (req, res) => {
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");

    let body = [
      "User-agent: *",
      "Allow: /",
      "Allow: /coindrop",
      "Disallow: /assets/private/",
    ];

    try {
      const slugs = await listPublishedSlugs();
      for (const s of slugs) {
        body.push(`Allow: /coindrop/${s}.html`);
      }
    } catch (e) {
      // If Firestore fails we still return a valid robots
    }

    body.push("");
    body.push("Sitemap: https://coinx.gspteck.com/sitemap.xml");
    body.push("Sitemap: https://coinx.gspteck.com/coindrop/sitemap.xml");

    res.status(200).send(body.join("\n"));
  }
);

// === 4. Global sitemap.xml (home + coindrop section) ===

exports.sitemapXml = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
  },
  async (req, res) => {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");

    const entries = [
      { loc: "https://coinx.gspteck.com/", priority: "1.0", changefreq: "weekly" },
    ];

    // Include the full coindrop section (landing + published pages)
    const coindropEntries = await getCoindropSitemapEntries();
    entries.push(...coindropEntries);

    res.status(200).send(buildSitemapXml(entries));
  }
);

// === 5. Dedicated Coindrop sitemap: /coindrop/sitemap.xml ===
// This is a focused sitemap containing ONLY the CoinDrop landing page
// plus all dynamically published /coindrop/*.html pages.

exports.coindropSitemapXml = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
  },
  async (req, res) => {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");

    const entries = await getCoindropSitemapEntries();
    res.status(200).send(buildSitemapXml(entries));
  }
);

// === 6. Dedicated Coindrop robots.txt: /coindrop/robots.txt ===
// Focused robots file for the CoinDrop section. Lists the landing page
// and all published /coindrop/*.html pages, and points to the coindrop sitemap.

exports.coindropRobotsTxt = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
  },
  async (req, res) => {
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");

    let body = [
      "User-agent: *",
      "Allow: /coindrop",
    ];

    try {
      const slugs = await listPublishedSlugs();
      for (const s of slugs) {
        body.push(`Allow: /coindrop/${s}.html`);
      }
    } catch (e) {
      // still return valid robots on error
    }

    body.push("");
    body.push("Sitemap: https://coinx.gspteck.com/coindrop/sitemap.xml");

    res.status(200).send(body.join("\n"));
  }
);
