// Cleaning what a host sends to make or edit an event. One function for
// both, so a field means the same thing either way.
//
// A field left out is left alone (on an edit) or takes its default (on a
// create). For the optional ones, null or "" clears it. Fields this
// doesn't know are ignored, so an app built against a newer version of
// the API still works against this one.

const { overAtFor } = require('./rules');
const { cleanDetails } = require('./details');

const LIMITS = { title: 120, description: 5000, locationName: 200, locationAddress: 500 };

// Apple Maps' id for a place (MKMapItem.identifier on iOS, `id` on the
// Maps Server API's places): opaque, short, and nothing but these.
const APPLE_PLACE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// Coordinates are kept to 6 decimals, about 10 cm.
const roundCoord = (n) => Math.round(n * 1e6) / 1e6;

// The first line of an address ("1 Market St" of "1 Market St, San
// Francisco"), folded, to compare a place's name with.
const firstLine = (s) => String(s || '').split(/[,\n]/)[0].toLowerCase().replace(/\s+/g, ' ').trim();

// Plus-ones: how many guests each answer may bring, 0 (the default) to 10.
const MAX_GUESTS_ALLOWED = 10;

// Capacity: the most people going, plus-ones included. null is no limit.
const MAX_CAPACITY = 10000;

// An event's colour, as a hue in degrees (0 to 359). null is the default.
const MAX_THEME_HUE = 359;

// An instant: a date and time with Z or an offset. A bare
// "2026-10-31T20:00" is refused, since it doesn't say which 8pm.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

function bad(reason, error) {
  return { error: [400, reason, error] };
}

function parseInstant(raw) {
  if (typeof raw !== 'string' || !INSTANT_RE.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms >= EARLIEST && ms < LATEST ? ms : null;
}

// An IANA time zone name the runtime knows (America/Los_Angeles, UTC...).
function isTimeZone(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return true;
  } catch (e) {
    return false;
  }
}

// One line: trimmed, runs of whitespace (newlines included) made one space.
function oneLine(raw) {
  return String(raw).trim().replace(/\s+/g, ' ');
}

// An optional text field: undefined (left out), null (cleared), the text,
// or false (the wrong type).
function optionalText(raw, { max, multiline }) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return false;
  const v = multiline ? raw.replace(/\r\n/g, '\n').trim() : oneLine(raw);
  return v ? v.slice(0, max) : null;
}

// Where the event is on a map: `latitude` and `longitude` (together, or
// both null), and `applePlaceId`. Private, like the address (lib/views.js).
// Run after the place and address are in `fields`, and adds to it.
//
//   - Either left out, on an edit that changes the place or address: it's
//     cleared, since it was where the old place was. (An app from before
//     coordinates, editing the address, can't leave the pin behind.)
//   - Neither a place nor an address left: no coordinates or id either;
//     sending some then is refused (`bad_coordinates`).
//   - A place name that is the address's first line ("1 Market St" and
//     "1 Market St, San Francisco") is the street address, which only
//     signed-in guests see: the name is dropped, so it isn't shown
//     publicly. That's an address picked from a map, sent as both.
function cleanCoordinates(body, current, fields) {
  const creating = !current;
  const now = (k) => (fields[k] !== undefined ? fields[k] : creating ? null : current[k]);
  const moved = !creating && ['locationName', 'locationAddress'].some((k) => fields[k] !== undefined && fields[k] !== current[k]);

  const latSent = body.latitude !== undefined;
  const lngSent = body.longitude !== undefined;
  if (latSent !== lngSent) return bad('bad_coordinates', 'latitude and longitude go together: send both, or neither');
  if (latSent) {
    const { latitude: lat, longitude: lng } = body;
    if (lat === null && lng === null) {
      fields.latitude = null;
      fields.longitude = null;
    } else {
      if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
          typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return bad('bad_coordinates', 'latitude is a number from -90 to 90 and longitude one from -180 to 180, or both null');
      }
      fields.latitude = roundCoord(lat);
      fields.longitude = roundCoord(lng);
    }
  } else if (creating || moved) {
    fields.latitude = null;
    fields.longitude = null;
  }

  if (body.applePlaceId !== undefined) {
    const id = body.applePlaceId;
    if (id !== null && id !== '' && (typeof id !== 'string' || !APPLE_PLACE_ID_RE.test(id))) {
      return bad('bad_apple_place_id', "applePlaceId is Apple Maps' id for the place (letters, digits, . _ : -, up to 128), or null");
    }
    fields.applePlaceId = id || null;
  } else if (creating || moved) fields.applePlaceId = null;

  const name = now('locationName');
  const address = now('locationAddress');
  if (!name && !address) {
    if (fields.latitude != null || fields.applePlaceId != null) {
      return bad('bad_coordinates', 'coordinates and applePlaceId need a locationName or locationAddress');
    }
    fields.latitude = null;
    fields.longitude = null;
    fields.applePlaceId = null;
  }
  if (name && address && (fields.locationName !== undefined || fields.locationAddress !== undefined) && firstLine(name) === firstLine(address)) {
    fields.locationName = null;
  }
  return {};
}

// `body` from the request; `current` is the event being edited (null when
// making one). Returns { fields } (record names, ready for the store) or
// { error: [status, reason, sentence, extra] }, `extra` being more for the
// error's JSON (a detail's `index`), or undefined.
function cleanEventInput(body, current) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const creating = !current;
  const fields = {};

  if (body.title !== undefined || creating) {
    if (typeof body.title !== 'string' || !oneLine(body.title)) return bad('bad_title', 'an event needs a title');
    fields.title = oneLine(body.title).slice(0, LIMITS.title);
  }

  for (const [key, multiline] of [['description', true], ['locationName', false], ['locationAddress', true]]) {
    const v = optionalText(body[key], { max: LIMITS[key], multiline });
    if (v === false) return bad(`bad_${key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}`, `${key} is text`);
    if (v !== undefined) fields[key] = v;
    else if (creating) fields[key] = null;
  }

  const located = cleanCoordinates(body, current, fields);
  if (located.error) return located;

  if (body.startsAt !== undefined || creating) {
    const ms = parseInstant(body.startsAt);
    if (ms === null) return bad('bad_starts_at', 'startsAt is a date and time with a time zone offset, like 2026-10-31T20:00:00-07:00');
    fields.startsAt = ms;
  }
  if (body.endsAt !== undefined) {
    if (body.endsAt === null || body.endsAt === '') fields.endsAt = null;
    else {
      const ms = parseInstant(body.endsAt);
      if (ms === null) return bad('bad_ends_at', 'endsAt is a date and time with a time zone offset, like 2026-10-31T23:00:00-07:00');
      fields.endsAt = ms;
    }
  } else if (creating) fields.endsAt = null;

  const startsAt = fields.startsAt !== undefined ? fields.startsAt : current.startsAt;
  const endsAt = fields.endsAt !== undefined ? fields.endsAt : current.endsAt;
  if (endsAt != null && endsAt <= startsAt) return bad('ends_before_start', 'an event has to end after it starts');
  if (fields.startsAt !== undefined || fields.endsAt !== undefined) fields.overAt = overAtFor(startsAt, endsAt);

  if (body.timeZone !== undefined || creating) {
    if (!isTimeZone(body.timeZone)) return bad('bad_time_zone', 'timeZone is an IANA time zone, like America/Los_Angeles');
    fields.timeZone = body.timeZone;
  }

  if (body.guestListVisibility !== undefined) {
    if (!['everyone', 'responded'].includes(body.guestListVisibility)) {
      return bad('bad_guest_list_visibility', "guestListVisibility is 'everyone' or 'responded'");
    }
    fields.guestListVisibility = body.guestListVisibility;
  } else if (creating) fields.guestListVisibility = 'everyone';

  if (body.guestsAllowed !== undefined) {
    const n = body.guestsAllowed;
    if (!Number.isInteger(n) || n < 0 || n > MAX_GUESTS_ALLOWED) {
      return bad('bad_guests_allowed', `guestsAllowed is a whole number from 0 to ${MAX_GUESTS_ALLOWED}`);
    }
    fields.guestsAllowed = n;
  } else if (creating) fields.guestsAllowed = 0;

  if (body.capacity !== undefined) {
    const n = body.capacity;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > MAX_CAPACITY)) {
      return bad('bad_capacity', `capacity is a whole number from 1 to ${MAX_CAPACITY.toLocaleString('en-US')}, or null for no limit`);
    }
    fields.capacity = n;
  } else if (creating) fields.capacity = null;

  // The event's colour: a hue in degrees, 0 to 359, or null for Canopy's
  // own green (the default).
  if (body.themeHue !== undefined) {
    const n = body.themeHue;
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > MAX_THEME_HUE)) {
      return bad('bad_theme_hue', `themeHue is a whole number of degrees from 0 to ${MAX_THEME_HUE}, or null for the default green`);
    }
    fields.themeHue = n;
  } else if (creating) fields.themeHue = null;

  // No colour at all: a neutral grey page, whatever themeHue says.
  if (body.themeGrayscale !== undefined) {
    if (typeof body.themeGrayscale !== 'boolean') return bad('bad_theme_grayscale', 'themeGrayscale is true or false');
    fields.themeGrayscale = body.themeGrayscale;
  } else if (creating) fields.themeGrayscale = false;

  // A grey event's accent: a hue, or null for white. Only for a grey
  // event: a hue on one that isn't (or won't be, after this change) is
  // refused, and an event leaving grey loses its accent in the same write.
  const grey = fields.themeGrayscale !== undefined ? fields.themeGrayscale : !creating && !!current.themeGrayscale;
  if (body.accentHue !== undefined) {
    const n = body.accentHue;
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > MAX_THEME_HUE)) {
      return bad('bad_accent_hue', `accentHue is a whole number of degrees from 0 to ${MAX_THEME_HUE}, or null for white`);
    }
    if (n !== null && !grey) return bad('accent_needs_grayscale', 'accentHue is only for an event with no colour (themeGrayscale true)');
    fields.accentHue = n;
  } else if (creating) fields.accentHue = null;
  if (!grey) fields.accentHue = null;

  // The extra fields under the description (lib/details.js): the whole
  // list, replacing what was there; null or [] for none.
  const details = cleanDetails(body.details);
  if (details.error) return details;
  if (details.details !== undefined) fields.details = details.details;
  else if (creating) fields.details = [];

  // Cancelling (and taking it back) is an edit. A new event is always active.
  if (!creating && body.status !== undefined) {
    if (!['active', 'cancelled'].includes(body.status)) return bad('bad_status', "status is 'active' or 'cancelled'");
    if (body.status !== current.status) {
      fields.status = body.status;
      fields.cancelledAt = body.status === 'cancelled' ? Date.now() : null;
    }
  }

  return { fields };
}

module.exports = { cleanEventInput, parseInstant, isTimeZone, LIMITS, MAX_GUESTS_ALLOWED, MAX_CAPACITY, MAX_THEME_HUE };
