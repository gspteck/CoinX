/**
 * English-only helpers for the Content Engine published-page pipeline.
 *
 * Posts are stored and served in English. `post.translations` is ignored.
 * There is no language switcher and no `?lang=` rendering.
 *
 * Dependency-free so these can be unit-tested with Node's built-in runner and
 * reused across the AutoX / gspteck / CoinX (dual-site) function bases.
 */

/**
 * @param {object} post The raw `payload.post` object from an incoming webhook.
 * @returns {{title:string, meta_description:string, body_html:string, json_ld:*, language:string}}
 */
function extractMonolingualPost(post = {}) {
  return {
    title: post.title || "Published Page",
    meta_description: post.meta_description || "",
    body_html: post.body_html || "",
    json_ld: post.json_ld || null,
    language: "en",
  };
}

/**
 * Remove a previously injected `.ce-lang-switch` bar from stored HTML.
 * @param {string} html
 * @returns {string}
 */
function stripLanguageSwitcher(html) {
  if (!html || typeof html !== "string") return html || "";
  return html.replace(/<nav\b[^>]*\bce-lang-switch\b[^>]*>[\s\S]*?<\/nav>\s*/gi, "");
}

module.exports = {
  extractMonolingualPost,
  stripLanguageSwitcher,
};
