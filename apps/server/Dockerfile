FROM node:22-slim

# Install Playwright system dependencies
RUN npx playwright install-deps chromium

WORKDIR /app

# Copy package files for install
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspace=apps/server --workspace=packages/shared

# Copy source
COPY packages/shared/ ./packages/shared/
COPY apps/server/ ./apps/server/

# Install Playwright chromium
RUN npx playwright install chromium

EXPOSE 3001

CMD ["npx", "tsx", "apps/server/src/server.ts"]
