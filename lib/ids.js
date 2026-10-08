// Event ids. The id is the link (events.canopysf.com/e/<id>) and the only
// thing between an event and anyone who'd like to see it, since there's no
// listing or search. So it's random, from the OS's source: 12 characters
// of base62, 62^12, about 71 bits.
//
// Each character comes from one random byte. Bytes 248 to 255 are thrown
// away and drawn again, because 256 isn't a multiple of 62 and keeping
// them would make the first eight characters a little likelier.

const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const EVENT_ID_LENGTH = 12;
const EVENT_ID_RE = /^[0-9A-Za-z]{12}$/;

function newEventId() {
  let id = '';
  while (id.length < EVENT_ID_LENGTH) {
    for (const byte of crypto.randomBytes(16)) {
      if (byte < 248 && id.length < EVENT_ID_LENGTH) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

// Person ids are the account service's (UUIDs). Anything else isn't one.
const PERSON_ID_RE = /^[0-9a-f-]{36}$/;

module.exports = { newEventId, EVENT_ID_RE, PERSON_ID_RE };
