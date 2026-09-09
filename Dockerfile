FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci

COPY . .


FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    iputils-ping \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV TZ=Asia/Makassar

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./

RUN mkdir -p /data /backups

VOLUME ["/data"]

CMD ["npm", "start"]