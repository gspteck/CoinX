"use strict";
/**
 * Agent analytics (Scope Journeys-style), server-side, Firestore-backed.
 *
 * Wraps a Firebase HTTPS handler. On every response it records:
 *   - a daily aggregate doc   agentAnalytics/{site}/daily/{YYYY-MM-DD}   (1 write per hit)
 *   - for non-human hits, while under the daily raw cap:
 *       session pointer      agentAnalytics/{site}/sessions/{agentKey}_{ipHash}
 *       journey doc          agentAnalytics/{site}/journeys/{journeyId}   (steps, expireAt = +30 days)
 * Tiers: verified (UA + published IP range / forward-confirmed rDNS), declared (UA says so),
 *        inferred (automation hints), human.
 * Privacy: IPs are never stored; only a salted SHA-256 hash that rotates daily (Europe/Rome date).
 * Human hits are only counted (no journey, no UA, no hash stored).
 * Writes go through the Admin SDK only; Firestore rules stay deny-all for clients.
 * Never translates anything; never touches page HTML.
 */
const crypto = require("crypto");
const net = require("net");
const dnsP = require("dns").promises;

const VERSION = 1;
const ROOT = "agentAnalytics";
const RAW_CAP_PER_DAY = 500; // journey/session writes per site per day
const MAX_STEPS = 50;
const SESSION_GAP_MS = 30 * 60 * 1000;
const RETENTION_DAYS = 30;
const REPORT_PATH = "/_agent-analytics/report";

// Order matters: most specific first.
const AGENTS = [
  { re: /ChatGPT-User/i, agent: "ChatGPT-User", family: "openai", kind: "user-fetch", ip: "openai-chatgpt-user" },
  { re: /OAI-SearchBot/i, agent: "OAI-SearchBot", family: "openai", kind: "ai-search", ip: "openai-searchbot" },
  { re: /GPTBot/i, agent: "GPTBot", family: "openai", kind: "ai-training", ip: "openai-gptbot" },
  { re: /Claude-User/i, agent: "Claude-User", family: "anthropic", kind: "user-fetch" },
  { re: /Claude-SearchBot/i, agent: "Claude-SearchBot", family: "anthropic", kind: "ai-search" },
  { re: /ClaudeBot/i, agent: "ClaudeBot", family: "anthropic", kind: "ai-training" },
  { re: /anthropic-ai|Claude-Web/i, agent: "anthropic-ai", family: "anthropic", kind: "ai-training" },
  { re: /Perplexity-User/i, agent: "Perplexity-User", family: "perplexity", kind: "user-fetch", ip: "perplexity-user" },
  { re: /PerplexityBot/i, agent: "PerplexityBot", family: "perplexity", kind: "ai-search", ip: "perplexitybot" },
  { re: /Google-CloudVertexBot/i, agent: "Google-CloudVertexBot", family: "google", kind: "ai-agent", ip: "google-common" },
  { re: /Google-InspectionTool/i, agent: "Google-InspectionTool", family: "google", kind: "search", ip: "google-common" },
  { re: /GoogleOther/i, agent: "GoogleOther", family: "google", kind: "ai-training", ip: "google-common" },
  { re: /Google-Agent|Google-NotebookLM|Gemini/i, agent: "Google-UserFetch", family: "google", kind: "user-fetch", ip: "google-user" },
  { re: /Googlebot/i, agent: "Googlebot", family: "google", kind: "search", ip: "google-common" },
  { re: /bingbot|BingPreview/i, agent: "Bingbot", family: "microsoft", kind: "search", ip: "bingbot" },
  { re: /Applebot-Extended/i, agent: "Applebot-Extended", family: "apple", kind: "ai-training", rdns: [".applebot.apple.com"] },
  { re: /Applebot/i, agent: "Applebot", family: "apple", kind: "search", rdns: [".applebot.apple.com"] },
  { re: /meta-externalagent|meta-externalfetcher|FacebookBot/i, agent: "Meta-ExternalAgent", family: "meta", kind: "ai-training" },
  { re: /facebookexternalhit/i, agent: "facebookexternalhit", family: "meta", kind: "preview" },
  { re: /Amazonbot/i, agent: "Amazonbot", family: "amazon", kind: "ai-search", rdns: [".crawl.amazonbot.amazon"] },
  { re: /Bytespider|TikTokSpider/i, agent: "Bytespider", family: "bytedance", kind: "ai-training" },
  { re: /CCBot/i, agent: "CCBot", family: "commoncrawl", kind: "ai-training" },
  { re: /DuckAssistBot/i, agent: "DuckAssistBot", family: "duckduckgo", kind: "ai-search" },
  { re: /DuckDuckBot/i, agent: "DuckDuckBot", family: "duckduckgo", kind: "search" },
  { re: /MistralAI-User/i, agent: "MistralAI-User", family: "mistral", kind: "user-fetch" },
  { re: /cohere-ai|cohere-training-data-crawler/i, agent: "cohere-ai", family: "cohere", kind: "ai-training" },
  { re: /\bxAI\b|GrokBot|Grok-/i, agent: "xAI-Grok", family: "xai", kind: "ai-agent" },
  { re: /YouBot/i, agent: "YouBot", family: "you", kind: "ai-search" },
  { re: /AI2Bot/i, agent: "AI2Bot", family: "ai2", kind: "ai-training" },
  { re: /Diffbot/i, agent: "Diffbot", family: "diffbot", kind: "ai-training" },
  { re: /PetalBot/i, agent: "PetalBot", family: "huawei", kind: "search" },
  { re: /YandexBot|YandexAdditional/i, agent: "YandexBot", family: "yandex", kind: "search", rdns: [".yandex.ru", ".yandex.net", ".yandex.com"] },
  { re: /Baiduspider/i, agent: "Baiduspider", family: "baidu", kind: "search", rdns: [".baidu.com", ".baidu.jp"] },
  { re: /SeznamBot/i, agent: "SeznamBot", family: "seznam", kind: "search" },
  { re: /AhrefsBot|SemrushBot|MJ12bot|DotBot|DataForSeoBot|BLEXBot|Screaming Frog/i, agent: "SEO-Crawler", family: "seo-tools", kind: "seo" },
  { re: /Twitterbot/i, agent: "Twitterbot", family: "x", kind: "preview" },
  { re: /LinkedInBot/i, agent: "LinkedInBot", family: "linkedin", kind: "preview" },
  { re: /Slackbot/i, agent: "Slackbot", family: "slack", kind: "preview" },
  { re: /Discordbot/i, agent: "Discordbot", family: "discord", kind: "preview" },
  { re: /TelegramBot/i, agent: "TelegramBot", family: "telegram", kind: "preview" },
  { re: /WhatsApp/i, agent: "WhatsApp", family: "meta", kind: "preview" },
  { re: /MondaySEODigest|Chrome-Lighthouse|PageSpeed/i, agent: "SEO-Monitor", family: "monitor", kind: "monitor" },
];
const GENERIC_BOT_RE = /\b[\w.-]*(bot|crawler|spider|crawl|slurp|fetcher|scraper|archiver)\b/i;
const TOOL_RE = /(curl|wget|python-requests|python-urllib|aiohttp|httpx|node-fetch|axios|undici|got\b|Go-http-client|okhttp|Java\/|Apache-HttpClient|libwww-perl|Scrapy|HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|Firecrawl|Jina|Bun\/|Deno\/|ruby|PostmanRuntime|Insomnia)/i;
const BROWSER_RE = /(Mozilla\/5\.0).*(Chrome|Firefox|Safari|Edg)\//;
const SPECIAL_PATH_RE = /^\/(llms(-full)?\.txt|ai\.txt|robots\.txt|sitemap[\w-]*\.xml|\.well-known\/[\w.\/-]{1,60}|feed(\.xml)?|rss(\.xml)?|[\w\/-]{1,100}\.md)$/i;

const IP_LISTS = {
  "openai-gptbot": ["https://openai.com/gptbot.json"],
  "openai-searchbot": ["https://openai.com/searchbot.json"],
  "openai-chatgpt-user": ["https://openai.com/chatgpt-user.json"],
  "perplexitybot": ["https://www.perplexity.ai/perplexitybot.json"],
  "perplexity-user": ["https://www.perplexity.ai/perplexity-user.json"],
  "google-common": ["https://developers.google.com/static/crawling/ipranges/common-crawlers.json",
    "https://developers.google.com/static/crawling/ipranges/special-crawlers.json"],
  "google-user": ["https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json",
    "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json"],
  "bingbot": ["https://www.bing.com/toolbox/bingbot.json"],
};
const IP_LIST_TTL_MS = 12 * 3600 * 1000;
const _ipListCache = new Map(); // key -> {at, list: net.BlockList|null, pending}
const _rdnsCache = new Map(); // ip|suffixes -> {at, ok}
const _recentHits = new Map(); // ipHash -> [ts...] (in-memory, per instance; for "rapid sequential")
let _salt = null;
let _saltPromise = null;

function withTimeout(p, ms, fallback) {
  let t;
  return Promise.race([
    p,
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(t));
}

function romeDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Firestore-safe map key: keep [A-Za-z0-9_-], escape everything else as ~XX. Decode: decodeURIComponent(k.replace(/~/g, "%")). */
function fkey(s) {
  return String(s).slice(0, 160).replace(/[^A-Za-z0-9_-]/g, (c) =>
    Buffer.from(c, "utf8").toString("hex").replace(/(..)/g, "~$1").toUpperCase());
}

function clientIp(req) {
  // Firebase Hosting -> Cloud Run: the client IP is the first X-Forwarded-For entry added by Hosting.
  // A client-supplied X-Forwarded-For is prepended, so we take the entry Hosting appended
  // (see AA_XFF_FROM_RIGHT below, verified empirically per deploy).
  const xff = String(req.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromRight = Number(process.env.AA_XFF_FROM_RIGHT || 2); // 1 = last entry
  let ip = xff.length >= fromRight ? xff[xff.length - fromRight] : xff[0];
  if (!ip || !net.isIP(ip)) ip = req.ip || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return net.isIP(ip) ? ip : "";
}

async function getSalt(db) {
  if (_salt) return _salt;
  if (!_saltPromise) {
    _saltPromise = (async () => {
      const ref = db.collection(ROOT).doc("_config");
      const snap = await ref.get();
      if (snap.exists && snap.get("salt")) return snap.get("salt");
      const salt = crypto.randomBytes(24).toString("hex");
      await ref.set({ salt, createdAt: new Date(), version: VERSION }, { merge: true });
      return salt;
    })().then((s) => { _salt = s; return s; }).catch((e) => { _saltPromise = null; throw e; });
  }
  return _saltPromise;
}

/** Salted, daily-rotating hash of the client's network (IPv4 /24, IPv6 /48). Raw IPs are never stored. */
function netPrefix(ip) {
  if (!ip) return "";
  if (net.isIPv4(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  const full = ip.split("::");
  const head = full[0] ? full[0].split(":") : [];
  const tail = full.length > 1 && full[1] ? full[1].split(":") : [];
  const groups = full.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return groups.slice(0, 3).join(":") + "::/48";
}

function hashIp(salt, ip, day) {
  if (!ip) return "noip";
  return crypto.createHash("sha256").update(`${salt}|${day}|${netPrefix(ip)}`).digest("hex").slice(0, 16);
}

async function loadIpList(key) {
  const now = Date.now();
  const c = _ipListCache.get(key);
  if (c && c.list && now - c.at < IP_LIST_TTL_MS) return c.list;
  if (c && c.pending) return c.pending;
  const pending = (async () => {
    const bl = new net.BlockList();
    let n = 0;
    for (const url of IP_LISTS[key] || []) {
      try {
        const r = await withTimeout(fetch(url, { headers: { "User-Agent": "agent-analytics/1" } }), 1500, null);
        if (!r || !r.ok) continue;
        const j = await r.json();
        for (const p of j.prefixes || []) {
          const cidr = p.ipv4Prefix || p.ipv6Prefix;
          if (!cidr) continue;
          const [addr, bits] = cidr.split("/");
          try { bl.addSubnet(addr, Number(bits), p.ipv6Prefix ? "ipv6" : "ipv4"); n++; } catch (e) { /* skip */ }
        }
      } catch (e) { /* ignore list fetch errors */ }
    }
    const list = n > 0 ? bl : null;
    _ipListCache.set(key, { at: Date.now(), list, pending: null });
    return list;
  })();
  _ipListCache.set(key, { at: (c && c.at) || 0, list: (c && c.list) || null, pending });
  return pending;
}

async function rdnsCheck(ip, suffixes) {
  const k = `${ip}|${suffixes.join(",")}`;
  const c = _rdnsCache.get(k);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.ok;
  let ok = false;
  try {
    const names = await withTimeout(dnsP.reverse(ip), 700, []);
    for (const name of names || []) {
      const n = String(name).toLowerCase();
      if (!suffixes.some((s) => n.endsWith(s))) continue;
      const addrs = await withTimeout(dnsP.lookup(n, { all: true }), 700, []);
      if ((addrs || []).some((a) => a.address === ip)) { ok = true; break; }
    }
  } catch (e) { ok = false; }
  if (_rdnsCache.size > 2000) _rdnsCache.clear();
  _rdnsCache.set(k, { at: Date.now(), ok });
  return ok;
}

/** Returns "pass" | "fail" | "n/a" (no published way to verify). */
async function verifyIp(def, ip) {
  if (!ip) return "n/a";
  if (def.ip) {
    const list = await loadIpList(def.ip);
    if (!list) return "n/a";
    return list.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4") ? "pass" : "fail";
  }
  if (def.rdns) return (await rdnsCheck(ip, def.rdns)) ? "pass" : "fail";
  return "n/a";
}

function classifyUa(req, path) {
  const ua = String(req.get("user-agent") || "");
  const signals = [];
  for (const def of AGENTS) {
    if (def.re.test(ua)) return { def, ua, agent: def.agent, family: def.family, kind: def.kind, tier: "declared", signals };
  }
  const accept = String(req.get("accept") || "");
  if (/text\/markdown/i.test(accept)) signals.push("accept-markdown");
  if (!ua) signals.push("no-ua");
  const tool = ua.match(TOOL_RE);
  if (tool) signals.push(`tool:${tool[1].toLowerCase().replace(/[^a-z0-9-]/g, "")}`);
  const gen = !tool && ua.match(GENERIC_BOT_RE);
  if (gen) {
    const name = (gen[0] || "bot").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "bot";
    return { def: null, ua, agent: `other:${name}`, family: "other", kind: "bot", tier: "declared", signals };
  }
  const browserLike = BROWSER_RE.test(ua);
  if (browserLike && !req.get("sec-fetch-mode") && !req.get("accept-language")) signals.push("headless-hints");
  if (SPECIAL_PATH_RE.test(path) && !/sitemap|robots/i.test(path)) signals.push("llms-or-md-fetch");
  if (signals.length) {
    const toolSig = signals.find((s) => s.startsWith("tool:"));
    const agent = toolSig ? `automation:${toolSig.slice(5)}` : (signals[0] === "no-ua" ? "unknown:no-ua" : "unknown:automation");
    return { def: null, ua, agent, family: "unknown", kind: "automation", tier: "inferred", signals };
  }
  return { def: null, ua, agent: "human", family: "human", kind: "human", tier: "human", signals };
}

function rapidSequential(ipHash) {
  const now = Date.now();
  const arr = (_recentHits.get(ipHash) || []).filter((t) => now - t < 10000);
  arr.push(now);
  if (_recentHits.size > 5000) _recentHits.clear();
  _recentHits.set(ipHash, arr.slice(-10));
  return arr.length >= 5; // 5+ page fetches in 10 s from one hashed IP
}

function normPath(p) {
  let s = String(p || "/").split("?")[0];
  try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
  s = s.replace(/\/{2,}/g, "/").slice(0, 120);
  return s || "/";
}

function pathBucket(path, status) {
  if (status < 400 || SPECIAL_PATH_RE.test(path)) return path;
  return status === 404 || status === 410 ? `_${status}_other` : `_${Math.floor(status / 100)}xx_other`;
}

async function cleanupOld(db, site) {
  const base = db.collection(ROOT).doc(site);
  const now = new Date();
  const batch = db.batch();
  let n = 0;
  const j = await base.collection("journeys").where("expireAt", "<", now).limit(200).get();
  j.forEach((d) => { batch.delete(d.ref); n++; });
  const s = await base.collection("sessions").where("lastSeen", "<", new Date(now.getTime() - 86400000)).limit(200).get();
  s.forEach((d) => { batch.delete(d.ref); n++; });
  if (n) await batch.commit();
  return n;
}

async function record(db, admin, ctx, status) {
  const FV = admin.firestore.FieldValue;
  const salt = await getSalt(db);
  const day = romeDate(ctx.at);
  const ipHash = hashIp(salt, ctx.ip, day);
  const c = classifyUa(ctx.req, ctx.path);
  let ipCheck = "n/a";
  if (c.def) {
    ipCheck = await withTimeout(verifyIp(c.def, ctx.ip), 2000, "n/a");
    if (ipCheck === "pass") c.tier = "verified";
  } else if (c.tier === "human" && rapidSequential(ipHash)) {
    c.tier = "inferred"; c.agent = "unknown:rapid-sequential"; c.family = "unknown"; c.kind = "automation"; c.signals.push("rapid-sequential");
  }
  const agentKey = fkey(c.agent);
  const pk = fkey(pathBucket(ctx.path, status));
  const base = db.collection(ROOT).doc(ctx.site);
  const dailyRef = base.collection("daily").doc(day);
  const inc = FV.increment(1);
  const daily = {
    date: day, site: ctx.site, v: VERSION, updatedAt: ctx.at,
    total: inc,
    byTier: { [c.tier]: inc },
    byStatus: { [String(status)]: inc },
  };
  if (ctx.altHost) daily.altHostHits = inc;
  if (c.tier === "human") {
    await dailyRef.set(daily, { merge: true });
    return { tier: c.tier, agent: c.agent };
  }
  daily.byAgent = { [agentKey]: inc };
  daily.byAgentTier = { [agentKey]: { [c.tier]: inc } };
  daily.byPath = { [pk]: inc };
  daily.byAgentPath = { [agentKey]: { [pk]: inc } };
  daily.byFamily = { [fkey(c.family)]: inc };
  if (ipCheck === "fail") daily.ipCheckFailed = { [agentKey]: inc };

  const sessRef = base.collection("sessions").doc(`${agentKey}_${ipHash}`.slice(0, 200));
  // One read round-trip (getAll) + one batched commit; no transaction (cheaper, lower latency).
  // A race between two instances can only over-shoot the raw cap slightly or split a journey.
  const [dSnap, sSnap] = await db.getAll(dailyRef, sessRef);
  const firstOfDay = !dSnap.exists;
  const batch = db.batch();
  const raw = (dSnap.exists && dSnap.get("rawWrites")) || 0;
  if (raw >= RAW_CAP_PER_DAY) {
    daily.rawCapped = inc;
    batch.set(dailyRef, daily, { merge: true });
  } else {
    const nowMs = ctx.at.getTime();
    const last = sSnap.exists ? sSnap.get("lastSeen") : null;
    const lastMs = last && last.toMillis ? last.toMillis() : 0;
    const step = { t: ctx.at, p: ctx.path, s: status, m: ctx.method };
    if (ctx.ref) step.r = ctx.ref;
    let journeyId;
    let isNew = false;
    if (sSnap.exists && nowMs - lastMs <= SESSION_GAP_MS && sSnap.get("journeyId")) {
      journeyId = sSnap.get("journeyId");
    } else {
      journeyId = `${day}_${agentKey}_${ipHash}_${nowMs.toString(36)}`.slice(0, 300);
      isNew = true;
    }
    const jRef = base.collection("journeys").doc(journeyId);
    const steps = sSnap.exists && !isNew ? (sSnap.get("steps") || 0) : 0;
    const expireAt = new Date(nowMs + RETENTION_DAYS * 86400000);
    if (isNew) {
      daily.newJourneys = inc;
      batch.set(jRef, {
        site: ctx.site, day, journeyId, agent: c.agent, family: c.family, kind: c.kind, tier: c.tier,
        ipHash, ipCheck, signals: c.signals, ua: c.ua.slice(0, 200),
        firstSeen: ctx.at, lastSeen: ctx.at, hits: 1, steps: [step], expireAt, v: VERSION,
      });
    } else {
      const upd = { lastSeen: ctx.at, hits: inc, expireAt };
      if (steps < MAX_STEPS) upd.steps = FV.arrayUnion(step);
      if (c.tier === "verified") upd.tier = "verified";
      if (ipCheck === "pass") upd.ipCheck = "pass";
      batch.set(jRef, upd, { merge: true });
    }
    batch.set(sessRef, { journeyId, lastSeen: ctx.at, steps: steps + 1, agent: c.agent });
    daily.rawWrites = inc;
    batch.set(dailyRef, daily, { merge: true });
  }
  await batch.commit();
  if (firstOfDay) await withTimeout(cleanupOld(db, ctx.site).catch(() => 0), 1500, 0);
  return { tier: c.tier, agent: c.agent, ipCheck };
}

function timingSafeEq(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function handleReport(db, req, res, cfg, siteForHost) {
  res.set("Cache-Control", "private, no-store");
  res.set("X-Robots-Tag", "noindex");
  const secret = cfg.getSecret ? String(cfg.getSecret() || "").trim() : "";
  const ts = String(req.get("x-aa-timestamp") || "");
  const sig = String(req.get("x-aa-signature") || "");
  const now = Math.floor(Date.now() / 1000);
  const expected = secret ? crypto.createHmac("sha256", secret).update(`${ts}.${REPORT_PATH}`).digest("hex") : "";
  if (!secret || !/^\d{9,11}$/.test(ts) || Math.abs(now - Number(ts)) > 300 || !timingSafeEq(sig, expected)) {
    res.status(404).send("Not found");
    return;
  }
  if (req.query.echo === "1") {
    res.json({ xff: req.get("x-forwarded-for") || null, reqIp: req.ip || null, chosenIp: clientIp(req) ? "set" : "none",
      xffCount: String(req.get("x-forwarded-for") || "").split(",").filter(Boolean).length });
    return;
  }
  const sites = cfg.sites.map((s) => s.site).flatMap((x) => [x, `_test.${x}`]);
  const site = sites.includes(String(req.query.site || "")) ? String(req.query.site) : (siteForHost || sites[0]);
  const days = Math.max(1, Math.min(35, parseInt(req.query.days || "7", 10) || 7));
  const jl = Math.max(0, Math.min(200, parseInt(req.query.journeys || "50", 10) || 0));
  const base = db.collection(ROOT).doc(site);
  const since = romeDate(new Date(Date.now() - (days - 1) * 86400000));
  const dSnap = await base.collection("daily").where("date", ">=", since).get();
  const daily = dSnap.docs.map((d) => d.data()).sort((a, b) => a.date.localeCompare(b.date));
  let journeys = [];
  if (jl) {
    const jSnap = await base.collection("journeys").orderBy("lastSeen", "desc").limit(jl).get();
    journeys = jSnap.docs.map((d) => {
      const x = d.data();
      return { ...x, firstSeen: x.firstSeen && x.firstSeen.toDate ? x.firstSeen.toDate().toISOString() : x.firstSeen,
        lastSeen: x.lastSeen && x.lastSeen.toDate ? x.lastSeen.toDate().toISOString() : x.lastSeen,
        expireAt: x.expireAt && x.expireAt.toDate ? x.expireAt.toDate().toISOString() : x.expireAt,
        steps: (x.steps || []).map((s) => ({ ...s, t: s.t && s.t.toDate ? s.t.toDate().toISOString() : s.t })) };
    });
  }
  const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v && v.toDate ? v.toDate().toISOString() : v)));
  res.json({ ok: true, v: VERSION, site, sites, days, since, daily: clean(daily), journeys });
}

/**
 * cfg = {
 *   getDb: () => admin.firestore(), admin,
 *   sites: [{ site: "autox.network", hosts: ["autox.network", "www.autox.network", "autox-tg-bot.web.app", ...] }],
 *   getSecret: () => contentengineSecret.value(),   // for the signed report endpoint
 *   timeoutMs: 2500,
 * }
 */
function withAgentAnalytics(handler, cfg) {
  const hostMap = new Map();
  for (const s of cfg.sites) for (const h of s.hosts) hostMap.set(h.toLowerCase(), s.site);
  return async (req, res) => {
    let ctx = null;
    try {
      const hostRaw = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
      const site = hostMap.get(hostRaw) || null;
      const path = normPath(req.path || req.url);
      if (path === REPORT_PATH) {
        return await handleReport(cfg.getDb(), req, res, cfg, site);
      }
      if (site && (req.method === "GET" || req.method === "HEAD")) {
        let ref = String(req.get("referer") || "");
        try { ref = ref ? new URL(ref).hostname.slice(0, 80) : ""; } catch (e) { ref = ""; }
        // Verification traffic (?aa_test=...) is kept apart from real stats under "_test.<site>".
        const testRun = req.query && req.query.aa_test;
        ctx = { req, site: testRun ? `_test.${site}` : site, path, method: req.method, at: new Date(), ip: clientIp(req), ref,
          altHost: !cfg.sites.some((s) => s.site === hostRaw) };
      }
    } catch (e) {
      ctx = null;
    }
    if (!ctx) return handler(req, res);
    const origEnd = res.end;
    let done = false;
    res.end = function (...args) {
      if (done) return origEnd.apply(this, args);
      done = true;
      const self = this;
      const status = self.statusCode || 200;
      withTimeout(record(cfg.getDb(), cfg.admin, ctx, status).catch((e) => {
        console.warn("[agent-analytics] record failed", e && e.message);
      }), cfg.timeoutMs || 2500, null).finally(() => {
        res.end = origEnd;
        origEnd.apply(self, args);
      });
      return this;
    };
    return handler(req, res);
  };
}

module.exports = { withAgentAnalytics, netPrefix, classifyUa, fkey, normPath, pathBucket, romeDate, REPORT_PATH, VERSION, _test: { clientIp, rapidSequential } };
