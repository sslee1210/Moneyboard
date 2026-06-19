import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base:
    process.env.GITHUB_PAGES === "true" || process.env.npm_lifecycle_event === "build:pages" ? "/Moneyboard/" : "/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4173",
    },
  },
});
