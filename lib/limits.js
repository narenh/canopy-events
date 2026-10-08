// Too many of something, per key, per window. In memory: a restart
// forgives everyone, which is fine at this scale. The same as the account
// service's, except that one request can count for several (an invite to
// 20 people counts 20), so `blocked` and `hit` take how many.
function attemptLimiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(key, n = 1) {
      const h = hits.get(key);
      return !!h && Date.now() < h.reset && h.n + n > max;
    },
    hit(key, n = 1) {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || now >= h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
      h.n += n;
      if (hits.size > 10000) hits.forEach((v, k) => { if (now >= v.reset) hits.delete(k); });
    }
  };
}

// The visitor's address. Cloudflare puts the real one in CF-Connecting-IP
// and overwrites anything the visitor sent; X-Forwarded-For (what req.ip
// reads, with trust proxy on) keeps whatever the visitor put first, so
// limiting on req.ip alone could be dodged by sending a fake one.
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip;
}

// A family of limits checked together: per `who` (here, a person), per
// address, and one ceiling across everyone -- the backstop when the first
// two are dodged with fresh accounts and addresses. It trips for
// everyone, which is the point.
function guessLimits({ perWho, perIp, overall }) {
  const who = attemptLimiter(perWho[0], perWho[1]);
  const ip = attemptLimiter(perIp[0], perIp[1]);
  const all = attemptLimiter(overall[0], overall[1]);
  return {
    blocked(req, key, n = 1) {
      return who.blocked(key, n) || ip.blocked(clientIp(req), n) || all.blocked('all', n);
    },
    hit(req, key, n = 1) {
      who.hit(key, n);
      ip.hit(clientIp(req), n);
      all.hit('all', n);
    }
  };
}

module.exports = { attemptLimiter, guessLimits, clientIp };
