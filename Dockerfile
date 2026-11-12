FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY contracts ./contracts
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts/artifacts ./contracts/artifacts
RUN mkdir -p logs data && chown -R node:node /app/logs /app/data
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/app/main.js"]
