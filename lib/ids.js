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

function randomBase62(length) {
  let id = '';
  while (id.length < length) {
    for (const byte of crypto.randomBytes(16)) {
      if (byte < 248 && id.length < length) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

function newEventId() {
  return randomBase62(EVENT_ID_LENGTH);
}

// A person's friend link (/f/<code>) is made the same way, and is as hard
// to guess: it's what lets someone add themselves to your friends.
const FRIEND_CODE_RE = /^[0-9A-Za-z]{12}$/;

function newFriendCode() {
  return randomBase62(12);
}

// Person ids are the account service's (UUIDs). Anything else isn't one.
const PERSON_ID_RE = /^[0-9a-f-]{36}$/;

module.exports = { newEventId, newFriendCode, EVENT_ID_RE, FRIEND_CODE_RE, PERSON_ID_RE };
