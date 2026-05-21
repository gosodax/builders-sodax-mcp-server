FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install pnpm and curl (curl is used by the Docker healthcheck)
RUN apk add --no-cache curl && \
    corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only.
# --ignore-scripts: skip lifecycle hooks (e.g. the husky `prepare` script,
# which would fail here because husky is a devDependency). No prod dep
# in this project requires postinstall scripts.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# Copy built files
COPY --from=builder /app/dist ./dist

# Create non-root user for security (use 1001 to avoid clash with base image's 1000)
RUN addgroup -g 1001 -S appgroup && \
    adduser -S -u 1001 -G appgroup appuser
RUN chown -R appuser:appgroup /app

# Set environment
ENV NODE_ENV=production

USER appuser

CMD ["node", "dist/index.js"]
