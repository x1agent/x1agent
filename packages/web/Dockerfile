FROM node:22-alpine AS build
WORKDIR /app

# Bun's lockfile rules don't apply here — this package is self-contained
# (no workspace deps) so plain npm works and keeps the deploy portable.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
CMD ["node", "./dist/server/entry.mjs"]
