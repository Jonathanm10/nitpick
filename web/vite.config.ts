import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // `pnpm dev` runs the nitpick server next to Vite; 4870 is its default port.
    proxy: {
      "/api": `http://127.0.0.1:${process.env.NITPICK_PORT || 4870}`,
    },
  },
})
