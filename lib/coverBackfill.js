// Covers uploaded before there were sizes (lib/db.js, version 9) are on
// disk at full size only. After the server starts, this makes their
// narrower copies (lib/coverImage.js WIDTHS), in the background, one
// cover at a time, through the same worker as uploads (so off the main
// thread, and an upload waits behind at most one of these).
//
// Until a cover's copies exist, its `cover_sizes` is NULL: the API says
// `coverImages: []`, and the pages draw the full-size coverImageUrl, as
// before. Each cover is finished in one go once the worker hands its
// copies back: check it's still the same cover, write the files, record
// the sizes. That's all synchronous, so no upload or delete can land in
// the middle; one that landed while the worker was busy wins, and the
// copies made from the old photo are dropped.
//
// Idempotent: it only ever picks covers with no sizes, so running it
// again (every start) does nothing once they're done. A cover that
// fails (its file missing or unreadable) is logged and skipped, and tried
// again at the next start.

const fs = require('fs');
const coverStore = require('./coverStore');
const { toStoredSizes } = require('./coverImage');

async function backfillCoverSizes(store, { log = console } = {}) {
  const pending = store.coversWithoutSizes();
  let done = 0;
  for (const { id, coverKey } of pending) {
    try {
      const file = coverStore.pathFor(id);
      if (!file) {
        log.error(`[canopy-events] cover sizes: the cover file for event ${id} is missing`);
        continue;
      }
      const { sizes } = await toStoredSizes(fs.readFileSync(file));
      const now = store.getEvent(id);
      if (!now || now.coverKey !== coverKey || now.coverSizes) continue;
      coverStore.saveSmaller(id, sizes);
      if (store.setCoverSizes(id, coverKey, sizes)) done++;
    } catch (err) {
      log.error(`[canopy-events] cover sizes: event ${id}'s cover couldn't be resized: ${err.message}`);
    }
  }
  if (pending.length) log.log(`[canopy-events] cover sizes: made for ${done} of ${pending.length} older covers`);
  return { pending: pending.length, done };
}

module.exports = { backfillCoverSizes };
