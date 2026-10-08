// An event's details: the optional extra fields a host adds under the
// description, like Partiful's "+ Link" and "+ Dress code". An ordered
// list (at most MAX_DETAILS), each { type, label, value }:
//
//   - `type`: one of TYPES;
//   - `label`: optional short text (a link's text, or a heading in place
//     of the type's own: "Kids' menu" instead of "Food");
//   - `value`: a link's http(s) address (checked and tidied: "partiful.com/x"
//     becomes "https://partiful.com/x", and no other scheme gets in), a
//     phone number (as typed, trimmed, checked loosely), or otherwise
//     plain text with its line breaks.
//
// Several of one type are fine (two links, say). The list is stored whole
// as JSON on the event (lib/db.js, version 13) and an edit replaces it
// whole.
//
// Who sees which: PRIVATE_TYPES (parking, a place to stay, a phone number)
// can hold an address, a door code or a number, so they're treated like
// the street address (lib/views.js): left out for someone signed out and
// for someone a host removed, with a count saying how many. The rest are
// public, like the description.

const TYPES = ['link', 'info', 'dress_code', 'food', 'parking', 'accommodation', 'phone'];
const PRIVATE_TYPES = ['parking', 'accommodation', 'phone'];
const MAX_DETAILS = 10;
const MAX_LABEL = 60;
const MAX_VALUE = 500;

// The headings the calendar feed writes (routes/calendar.js). The pages
// have their own words in public/copy.js.
const HEADINGS = {
  link: 'Link',
  info: 'Info',
  dress_code: 'Dress code',
  food: 'Food',
  parking: 'Parking',
  accommodation: 'Where to stay',
  phone: 'Phone'
};

// A phone number, loosely: digits with the usual punctuation and an
// optional leading +, 3 to 20 digits. Not a check that it's real (it's the
// host's number to give), only that `tel:` can dial it.
const PHONE_RE = /^\+?[0-9\s().\-/]+$/;

function isPrivate(type) {
  return PRIVATE_TYPES.includes(type);
}

function oneLine(raw) {
  return String(raw).trim().replace(/\s+/g, ' ');
}

// An http(s) address, tidied, or null. One typed without a scheme
// ("partiful.com/e/x") gets https://. Anything with another scheme
// (javascript:, data:, mailto:...) is refused, and so is one with a user
// name or password in it (https://bank.com@evil.example reads as one
// place and goes to another), or a host with no dot in it ("https://party").
function cleanUrl(raw) {
  let s = oneLine(raw);
  if (!s) return null;
  // No scheme, starting like a host name (a port is fine): https.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]|$)/i.test(s)) s = 'https://' + s;
  let url;
  try {
    url = new URL(s);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes('.')) return null;
  return url.href;
}

// A phone number's `tel:` link: its digits, with the + if it had one.
function telHref(value) {
  const digits = String(value).replace(/[^0-9]/g, '');
  return 'tel:' + (/^\s*\+/.test(value) ? '+' : '') + digits;
}

function cleanPhone(raw) {
  const s = oneLine(raw);
  if (!s || !PHONE_RE.test(s)) return null;
  const digits = s.replace(/[^0-9]/g, '').length;
  return digits >= 3 && digits <= 20 ? s : null;
}

// One refusal: [400, reason, sentence, { index }] (the index of the
// detail it's about, when it's about one).
function bad(reason, error, index) {
  return { error: [400, reason, error, index === undefined ? undefined : { index }] };
}

// `raw` from the request body: undefined (left alone), null or [] (none),
// or the list. Returns { details } (cleaned, maybe []) or { error }.
function cleanDetails(raw) {
  if (raw === undefined) return { details: undefined };
  if (raw === null) return { details: [] };
  if (!Array.isArray(raw)) return bad('bad_details', 'details is a list of { type, label, value }');
  if (raw.length > MAX_DETAILS) return bad('too_many_details', `an event has at most ${MAX_DETAILS} details`);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const d = raw[i];
    if (!d || typeof d !== 'object' || Array.isArray(d)) return bad('bad_detail', 'each detail is { type, label, value }', i);
    if (!TYPES.includes(d.type)) return bad('bad_detail_type', `a detail's type is one of ${TYPES.join(', ')}`, i);
    let label = null;
    if (d.label !== undefined && d.label !== null) {
      if (typeof d.label !== 'string') return bad('bad_detail_label', "a detail's label is text", i);
      label = oneLine(d.label) || null;
      if (label && label.length > MAX_LABEL) return bad('detail_too_long', `a detail's label is at most ${MAX_LABEL} characters`, i);
    }
    if (typeof d.value !== 'string' || !d.value.trim()) return bad('bad_detail_value', 'a detail needs a value', i);
    let value;
    if (d.type === 'link') {
      if (oneLine(d.value).length > MAX_VALUE) return bad('detail_too_long', `a link is at most ${MAX_VALUE} characters`, i);
      value = cleanUrl(d.value);
      if (!value) return bad('bad_detail_url', 'a link is a web address, starting http:// or https://', i);
      if (value.length > MAX_VALUE) return bad('detail_too_long', `a link is at most ${MAX_VALUE} characters`, i);
    } else if (d.type === 'phone') {
      value = cleanPhone(d.value);
      if (!value) return bad('bad_detail_phone', 'a phone number is digits, with spaces, dashes, dots, brackets or a leading +', i);
    } else {
      value = d.value.replace(/\r\n?/g, '\n').trim();
      if (value.length > MAX_VALUE) return bad('detail_too_long', `a detail is at most ${MAX_VALUE} characters`, i);
    }
    out.push({ type: d.type, label, value });
  }
  return { details: out };
}

// A stored detail as the API answers with it: plus `href`, a link's
// address or a phone's tel: link (null for the others).
function detailView(d) {
  let href = null;
  if (d.type === 'link') href = d.value;
  else if (d.type === 'phone') href = telHref(d.value);
  return { type: d.type, label: d.label, value: d.value, href };
}

module.exports = { TYPES, PRIVATE_TYPES, MAX_DETAILS, MAX_LABEL, MAX_VALUE, HEADINGS, isPrivate, cleanDetails, cleanUrl, cleanPhone, telHref, detailView };
