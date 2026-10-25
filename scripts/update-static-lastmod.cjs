#!/usr/bin/env node
/*
 * Writes functions/static-lastmod.json: the real last-content-change date (YYYY-MM-DD) of every
 * non-post page in the sitemap (homepage, /blog, static pages), taken from the git history of
 * the files that hold that page's own content. Runs as a firebase.json functions predeploy hook,
 * so the deployed sitemap never uses build or request time. Posts keep their Firestore updatedAt.
 *
 * Each source is a path ("functions/templates/home.html") or a git -L range
 * ({ "L": ":buildBlogArchiveHtml:functions/index.js" }). A page's date is the newest of its sources.
 * If git is unavailable the existing JSON is left as it is (deploy is not blocked).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "functions", "static-lastmod.json");
const SOURCES = {
  "coinx/home": [
    "functions/templates/coinx-home.html"
  ],
  "coinx/market-basics": ["functions/templates/coinx-market-basics.html"],
  "coindrop/home": [
    "functions/templates/coindrop-home.html"
  ],
  "swappr/home": [
    "functions/templates/swappr-home.html"
  ],
  "coinx/blog": [
    {
      "L": ":buildBlogArchiveHtml:functions/index.js"
    },
    {
      "L": "/^const SITES = {/,/^};/:functions/index.js"
    }
  ],
  "coindrop/blog": [
    {
      "L": ":buildBlogArchiveHtml:functions/index.js"
    },
    {
      "L": "/^const SITES = {/,/^};/:functions/index.js"
    }
  ],
  "swappr/blog": [
    {
      "L": ":buildBlogArchiveHtml:functions/index.js"
    },
    {
      "L": "/^const SITES = {/,/^};/:functions/index.js"
    }
  ]
};

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function lastDate(src) {
  const args = typeof src === "string"
    ? ["log", "-1", "--format=%cs", "--", src]
    : ["log", "-1", "--format=%cs", "-s", "-L", src.L];
  const out = git(args).split("\n")[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) throw new Error(`no git date for ${JSON.stringify(src)}`);
  return out;
}

let prev = {};
try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) { /* first run */ }
const pages = {};
try {
  for (const [key, srcs] of Object.entries(SOURCES)) {
    pages[key] = srcs.map(lastDate).sort().pop();
  }
} catch (e) {
  console.warn(`[static-lastmod] ${e.message}; keeping ${path.relative(ROOT, OUT)} as it is`);
  process.exit(0);
}
const next = { generatedBy: "scripts/update-static-lastmod.cjs", sources: SOURCES, pages };
const changed = JSON.stringify(prev.pages || {}) !== JSON.stringify(pages);
fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + "\n");
console.log(`[static-lastmod] ${changed ? "updated (commit functions/static-lastmod.json)" : "unchanged"}: ${JSON.stringify(pages)}`);
