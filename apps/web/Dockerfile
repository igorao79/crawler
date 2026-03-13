FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN npm install

COPY packages/shared/ ./packages/shared/
COPY apps/web/ ./apps/web/

EXPOSE 3000

CMD ["npm", "run", "dev:web"]
