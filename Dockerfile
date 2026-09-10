FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY packages packages
COPY apps/node apps/node
COPY apps/web apps/web
COPY scripts scripts
COPY tsconfig.json tsconfig.json
RUN npm run build
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/jot.sqlite
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["npm", "start"]
