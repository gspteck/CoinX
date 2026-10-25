# Optional `seo_title` (added 2026-10-25)

Drafts (`drafts/<site>/<slug>.json`) may carry an optional `seo_title`
(recommended ~50-60 chars, "Primary keyword | Brand"; validate_post.py rejects >70).

- `scripts/publish_contentengine.py` sends it as `payload.post.seo_title` (omitted when absent/blank).
- `buildPublishedHtml` (all four repos: AutoX, CoinX/CoinDrop/Swappr, gspteck, PilotaSEO) uses it for
  `<title>` (and `og:title` where emitted, i.e. PilotaSEO). Falls back to `title` when absent,
  blank or >120 chars (`cleanSeoTitle` in functions/content-extract.js).
- The visible `<h1>` and any JSON-LD headline stay `title`.
- `savePublishedPage` stores `title` (the H1) on the Firestore doc; homepage "Latest articles" and
  /blog listings prefer that stored H1 and fall back to the page `<title>` for older docs.
- Changing `seo_title` on a live post needs a `post.update` (pages are stored pre-rendered).
