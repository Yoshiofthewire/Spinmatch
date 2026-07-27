export class UpstreamUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamUnavailableError';
    this.code = 'UPSTREAM_UNAVAILABLE';
    this.status = 502;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.code = 'BAD_REQUEST';
    this.status = 400;
  }
}

export class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
    this.code = 'RATE_LIMITED';
    this.status = 429;
  }
}

// The request was understood and refused because of the state of things, not
// because of anything wrong with the request. Used by the duplicate trash to
// refuse moving aside a track's last live copy.
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.status = 409;
  }
}
