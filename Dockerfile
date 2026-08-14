# SUSU SAVE — production image.
#
# The app also runs fine as a plain Node service (npm ci --omit=dev && npm start);
# this Dockerfile exists so container-based hosts can build it directly.

FROM node:20-alpine

# dumb-init gives PID 1 correct signal handling, so SIGTERM reaches Node and the
# graceful shutdown in src/server.js actually runs (scheduler stopped, Mongo closed).
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so the dependency layer is cached across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Drop privileges — the node image ships an unprivileged `node` user.
RUN chown -R node:node /app
USER node

# Render (and most PaaS) inject PORT; the app reads process.env.PORT.
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
