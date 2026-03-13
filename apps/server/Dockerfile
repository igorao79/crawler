FROM node:22-slim

RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/

RUN npm install

COPY packages/shared/ ./packages/shared/
COPY apps/server/ ./apps/server/

RUN cd apps/server && npx playwright install chromium

EXPOSE 3001

CMD ["npm", "run", "dev:server"]
