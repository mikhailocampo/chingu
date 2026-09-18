import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MAPBOX_API_KEY arrives from Doppler as a plain env var, and Vite exposes
  // only VITE_-prefixed names by default. Widening the prefix beats renaming
  // the secret, which the worker also reads. It is a `pk.` public token —
  // designed to ship in the client bundle — so this exposes nothing that a
  // static map URL would not have exposed anyway. It must still be URL-
  // restricted in the Mapbox dashboard, or anyone can lift it and spend the
  // quota. Never widen this to a prefix that would catch a secret.
  envPrefix: ["VITE_", "MAPBOX_"],
  server: {
    // Same-origin in dev, so no CORS anywhere and no preflight to break
    // mid-demo. The worker runs on 8787 (`bun run dev` in worker/).
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
