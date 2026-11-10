"use strict";
/**
 * Article-index freshness. contentenginePublish bumps meta/articleIndexEpoch on every
 * post.publish / post.update / post.delete; servePublishedPage compares the epoch (read at most
 * every EPOCH_CHECK_MS per instance) with the epoch its in-memory article index was built at and
 * rebuilds the index when it differs. The old TTL stays as a fallback if the epoch read fails.
 * Doc: meta/articleIndexEpoch { n, updatedAt, sites: { <siteKey>: <counter> } }  (Admin SDK only).
 */
const EPOCH_COLLECTION = "meta";
const EPOCH_DOC_ID = "articleIndexEpoch";
const EPOCH_CHECK_MS = 10 * 1000;

/** Increment the epoch for one site. Never throws (a failed bump must not fail a publish). */
async function bumpIndexEpoch(db, admin, siteKey) {
  try {
    const FV = admin.firestore.FieldValue;
    await db.collection(EPOCH_COLLECTION).doc(EPOCH_DOC_ID).set(
      { n: FV.increment(1), updatedAt: FV.serverTimestamp(), sites: { [String(siteKey)]: FV.increment(1) } },
      { merge: true }
    );
    return true;
  } catch (err) {
    console.error("[index-epoch] bump failed", err && err.message);
    return false;
  }
}

/** Reader with a short per-instance cache: at most one Firestore read per `intervalMs`. */
function createEpochReader(db, siteKey, intervalMs = EPOCH_CHECK_MS) {
  let at = 0;
  let value = 0;
  let pending = null;
  async function read(force) {
    if (!force && at && Date.now() - at < intervalMs) return value;
    if (pending) return pending;
    pending = (async () => {
      try {
        const snap = await db.collection(EPOCH_COLLECTION).doc(EPOCH_DOC_ID).get();
        const sites = (snap.exists && snap.get("sites")) || {};
        value = Number(sites[String(siteKey)]) || 0;
      } catch (err) {
        console.error("[index-epoch] read failed", err && err.message);
      } finally {
        at = Date.now();
        pending = null;
      }
      return value;
    })();
    return pending;
  }
  return { read };
}

module.exports = { bumpIndexEpoch, createEpochReader, EPOCH_CHECK_MS, EPOCH_COLLECTION, EPOCH_DOC_ID };
