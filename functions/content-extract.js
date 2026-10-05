/**
 * Pure helpers for the ContentEngine published-page pipeline.
 *
 * - `extractMonolingualPost` bridges ContentEngine's `post.translations` dict to
 *   the flat monoPost object that `buildPublishedHtml` expects.
 * - `pickTranslation` selects one language's content for server-side `?lang=`
 *   rendering.
 * - `buildLanguageSelector` / `injectLanguageSelector` produce a working
 *   language dropdown (navigates to `?lang=X`) and splice it into a served page.
 *
 * Dependency-free so these can be unit-tested with Node's built-in runner and
 * reused across the AutoX and shared CoinX function bases.
 */

const LANGUAGE_NAMES = {
  en: "English", zh: "Chinese", hi: "Hindi", es: "Spanish", fr: "French",
  ar: "Arabic", pt: "Portuguese", ru: "Russian", id: "Indonesian", ur: "Urdu",
  de: "German", ja: "Japanese", mr: "Marathi", te: "Telugu", tr: "Turkish",
  ta: "Tamil", vi: "Vietnamese", ko: "Korean", it: "Italian", fa: "Persian",
  pa: "Punjabi", bn: "Bangla", gu: "Gujarati", kn: "Kannada", th: "Thai",
  ml: "Malayalam", pl: "Polish", uk: "Ukrainian", ro: "Romanian", nl: "Dutch",
  el: "Greek", cs: "Czech", sv: "Swedish", hu: "Hungarian", az: "Azerbaijani",
  he: "Hebrew", so: "Somali", sr: "Serbian", bg: "Bulgarian", da: "Danish",
  fi: "Finnish", sk: "Slovak", no: "Norwegian", hr: "Croatian", ne: "Nepali",
  si: "Sinhala",
};

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {object} post The raw `payload.post` object from an incoming webhook.
 * @returns {{title:string, meta_description:string, body_html:string, json_ld:*, language:string}}
 */
function extractMonolingualPost(post = {}) {
  // Flat fields take priority when present (e.g. legacy hand-built payloads).
  let postTitle = post.title || "";
  let postBodyHtml = post.body_html || "";
  let postMetaDescription = post.meta_description || "";
  let postLanguage = post.language || "en";
  let postJsonLd = post.json_ld || null;

  // Otherwise fall back to a translation (prefer en, then first available).
  if ((!postTitle || !postBodyHtml) && post.translations && typeof post.translations === "object") {
    const translations = post.translations;
    const keys = Object.keys(translations);
    // pick preferred lang = en if present else first key
    const chosenLang = translations.en ? "en" : (keys[0] || "en");
    const translation = pickTranslation(post, chosenLang);
    if (translation) {
      postTitle = translation.title || postTitle;
      postBodyHtml = translation.body_html || postBodyHtml;
      postMetaDescription = translation.meta_description || postMetaDescription;
      postLanguage = chosenLang;
      postJsonLd = translation.json_ld || postJsonLd;
    }
  }

  return {
    title: postTitle || "Published Page",
    meta_description: postMetaDescription || "",
    body_html: postBodyHtml || "",
    json_ld: postJsonLd,
    language: postLanguage,
  };
}

/**
 * Select a translation for a language, preferring the requested lang then 'en'
 * then the first available. Returns the raw translation object (or null).
 * @param {{translations?: object}} post
 * @param {string} lang
 */
function pickTranslation(post, lang) {
  const translations = post && post.translations;
  if (!translations || typeof translations !== "object") return null;
  const keys = Object.keys(translations);
  if (keys.length === 0) return null;
  if (lang && translations[lang]) return translations[lang];
  if (translations.en) return translations.en;
  return translations[keys[0]];
}

/**
 * Build a language <select> that navigates to `?lang=<code>` on change.
 * @param {object} translations lang -> content
 * @param {string} currentLang
 * @returns {string} HTML (empty string if fewer than 2 languages)
 */
function buildLanguageSelector(translations, currentLang) {
  if (!translations || typeof translations !== "object") return "";
  const keys = Object.keys(translations);
  if (keys.length < 2) return "";
  const sortedKeys = keys.slice().sort();
  const options = sortedKeys
    .map(
      (l) =>
        `<option value="${esc(l)}"${l === currentLang ? ' selected' : ''}>${esc(LANGUAGE_NAMES[l] || l)}</option>`
    )
    .join("\n");
  return `<div class="language-selector" style="margin-bottom:20px;">
  <label for="language-select" style="margin-right:10px;">Language:</label>
  <select id="language-select" style="padding:5px;"
    onchange="var u=window.location.pathname;window.location.href=u+'?lang='+this.value;">
${options}
  </select>
</div>`;
}

/**
 * Insert a working language selector at the top of <body>.
 * Requires at least 2 translations to do anything.
 */
function injectLanguageSelector(html, translations, currentLang) {
  if (!html || typeof html !== "string") return html || "";
  const selector = buildLanguageSelector(translations, currentLang);
  if (!selector) return html;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => `${m}\n${selector}`);
  }
  return html;
}

module.exports = {
  extractMonolingualPost,
  pickTranslation,
  buildLanguageSelector,
  injectLanguageSelector,
  LANGUAGE_NAMES,
};
