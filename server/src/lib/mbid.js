import { BadRequestError } from './httpErrors.js';

// MusicBrainz identifiers are UUIDs. Validating them matters because they are
// interpolated straight into upstream URL paths and into cache keys: `fetch`
// normalizes "..", so an unchecked value can silently retarget a request at a
// different MusicBrainz endpoint whose differently-shaped response then gets
// written into a user's file tags — and can poison the response cache under
// arbitrary keys along the way.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMbid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function assertMbid(value, label = 'MusicBrainz id') {
  if (!isMbid(value)) throw new BadRequestError(`Invalid ${label}`);
  return value;
}

// Route guard for an :mbid path parameter.
export function requireMbidParam(name = 'mbid') {
  return (req, res, next) => {
    if (!isMbid(req.params[name])) return next(new BadRequestError('Invalid MusicBrainz id'));
    next();
  };
}
