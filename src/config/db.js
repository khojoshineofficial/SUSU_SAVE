'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

/**
 * The in-flight connection promise, cached on `globalThis` so a serverless
 * platform that reuses a warm container (Vercel, Lambda) reuses the same
 * connection instead of opening a new one per invocation — which would
 * otherwise exhaust the Atlas connection limit under load.
 */
const cache = globalThis.__susuMongoose || (globalThis.__susuMongoose = { conn: null, promise: null });

async function connectDatabase(uri = env.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;

  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      // A serverless instance handles one request at a time, so a large pool is
      // wasted sockets; a long-lived server benefits from more.
      maxPoolSize: env.isServerless ? 5 : 20,
      minPoolSize: 0,
    }).then((m) => {
      logger.info(`MongoDB connected: ${mongoose.connection.name}`);
      return m.connection;
    }).catch((err) => {
      // Clear the cache so the next invocation retries instead of reusing a
      // permanently rejected promise.
      cache.promise = null;
      throw err;
    });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  cache.conn = null;
  cache.promise = null;
  logger.info('MongoDB disconnected');
}

module.exports = { connectDatabase, disconnectDatabase };
