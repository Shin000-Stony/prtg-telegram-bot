# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

RUN test -f /usr/local/include/node/node.h \
    && npm_config_nodedir=/usr/local npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build \
    && mkdir -p dist/infrastructure/database/migrations \
    && cp src/infrastructure/database/migrations/*.sql \
          dist/infrastructure/database/migrations/

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./

RUN apk add --no-cache libstdc++ iputils tzdata \
    && apk add --no-cache --virtual .native-build-deps python3 make g++ \
    && test -f /usr/local/include/node/node.h \
    && npm_config_nodedir=/usr/local npm ci --omit=dev \
    && npm cache clean --force \
    && apk del .native-build-deps

RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001 -G nodejs

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data \
    && chown nodejs:nodejs /data

USER nodejs

ENV NODE_ENV=production
ENV TZ=Asia/Makassar

CMD ["node", "dist/app.js"]