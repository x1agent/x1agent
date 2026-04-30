# Build stage — produces dist/ via Astro Starlight build.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# Runtime stage — nginx serves the static build. Tiny image, fast cold
# starts, no Node runtime overhead for static content.
FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Cloud Run requires the container to listen on $PORT (default 8080).
# nginx.conf is configured for 8080 directly.
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
