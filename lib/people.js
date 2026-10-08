// People, as the API shows them. There are exactly two shapes, and this
// file is the only place either is made.
//
// **Everyone else** is {id, firstName, lastName, shortName, photoUrl} and
// nothing more: what the account service's /api/people gives, picked field
// by field. Never another person's email, phone, Instagram, Venmo or Cash
// App, not even to the host of an event they're on. Finding someone is
// one-way (you have to know their number already), and a guest list mustn't
// be a way around that. publicPerson() copies the five fields by name
// rather than spreading the object, so a field the account service adds
// later can't leak through here by accident. The tests walk every API
// response for anyone else's contact details (test/harness.js).
//
// **You** get yourself at /api/v1/me: your id, name, photo, whether your
// email is proven and whether you can be found. Not your contact details
// either: events never shows them, so the account admin grants events none
// of them (its /api/session answer leaves them out), and the apps edit
// them through the account service's own /api/native/v1/me. Even if the
// account service did send them, ownPerson() copies fields by name and
// they aren't among them. What events never holds can't leak from it.
//
// Someone the account service no longer has (a deleted account) is a
// former member: the same five fields, with no name and no photo. Their
// rows here stay.

const FORMER_MEMBER_NAME = 'Former member';

function publicPerson(p) {
  return {
    id: String(p.id),
    firstName: p.firstName,
    lastName: p.lastName,
    shortName: p.shortName,
    photoUrl: p.photoUrl || null
  };
}

function formerMember(id) {
  return { id: String(id), firstName: FORMER_MEMBER_NAME, lastName: '', shortName: FORMER_MEMBER_NAME, photoUrl: null };
}

// `people` is the Map from loadPeople(); `id` someone in it or not.
function personFrom(people, id) {
  const p = people.get(id);
  return p ? publicPerson(p) : formerMember(id);
}

// Names and photos for `ids`, in one call to the account service: a Map of
// id -> the account service's answer (use personFrom to show one). A
// failure is a 503, like the session lookup's.
async function loadPeople(canopy, ids) {
  try {
    return await canopy.people(ids);
  } catch (err) {
    err.status = 503;
    err.reason = 'accounts_unreachable';
    err.expose = 'Canopy accounts could not be reached. Try again in a minute.';
    throw err;
  }
}

// The signed-in person, to themselves, from their own session: no email,
// phone, Instagram, Venmo or Cash App (see the top of this file).
// emailVerified is only false when the account service says so; an
// account service from before quick sign-ups doesn't send it, and then
// everyone it signs in is verified.
function ownPerson(p) {
  return {
    id: String(p.id),
    firstName: p.firstName,
    lastName: p.lastName,
    shortName: p.shortName,
    photoUrl: p.photoUrl || null,
    emailVerified: p.emailVerified !== false,
    // Their "let people who know my phone number or Instagram find me".
    // Null when the account service doesn't say.
    findable: typeof p.findable === 'boolean' ? p.findable : null
  };
}

function isVerified(p) {
  return !!p && p.emailVerified !== false;
}

module.exports = { publicPerson, formerMember, personFrom, loadPeople, ownPerson, isVerified, FORMER_MEMBER_NAME };
