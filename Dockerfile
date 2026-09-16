# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

# Copy monorepo configurations
COPY package.json yarn.lock tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/deadlock-build-domain/package.json ./packages/deadlock-build-domain/
COPY apps/api/package.json ./apps/api/

# Install dependencies including build tools
RUN yarn install --frozen-lockfile --ignore-engines

# Copy sources
COPY packages/shared ./packages/shared
COPY packages/deadlock-build-domain ./packages/deadlock-build-domain
COPY apps/api ./apps/api

# Build typescript projects
RUN yarn workspace @dynamo-lab/shared build
RUN yarn workspace @dynamo-lab/build-domain build
RUN yarn workspace @dynamo-lab/api build

# Stage 2: Production runtime
FROM node:20-alpine
WORKDIR /app

ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Install the browser used only by the background Statlocker collector.
RUN apk add --no-cache chromium \
  && test -x "$CHROMIUM_PATH"

# Copy built artifacts and configurations from the builder stage
COPY --from=builder /app/package.json /app/yarn.lock ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/deadlock-build-domain/package.json ./packages/deadlock-build-domain/
COPY --from=builder /app/packages/deadlock-build-domain/dist ./packages/deadlock-build-domain/dist
COPY --from=builder /app/apps/api/package.json /app/apps/api/run-migrations.js ./apps/api/
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Install production dependencies only
RUN yarn install --production --frozen-lockfile --ignore-engines

WORKDIR /app/apps/api
EXPOSE 3000
ENV NODE_ENV=production

# Start NestJS API server
CMD ["node", "dist/src/main.js"]
