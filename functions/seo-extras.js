/*
 * Serve-time SEO helpers shared by the content-engine sites (kept identical across repos).
 *  - Probe guard: cheap cacheable 404 for scanner paths (wp-admin, .env, .git, ...) before
 *    any Firestore read or analytics logging.
 *  - enhancePostHtml: robots meta (index, follow, max-image-preview:large), BlogPosting
 *    JSON-LD from the stored post + Firestore dates, and a rel="author" byline link.
 *  - optimizePostImages (rule 48/49 image template, serve time, no Firestore write so no
 *    lastmod bump): width/height on every in-post <img>, the lead image eager with
 *    fetchpriority="high", the rest loading="lazy", decoding="async", and a WebP <source>
 *    in a <picture> where image-variants.json has a WebP copy (original PNG/JPEG kept as fallback).
 *  - og:image / twitter:image from the lead image when a post has none; og:url = canonical.
 *  - romeToday / xmlEscape utilities.
 */

// image-variants.json: { "<original https src>": { w, h, webp? } } measured from the real files
// (scripts/build_image_variants.py). Missing file = tag attributes only.
let IMAGE_VARIANTS = {};
try {
  // eslint-disable-next-line global-require
  IMAGE_VARIANTS = require("./image-variants.json");
} catch (_e) {
  IMAGE_VARIANTS = {};
}

const NOT_FOUND_CACHE = "public, max-age=300, s-maxage=300";

// Scanner/probe paths. Real post slugs are [a-z0-9-] only, so none of these can collide.
const PROBE_RE = new RegExp(
  [
    "(?:^|/)(?:wp-admin|wp-login|wp-content|wp-includes|wp-json|wordpress|xmlrpc|phpmyadmin|pma|myadmin|adminer|cgi-bin|vendor/phpunit|server-status|actuator|boaform|hnap1|autodiscover|owa|ecp|telescope|_ignition|solr|druid)(?:[/.]|$)",
    "(?:^|/)\\.(?:env|git|svn|hg|bzr|ds_store|aws|ssh|htaccess|htpasswd|vscode|idea|npmrc|dockerenv)(?:[/.]|$)",
    "\\.(?:php\\d?|phtml|asp|aspx|ashx|jsp|jspa|cgi|pl|env|bak|old|orig|swp|sql|sqlite|db|ini|log|cfg|conf|yml|yaml|tar|gz|tgz|zip|rar|7z)$",
  ].join("|"),
  "i"
);

function isProbePath(p) {
  return PROBE_RE.test(String(p || ""));
}

function sendCachedNotFound(res, body = "Not found") {
  res.set("Cache-Control", NOT_FOUND_CACHE);
  res.set("X-Robots-Tag", "noindex");
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.status(404).send(body);
}

/** Wrap an (analytics-wrapped) handler: probe paths get a cheap 404 and never reach it. */
function withProbeGuard(handler) {
  return (req, res) => {
    if (isProbePath(req.path || req.url || "")) {
      sendCachedNotFound(res);
      return undefined;
    }
    return handler(req, res);
  };
}

/** Today's date (YYYY-MM-DD) in Europe/Rome. */
function romeToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function xmlEscape(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function textOf(fragment) {
  return decodeEntities(String(fragment || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tsToIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return null;
}

/** Escape a JSON string for safe embedding inside <script>. */
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function escapeAttr(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Read an attribute value from a single tag (quoted or bare). */
function getAttr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!m) return null;
  return m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
}

/** Set (replace or append) an attribute on a single tag. value is inserted already escaped. */
function setAttr(tag, name, value) {
  const re = new RegExp(`(\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  if (re.test(tag)) return tag.replace(re, (_m, sp) => `${sp}${name}="${value}"`);
  return tag.replace(/\s*(\/?)>$/, (_m, slash) => ` ${name}="${value}"${slash ? " /" : ""}>`);
}

function posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Image template for a stored post (body only; header logos with relative src are untouched).
 * Returns { html, lead } where lead = { url, width, height, alt } of the first https <img>.
 */
function optimizePostImages(html, variants = IMAGE_VARIANTS) {
  if (!html || typeof html !== "string") return { html, lead: null };
  const bodyStart = html.search(/<body\b/i);
  const start = bodyStart >= 0 ? bodyStart : 0;
  const before = html.slice(0, start);
  let body = html.slice(start);
  let lead = null;
  let count = 0;
  const table = variants || {};
  body = body.replace(/<picture\b[\s\S]*?<\/picture>|<img\b[^>]*>/gi, (chunk) => {
    const inPicture = /^<picture/i.test(chunk);
    const imgM = inPicture ? /<img\b[^>]*>/i.exec(chunk) : [chunk];
    if (!imgM) return chunk;
    const tag = imgM[0];
    const src = decodeEntities(getAttr(tag, "src") || "").trim();
    if (!/^https:\/\//i.test(src)) return chunk;
    const v = table[src] || {};
    const isLead = count === 0;
    count += 1;
    let t = tag;
    // Real file size wins (tag values only when the file was not measured).
    const fw = posInt(v.w);
    const fh = posInt(v.h);
    if (fw && fh) {
      t = setAttr(t, "width", String(fw));
      t = setAttr(t, "height", String(fh));
    }
    if (isLead) {
      t = setAttr(t, "loading", "eager");
      if (!getAttr(t, "fetchpriority")) t = setAttr(t, "fetchpriority", "high");
    } else if (!getAttr(t, "loading")) {
      t = setAttr(t, "loading", "lazy");
    }
    if (!getAttr(t, "decoding")) t = setAttr(t, "decoding", "async");
    if (isLead) {
      lead = {
        url: src,
        width: posInt(getAttr(t, "width")),
        height: posInt(getAttr(t, "height")),
        alt: decodeEntities(getAttr(t, "alt") || "").replace(/\s+/g, " ").trim(),
      };
    }
    if (inPicture) return chunk.replace(tag, t);
    if (v.webp && /^https:\/\//i.test(v.webp) && !/\.(?:webp|avif)(?:[?#]|$)/i.test(src)) {
      return `<picture><source type="image/webp" srcset="${escapeAttr(v.webp)}">${t}</picture>`;
    }
    return t;
  });
  return { html: before + body, lead };
}

function metaTagRe(attrName, key) {
  return new RegExp(`<meta\\b[^>]*\\b${attrName}\\s*=\\s*["']${key.replace(/:/g, "\\:")}["'][^>]*>`, "i");
}

/** og:image/twitter:image from the lead image when missing; og:url matches the canonical. */
function ensureSocialImageTags(html, lead, opts = {}) {
  let out = html;
  const tags = [];
  if (opts.canonical) {
    const ogUrl = metaTagRe("property", "og:url").exec(out);
    if (ogUrl) {
      const cur = getAttr(ogUrl[0], "content");
      if (cur !== opts.canonical) out = out.replace(ogUrl[0], `<meta property="og:url" content="${escapeAttr(opts.canonical)}">`);
    }
  }
  if (!lead || !lead.url) return out;
  const existingOg = metaTagRe("property", "og:image").exec(out);
  if (existingOg) {
    // A site-wide generic share image (opts.genericOgImage, e.g. PilotaSEO's /assets/og-image.png) is swapped
    // for the post's own lead image; any other og:image set by the post itself is kept.
    if (!opts.genericOgImage || getAttr(existingOg[0], "content") !== opts.genericOgImage) return out;
    const swap = (re, repl) => { out = re.test(out) ? out.replace(re, repl) : out; };
    swap(metaTagRe("property", "og:image"), `<meta property="og:image" content="${escapeAttr(lead.url)}">`);
    if (lead.width && lead.height) {
      const w = `<meta property="og:image:width" content="${lead.width}">`;
      const h = `<meta property="og:image:height" content="${lead.height}">`;
      if (metaTagRe("property", "og:image:width").test(out)) swap(metaTagRe("property", "og:image:width"), w);
      else out = out.replace(/(<meta property="og:image" [^>]*>)/i, `$1\n  ${w}`);
      if (metaTagRe("property", "og:image:height").test(out)) swap(metaTagRe("property", "og:image:height"), h);
      else out = out.replace(/(<meta property="og:image:width" [^>]*>)/i, `$1\n  ${h}`);
    }
    const extra = [];
    if (lead.alt && !metaTagRe("property", "og:image:alt").test(out)) extra.push(`<meta property="og:image:alt" content="${escapeAttr(lead.alt)}">`);
    if (metaTagRe("name", "twitter:image").test(out)) swap(metaTagRe("name", "twitter:image"), `<meta name="twitter:image" content="${escapeAttr(lead.url)}">`);
    else extra.push(`<meta name="twitter:image" content="${escapeAttr(lead.url)}">`);
    if (lead.alt && !metaTagRe("name", "twitter:image:alt").test(out)) extra.push(`<meta name="twitter:image:alt" content="${escapeAttr(lead.alt)}">`);
    if (extra.length) out = out.replace(/<\/head>/i, `  ${extra.join("\n  ")}\n</head>`);
    return out;
  }
  if (!metaTagRe("property", "og:type").test(out)) tags.push(`<meta property="og:type" content="article">`);
  if (!metaTagRe("property", "og:title").test(out) && opts.headline) tags.push(`<meta property="og:title" content="${escapeAttr(opts.headline)}">`);
  if (!metaTagRe("property", "og:description").test(out) && opts.description) tags.push(`<meta property="og:description" content="${escapeAttr(opts.description)}">`);
  if (!metaTagRe("property", "og:url").test(out) && opts.canonical) tags.push(`<meta property="og:url" content="${escapeAttr(opts.canonical)}">`);
  tags.push(`<meta property="og:image" content="${escapeAttr(lead.url)}">`);
  if (lead.width && lead.height) {
    tags.push(`<meta property="og:image:width" content="${lead.width}">`);
    tags.push(`<meta property="og:image:height" content="${lead.height}">`);
  }
  if (lead.alt) tags.push(`<meta property="og:image:alt" content="${escapeAttr(lead.alt)}">`);
  if (!metaTagRe("name", "twitter:card").test(out)) tags.push(`<meta name="twitter:card" content="summary_large_image">`);
  if (!metaTagRe("name", "twitter:image").test(out)) tags.push(`<meta name="twitter:image" content="${escapeAttr(lead.url)}">`);
  if (lead.alt && !metaTagRe("name", "twitter:image:alt").test(out)) tags.push(`<meta name="twitter:image:alt" content="${escapeAttr(lead.alt)}">`);
  return out.replace(/<\/head>/i, `  ${tags.join("\n  ")}\n</head>`);
}

function leadImageObject(lead) {
  if (!lead || !lead.url) return null;
  return {
    "@type": "ImageObject",
    url: lead.url,
    contentUrl: lead.url,
    ...(lead.width ? { width: lead.width } : {}),
    ...(lead.height ? { height: lead.height } : {}),
    ...(lead.alt ? { caption: lead.alt } : {}),
  };
}

/** Upgrade a bare image URL in a stored BlogPosting/Article JSON-LD to the lead ImageObject. */
function upgradeStoredLdImage(html, lead) {
  const obj = leadImageObject(lead);
  if (!obj) return html;
  return html.replace(/(<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, json, close) => {
    if (!/"@type"\s*:\s*"(?:BlogPosting|Article|NewsArticle)"/.test(json)) return m;
    let data;
    try {
      data = JSON.parse(json);
    } catch (_e) {
      return m;
    }
    let changed = false;
    const fix = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(fix); return; }
      if (/^(?:BlogPosting|Article|NewsArticle)$/.test(String(node["@type"] || ""))) {
        const img = node.image;
        const first = Array.isArray(img) ? img[0] : img;
        if (first == null || typeof first === "string") {
          node.image = obj;
          changed = true;
        }
      }
      if (Array.isArray(node["@graph"])) node["@graph"].forEach(fix);
    };
    fix(data);
    return changed ? `${open}${jsonForScript(data)}${close}` : m;
  });
}

const ROBOTS_POST = "index, follow, max-image-preview:large";

function ensureRobotsMeta(html) {
  const re = /<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*>/i;
  const m = re.exec(html);
  if (m) {
    if (/noindex/i.test(m[0]) || /max-image-preview/i.test(m[0])) return html;
    const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(m[0]);
    const content = c && c[1].trim() ? `${c[1].trim()}, max-image-preview:large` : ROBOTS_POST;
    return html.replace(m[0], `<meta name="robots" content="${content}">`);
  }
  return html.replace(/<\/head>/i, `  <meta name="robots" content="${ROBOTS_POST}">\n</head>`);
}

/**
 * Add BlogPosting JSON-LD, robots meta and a byline author link to a stored post.
 * opts: { canonical, publishedAt, updatedAt, author: { type, url } | (bylineName) => { type, url }, publisher }
 * The author name is the visible byline text; posts without a byline get no author (nothing is invented).
 */
function enhancePostHtml(html, opts = {}) {
  if (!html || typeof html !== "string") return html;
  let out = ensureRobotsMeta(html);

  // Byline: <p class="byline"><strong>By NAME</strong> ...
  const by = /(<p class="byline"><strong>By )([^<]+?)(<\/strong>)/i.exec(out);
  const bylineName = by ? decodeEntities(by[2]).trim() : null;
  // opts.author may be a function of the byline name (e.g. Person for one named author).
  const authorOpt = typeof opts.author === "function" ? opts.author(bylineName) : opts.author;
  const author = Object.assign({}, authorOpt || {});
  // Author name always comes from the visible byline; posts without one get no author node.
  author.name = bylineName || null;
  if (!bylineName) delete author.url;
  if (by && author.url && !/<a\b/i.test(by[2])) {
    out = out.replace(by[0], `${by[1]}<a href="${author.url}" rel="author">${by[2]}</a>${by[3]}`);
  }

  // Image template (lead eager + WebP <picture> + dimensions), then social tags from the lead.
  const imgs = optimizePostImages(out, opts.imageVariants || IMAGE_VARIANTS);
  out = imgs.html;
  const lead = imgs.lead;

  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(out);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(out);
  const headline = (h1 && textOf(h1[1])) || (title && textOf(title[1])) || "";
  const descM = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(out);
  const descC = descM && /\bcontent\s*=\s*"([^"]*)"/i.exec(descM[0]);
  const description = descC ? decodeEntities(descC[1]).trim() : "";
  out = ensureSocialImageTags(out, lead, { canonical: opts.canonical, headline, description, genericOgImage: opts.genericOgImage });

  if (/"@type"\s*:\s*"(?:BlogPosting|Article|NewsArticle)"/.test(out)) return upgradeStoredLdImage(out, lead);

  const imageObj = leadImageObject(lead);
  const datePublished = tsToIso(opts.publishedAt);
  const dateModified = tsToIso(opts.updatedAt) || datePublished;
  if (!headline || !datePublished || !opts.canonical) return out;

  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline,
    ...(description ? { description } : {}),
    ...(imageObj ? { image: imageObj } : {}),
    datePublished,
    dateModified: dateModified < datePublished ? datePublished : dateModified,
    ...(author.name ? {
      author: {
        "@type": author.type === "Person" ? "Person" : "Organization",
        name: author.name,
        ...(author.url ? { url: author.url } : {}),
      },
    } : {}),
    publisher: {
      "@type": "Organization",
      name: (opts.publisher && opts.publisher.name) || "GSPTeck",
      url: (opts.publisher && opts.publisher.url) || "https://gspteck.com/",
      ...(opts.publisher && opts.publisher.logo
        ? { logo: { "@type": "ImageObject", url: opts.publisher.logo } }
        : {}),
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": opts.canonical },
  };
  return out.replace(
    /<\/head>/i,
    `  <script type="application/ld+json">${jsonForScript(ld)}</script>\n</head>`
  );
}

const GSPTECK_PUBLISHER = {
  name: "GSPTeck",
  url: "https://gspteck.com/",
  logo: "https://gspteck.com/assets/gspteck-high-resolution-logo.png",
};

module.exports = {
  NOT_FOUND_CACHE,
  GSPTECK_PUBLISHER,
  isProbePath,
  sendCachedNotFound,
  withProbeGuard,
  romeToday,
  xmlEscape,
  enhancePostHtml,
  ensureRobotsMeta,
  optimizePostImages,
  ensureSocialImageTags,
  upgradeStoredLdImage,
};
