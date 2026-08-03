FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies.
# --ignore-scripts: no dependency lifecycle script runs during the build. pnpm
# >=10 already blocks dependency build scripts (see allowBuilds in
# pnpm-workspace.yaml); this also skips the project's own husky `prepare` hook,
# which is useless in an image with no .git.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY . .

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install pnpm and curl (curl is used by the Docker healthcheck)
RUN apk add --no-cache curl && \
    corepack enable && corepack prepare pnpm@11.12.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

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

CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
