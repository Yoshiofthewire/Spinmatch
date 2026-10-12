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

// Refused because of current state, not a bad request (e.g. trashing a last live copy).
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.status = 409;
  }
}
