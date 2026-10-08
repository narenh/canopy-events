// Each person's settings (the person_settings table). A person with no
// row has every default, which is how everyone starts and how everyone
// from before version 11 still is.
//
//   calendarInvites (default true): events they're invited to and haven't
//   answered go in their Canopy calendar, marked "[INVITED]"
//   (routes/calendar.js).

const DEFAULTS = { calendarInvites: true };

module.exports = function settingsStore(db) {
  const q = {
    get: db.prepare('SELECT calendar_invites FROM person_settings WHERE person_id = ?'),
    set: db.prepare(`
      INSERT INTO person_settings (person_id, calendar_invites, updated_at) VALUES (@personId, @calendarInvites, @now)
      ON CONFLICT (person_id) DO UPDATE SET calendar_invites = excluded.calendar_invites, updated_at = excluded.updated_at`)
  };

  function settingsOf(personId) {
    const r = q.get.get(String(personId));
    return r ? { calendarInvites: r.calendar_invites === 1 } : { ...DEFAULTS };
  }

  return {
    settingsOf,

    // Changes the settings in `changes` (already checked), keeping the
    // rest; answers the settings after.
    updateSettings(personId, changes) {
      const next = { ...settingsOf(personId), ...changes };
      q.set.run({ personId: String(personId), calendarInvites: next.calendarInvites ? 1 : 0, now: Date.now() });
      return next;
    }
  };
};

module.exports.DEFAULTS = DEFAULTS;
