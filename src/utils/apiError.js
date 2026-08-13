'use strict';

/**
 * Application-level error carrying an HTTP status and a stable machine-readable
 * error code. Anything thrown that is not an ApiError is treated as a 500 and
 * its message is hidden from clients in production.
 */
class ApiError extends Error {
  constructor(statusCode, message, errorCode = 'ERROR', details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, ApiError);
  }

  static badRequest(msg, code = 'BAD_REQUEST', details) {
    return new ApiError(400, msg, code, details);
  }
  static unauthorized(msg = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, msg, code);
  }
  static forbidden(msg = 'You do not have access to this resource', code = 'FORBIDDEN') {
    return new ApiError(403, msg, code);
  }
  static notFound(msg = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, msg, code);
  }
  static conflict(msg, code = 'CONFLICT') {
    return new ApiError(409, msg, code);
  }
  static unprocessable(msg, code = 'UNPROCESSABLE', details) {
    return new ApiError(422, msg, code, details);
  }
}

module.exports = ApiError;
