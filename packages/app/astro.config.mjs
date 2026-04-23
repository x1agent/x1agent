// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      // Served through ingress-nginx at https://app.local.x1agent.dev in
      // dev. Vite's host-check (CVE-2025-30208) rejects any Host header
      // it doesn't know, so allowlist the dev-subdomain tree + localhost.
      allowedHosts: [".local.x1agent.dev", "localhost"],
      // HMR runs over the ingress as wss://app.local.x1agent.dev:443/.
      hmr: {
        host: "app.local.x1agent.dev",
        protocol: "wss",
        clientPort: 443,
      },
      // The app pod receives file changes via devspace sync (rsync-style
      // writes into the volume). inotify events don't always fire on a
      // synced volume, so fall back to polling. The cost is a few extra
      // fs stats per second, invisible at this scale.
      watch: {
        usePolling: true,
        interval: 300,
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 4322,
  },
});
