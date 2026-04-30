// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://x1agent.com",
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [],
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 4323,
  },
});
