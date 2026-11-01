/*
 * Crawlable HTML sitemap at /sitemap (plain <a href> links, no JS) plus the "Sitemap" footer link.
 * Built at request time from the same entries as /sitemap.xml (getPublishedSitemapEntries), so a
 * publish/update/delete shows up here on the next request. Titles come from the article index
 * (stored H1). Only URLs that are in sitemap.xml are listed (indexable, 200, self-canonical);
 * noindex tools, 404/410 slugs and redirects are never in that list.
 * The footer link is added at serve time so template files (and their sitemap lastmod) stay unchanged.
 */
const HTML_SITEMAP_PATH = "/sitemap";

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "/sitemap" | "/sitemap/" | "/sitemap.html" -> true */
function isHtmlSitemapPath(p) {
  return /^\/sitemap(\/|\.html)?$/i.test(p || "");
}

function dayFromMs(ms) {
  return ms ? new Date(ms).toISOString().split("T")[0] : "";
}

/**
 * Group sitemap.xml entries into hubs.
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {Array<{loc:string}>} o.entries   sitemap.xml entries (same list the XML is built from)
 * @param {Array<{url:string,title:string,ms?:number}>} o.index  article index (newest first)
 * @param {Object<string,string>} o.labels  path -> anchor text for non-post pages
 * @param {string} [o.blogPath]
 */
function groupSitemap(o) {
  const base = o.baseUrl.replace(/\/+$/, "");
  const blogPath = o.blogPath || "/blog";
  const byUrl = new Map((o.index || []).map((a, i) => [a.url, { ...a, i }]));
  const main = [];
  const key = [];
  const posts = [];
  for (const e of o.entries || []) {
    const loc = e.loc;
    if (!loc || !loc.startsWith(base)) continue;
    const p = loc.slice(base.length) || "/";
    if (isHtmlSitemapPath(p)) continue; // the page itself
    if (p === "/" || p === blogPath) {
      main.push({ url: loc, label: (o.labels && o.labels[p]) || (p === "/" ? `${o.siteName} home` : `All ${o.siteName} articles`), order: p === "/" ? 0 : 1 });
      continue;
    }
    const art = byUrl.get(loc);
    if (art) {
      posts.push({ url: loc, label: art.title, date: dayFromMs(art.ms), i: art.i });
      continue;
    }
    if (o.labels && o.labels[p]) {
      key.push({ url: loc, label: o.labels[p] });
    }
    // Not a known page and not a post with stored HTML: skip rather than print a made-up label.
  }
  main.sort((a, b) => a.order - b.order);
  posts.sort((a, b) => a.i - b.i);
  return { main, key, posts, total: main.length + key.length + posts.length };
}

function listHtml(items, withDate) {
  return items
    .map((it) => `      <li><a href="${esc(it.url)}">${esc(it.label)}</a>${withDate && it.date ? ` <time datetime="${it.date}">${it.date}</time>` : ""}</li>`)
    .join("\n");
}

/** The <main> markup (H1, intro, grouped lists). */
function buildSitemapMain(o, g) {
  const host = o.baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const sections = [];
  if (g.main.length) sections.push(`    <section aria-labelledby="sm-main">\n    <h2 id="sm-main">Main pages</h2>\n    <ul>\n${listHtml(g.main)}\n    </ul>\n    </section>`);
  if (g.key.length) sections.push(`    <section aria-labelledby="sm-key">\n    <h2 id="sm-key">About and key pages</h2>\n    <ul>\n${listHtml(g.key)}\n    </ul>\n    </section>`);
  if (g.posts.length) sections.push(`    <section aria-labelledby="sm-posts">\n    <h2 id="sm-posts">Blog posts (${g.posts.length}, newest first)</h2>\n    <ul>\n${listHtml(g.posts, true)}\n    </ul>\n    </section>`);
  return `    <h1>${esc(o.siteName)} sitemap</h1>
    <p class="intro">Every indexable page on ${esc(host)}: ${g.total} links, grouped into main pages, about and key pages, and blog posts. Search engines can also read the <a href="${esc(o.baseUrl)}/sitemap.xml">XML sitemap</a>.</p>
${sections.join("\n")}`;
}

function sitemapMeta(o, g) {
  const host = o.baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    title: `Sitemap: all ${o.siteName} pages and articles`,
    description: `All ${g.total} pages on ${host} in one list: the homepage, key pages and ${g.posts.length} blog posts, with a plain link to each.`,
    canonical: `${o.baseUrl.replace(/\/+$/, "")}${HTML_SITEMAP_PATH}`,
  };
}

/** Self-contained page (inline CSS, no JS). */
function renderHtmlSitemap(o) {
  const g = groupSitemap(o);
  const m = sitemapMeta(o, g);
  const base = o.baseUrl.replace(/\/+$/, "");
  const blogPath = o.blogPath || "/blog";
  if (typeof o.shell === "function") {
    return { html: o.shell({ title: m.title, description: m.description, canonical: m.canonical, robots: "index,follow", main: `<main class="html-sitemap">\n${buildSitemapMain(o, g)}\n</main>` }), groups: g, canonical: m.canonical };
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(m.title)}</title>
  <meta name="description" content="${esc(m.description)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${esc(m.canonical)}">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 780px; margin: 40px auto; padding: 0 16px; }
    ul { padding-left: 1.25rem; }
    li { margin: 0.4rem 0; }
    h2 { margin-top: 2rem; font-size: 1.2rem; }
    time { color: #6b7280; font-size: 0.9em; margin-left: 0.25rem; }
    .intro { font-size: 1.05em; }
  </style>
</head>
<body>
  <nav><a href="${esc(base)}/">${esc(o.siteName)} home</a> &middot; <a href="${esc(base + blogPath)}">All articles</a></nav>
  <main>
${buildSitemapMain(o, g)}
  </main>
  <footer><p><a href="${esc(base)}/">${esc(o.siteName)} home</a> &middot; <a href="${esc(base + blogPath)}">All articles</a> &middot; <a href="${esc(base + HTML_SITEMAP_PATH)}">Sitemap</a></p></footer>
</body>
</html>`;
  return { html, groups: g, canonical: m.canonical };
}

/**
 * Add the "Sitemap" footer link at serve time.
 * - If the page already has an XML "Sitemap" footer link, point it at the HTML sitemap.
 * - Else insert `insert` right after the first `anchor` found after `marker` (e.g. the footer's Blog link).
 * - Else, when `fallback` is given, put it before </body>.
 * Idempotent: does nothing when /sitemap is already linked.
 */
function addSitemapFooterLink(html, o) {
  if (!html || typeof html !== "string") return html;
  const base = o.baseUrl.replace(/\/+$/, "");
  const href = `${base}${HTML_SITEMAP_PATH}`;
  if (html.includes(`href="${href}"`) || /href="\/sitemap"/.test(html)) return html;
  const xmlRe = /href="(?:https?:\/\/[^"/]+)?\/sitemap\.xml">Sitemap<\/a>/;
  const footerStart = o.marker ? html.lastIndexOf(o.marker) : -1;
  if (footerStart !== -1) {
    const tail = html.slice(footerStart);
    if (xmlRe.test(tail)) return html.slice(0, footerStart) + tail.replace(xmlRe, `href="${href}">Sitemap</a>`);
    if (o.anchor) {
      const i = tail.indexOf(o.anchor);
      if (i !== -1) {
        const at = footerStart + i + o.anchor.length;
        return html.slice(0, at) + o.insert(href) + html.slice(at);
      }
    }
  }
  if (!o.marker && xmlRe.test(html)) return html.replace(xmlRe, `href="${href}">Sitemap</a>`);
  if (o.fallback) {
    const idx = html.toLowerCase().lastIndexOf("</body>");
    const block = o.fallback(href);
    if (idx === -1) return html + block;
    return `${html.slice(0, idx)}${block}\n${html.slice(idx)}`;
  }
  return html;
}

module.exports = { HTML_SITEMAP_PATH, isHtmlSitemapPath, groupSitemap, renderHtmlSitemap, addSitemapFooterLink };
