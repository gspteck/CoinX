/*
 * Serve-time SEO helpers shared by the content-engine sites (kept identical across repos).
 *  - Probe guard: cheap cacheable 404 for scanner paths (wp-admin, .env, .git, ...) before
 *    any Firestore read or analytics logging.
 *  - enhancePostHtml: robots meta (index, follow, max-image-preview:large), BlogPosting
 *    JSON-LD from the stored post + Firestore dates, and a rel="author" byline link.
 *  - romeToday / xmlEscape utilities.
 */

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

  if (/"@type"\s*:\s*"(?:BlogPosting|Article|NewsArticle)"/.test(out)) return out;

  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(out);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(out);
  const headline = (h1 && textOf(h1[1])) || (title && textOf(title[1])) || "";
  const descM = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(out);
  const descC = descM && /\bcontent\s*=\s*"([^"]*)"/i.exec(descM[0]);
  const description = descC ? decodeEntities(descC[1]).trim() : "";
  // Lead image: first https <img> in the article body.
  const bodyStart = out.search(/<body\b/i);
  const imgM = /<img\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+)["']/i.exec(bodyStart >= 0 ? out.slice(bodyStart) : out);
  const datePublished = tsToIso(opts.publishedAt);
  const dateModified = tsToIso(opts.updatedAt) || datePublished;
  if (!headline || !datePublished || !opts.canonical) return out;

  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline,
    ...(description ? { description } : {}),
    ...(imgM ? { image: [imgM[1]] } : {}),
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
};
