import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { loadConfig } from "@nitpick/server/config"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // `pnpm dev` runs the nitpick server next to Vite, on the port its config resolves to.
    proxy: {
      "/api": `http://127.0.0.1:${loadConfig(process.env).port}`,
    },
  },
})
