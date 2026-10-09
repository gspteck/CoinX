/**
 * English-only extraction. Translations and the language switcher are gone.
 * Run with `node --test`.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { extractMonolingualPost, stripLanguageSwitcher } = require("./content-extract");

test("uses flat English fields and ignores translations", () => {
  const post = {
    slug: "telegram-bot-insights",
    title: "Telegram Bot — Insights",
    body_html: "<h2>Why this matters</h2><p>English body.</p>",
    meta_description: "Practical guidance.",
    json_ld: { "@type": "Article" },
    language: "es",
    translations: {
      es: { title: "Español", body_html: "<p>es</p>", meta_description: "es" },
      en: { title: "From map", body_html: "<p>map</p>", meta_description: "map" },
    },
  };
  const mono = extractMonolingualPost(post);
  assert.strictEqual(mono.title, "Telegram Bot — Insights");
  assert.strictEqual(mono.body_html, "<h2>Why this matters</h2><p>English body.</p>");
  assert.strictEqual(mono.meta_description, "Practical guidance.");
  assert.deepStrictEqual(mono.json_ld, { "@type": "Article" });
  assert.strictEqual(mono.language, "en");
});

test("does not read translations when flat fields are absent", () => {
  const mono = extractMonolingualPost({
    translations: { en: { title: "From map", body_html: "<p>map</p>", meta_description: "map" } },
  });
  assert.strictEqual(mono.title, "Published Page");
  assert.strictEqual(mono.body_html, "");
  assert.strictEqual(mono.meta_description, "");
  assert.strictEqual(mono.language, "en");
});

test("does not throw when translations is a non-object", () => {
  assert.doesNotThrow(() => extractMonolingualPost({ title: "Ok", translations: "oops" }));
  assert.strictEqual(extractMonolingualPost({ title: "Ok", translations: "oops" }).title, "Ok");
});

test("stripLanguageSwitcher removes the language bar and leaves English body", () => {
  const page = `<body>
<nav class="ce-lang-switch" aria-label="Language"><select id="ce-lang-select"></select></nav>
<h1>English title</h1><p>English body.</p>
</body>`;
  const out = stripLanguageSwitcher(page);
  assert.ok(!out.includes("ce-lang-switch"));
  assert.ok(out.includes("<h1>English title</h1>"));
  assert.ok(out.includes("English body."));
});

test("stripLanguageSwitcher is a no-op without a switcher", () => {
  const html = "<body><h1>Hello</h1></body>";
  assert.strictEqual(stripLanguageSwitcher(html), html);
  assert.strictEqual(stripLanguageSwitcher(""), "");
});
