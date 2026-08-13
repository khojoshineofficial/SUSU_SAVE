'use strict';

const ApiError = require('../utils/apiError');
const env = require('../config/env');
const logger = require('../utils/logger');

const notFoundHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
};

/** Translates driver/ODM errors into the application's error shape. */
function normalise(err) {
  if (err instanceof ApiError) return err;

  if (err?.name === 'ValidationError') {
    const details = Object.fromEntries(
      Object.entries(err.errors || {}).map(([field, e]) => [field, e.message]),
    );
    return ApiError.unprocessable('Some fields are invalid', 'VALIDATION_ERROR', details);
  }
  if (err?.name === 'CastError') {
    return ApiError.badRequest(`Invalid value for ${err.path}`, 'INVALID_ID');
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'value';
    return ApiError.conflict(`That ${field} is already in use`, 'DUPLICATE_KEY');
  }
  if (err?.type === 'entity.too.large') {
    return ApiError.badRequest('Request body is too large', 'PAYLOAD_TOO_LARGE');
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const apiError = normalise(err);

  if (!apiError) {
    logger.error('Unhandled error', err?.stack || err);
    return res.status(500).json({
      success: false,
      message: env.isProduction ? 'Something went wrong on our side' : err.message,
      errorCode: 'INTERNAL_ERROR',
      // Stack traces are never sent in production.
      ...(env.isProduction ? {} : { stack: err?.stack }),
    });
  }

  if (apiError.statusCode >= 500) logger.error(apiError.message, err?.stack);

  return res.status(apiError.statusCode).json({
    success: false,
    message: apiError.message,
    errorCode: apiError.errorCode,
    ...(apiError.details ? { details: apiError.details } : {}),
  });
}

module.exports = { notFoundHandler, errorHandler };
