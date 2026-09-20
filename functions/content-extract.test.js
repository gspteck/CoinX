/**
 * Unit tests for the ContentEngine webhook translation -> monolingual post
 * extraction logic. This is the exact code path that was broken: when contentengine
 * sends the body under `post.translations`, the published page previously rendered
 * only `<h1>Published Page</h1>` because the flat title/body_html were absent.
 *
 * Run with `yarn test` (wire-up in package.json) or `node --test`.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const {
  extractMonolingualPost,
  pickTranslation,
  buildLanguageSelector,
  injectLanguageSelector,
} = require("./content-extract");

// A faithful reconstruction of what publish_daily.py actually sends:
//   {post: {translations: {lang: {title, body_html, meta_description}}, slug}}
const enTranslation = {
  title: "Telegram Bot — Insights & Best Practices",
  body_html:
    "<h2>Why this matters</h2><p>Here is a grounded starting point.</p>",
  meta_description: "Practical, honest guidance on Telegram Bot.",
};
const esTranslation = {
  title: "Bot de Telegram — Información y mejores prácticas",
  body_html: "<h2>Por qué importa</h2><p>Punto de partida.</p>",
  meta_description: "Guía práctica sobre el Bot de Telegram.",
};

test("extracts English content from translations when flat fields are absent", () => {
  const post = {
    slug: "telegram-bot-insights",
    translations: { en: enTranslation, es: esTranslation },
  };
  const mono = extractMonolingualPost(post);

  assert.strictEqual(mono.title, enTranslation.title);
  assert.strictEqual(mono.body_html, enTranslation.body_html);
  assert.strictEqual(mono.meta_description, enTranslation.meta_description);
  assert.strictEqual(mono.language, "en");
});

test("prefers English ('en') over other available languages", () => {
  const post = {
    slug: "telegram-bot-insights",
    translations: { es: esTranslation, en: enTranslation },
  };
  const mono = extractMonolingualPost(post);

  assert.strictEqual(mono.language, "en");
  assert.strictEqual(mono.title, enTranslation.title);
  assert.strictEqual(mono.body_html, enTranslation.body_html);
});

test("falls back to the first available language when English is missing", () => {
  const post = {
    slug: "slug-x",
    translations: { es: esTranslation },
  };
  const mono = extractMonolingualPost(post);

  assert.strictEqual(mono.language, "es");
  assert.strictEqual(mono.title, esTranslation.title);
  assert.strictEqual(mono.body_html, esTranslation.body_html);
});

test("falls back to any language and does not crash with multiple langs", () => {
  const post = {
    slug: "slug-y",
    translations: { fr: { title: "Fr", body_html: "<p>fr</p>", meta_description: "fr" }, de: { title: "De", body_html: "<p>de</p>", meta_description: "de" } },
  };
  const mono = extractMonolingualPost(post);
  // en absent -> picks fr (first key in insertion order after the ...spread)
  assert.strictEqual(mono.language, "fr");
  assert.strictEqual(mono.title, "Fr");
  assert.strictEqual(mono.body_html, "<p>fr</p>");
});

test("preserves flat fields when present (they take priority)", () => {
  const post = {
    slug: "flat-slug",
    title: "Flat Title",
    body_html: "<p>flat body</p>",
    meta_description: "flat desc",
    language: "en",
    translations: { en: enTranslation },
  };
  const mono = extractMonolingualPost(post);

  assert.strictEqual(mono.title, "Flat Title");
  assert.strictEqual(mono.body_html, "<p>flat body</p>");
  assert.strictEqual(mono.meta_description, "flat desc");
  assert.strictEqual(mono.language, "en");
});

test("uses 'Published Page' as title and empty body when nothing is provided", () => {
  const mono = extractMonolingualPost({});
  assert.strictEqual(mono.title, "Published Page");
  assert.strictEqual(mono.body_html, "");
  assert.strictEqual(mono.meta_description, "");
  assert.strictEqual(mono.language, "en");
  assert.strictEqual(mono.json_ld, null);
});

test("carries through json_ld from the chosen translation", () => {
  const post = {
    slug: "ld-slug",
    translations: { en: { ...enTranslation, json_ld: { "@type": "Article" } } },
  };
  const mono = extractMonolingualPost(post);
  assert.deepStrictEqual(mono.json_ld, { "@type": "Article" });
});

test("does not throw when translations is a non-object", () => {
  assert.doesNotThrow(() => extractMonolingualPost({ translations: "oops" }));
  const mono = extractMonolingualPost({ translations: "oops" });
  assert.strictEqual(mono.body_html, "");
});

// --- per-language picking + selector ---
const multiTranslations = {
  en: { title: "English", body_html: "<p>en</p>", meta_description: "" },
  es: { title: "Español", body_html: "<p>es</p>", meta_description: "" },
  fr: { title: "Français", body_html: "<p>fr</p>", meta_description: "" },
};

test("pickTranslation prefers the requested language", () => {
  assert.strictEqual(pickTranslation({ translations: multiTranslations }, "es").title, "Español");
  assert.strictEqual(pickTranslation({ translations: multiTranslations }, "fr").title, "Français");
});

test("pickTranslation falls back to en for unknown/missing language", () => {
  assert.strictEqual(pickTranslation({ translations: multiTranslations }, "de").title, "English");
  assert.strictEqual(pickTranslation({ translations: multiTranslations }, "").title, "English");
});

test("pickTranslation returns null when no translations", () => {
  assert.strictEqual(pickTranslation({}, "en"), null);
  assert.strictEqual(pickTranslation({ translations: {} }, "en"), null);
});

test("buildLanguageSelector emits an option per language and marks current", () => {
  const sel = buildLanguageSelector(multiTranslations, "es");
  assert.ok(sel.includes('value="en"'));
  assert.ok(sel.includes('value="es"'));
  assert.ok(sel.includes('value="fr"'));
  assert.ok(sel.includes('value="es" selected'));
  // must navigate to ?lang= on change
  assert.ok(sel.includes("?lang="));
});

test("buildLanguageSelector returns empty for <2 languages", () => {
  assert.strictEqual(buildLanguageSelector({ en: {} }, "en"), "");
  assert.strictEqual(buildLanguageSelector({}, "en"), "");
});

test("injectLanguageSelector splices into <body>", () => {
  const page = "<!DOCTYPE html><html><head></head><body><article><h1>X</h1></article></body></html>";
  const out = injectLanguageSelector(page, multiTranslations, "en");
  assert.ok(out.startsWith("<!DOCTYPE html>"));
  assert.ok(out.includes('id="language-select"'));
  assert.ok(out.includes("<body>") && out.indexOf("language-select") > out.indexOf("<body>"));
});

test("injectLanguageSelector is a no-op for <2 languages", () => {
  const page = "<html><body>hi</body></html>";
  assert.strictEqual(injectLanguageSelector(page, { en: {} }, "en"), page);
});