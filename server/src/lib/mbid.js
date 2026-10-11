import { BadRequestError } from './httpErrors.js';

// MBIDs go into upstream URL paths and cache keys; fetch normalizes "..", so an
// unchecked value could retarget the request and poison tags and cache.
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
