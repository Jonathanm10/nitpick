import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { loadConfig } from "@nitpick/server/config"

/**
 * The page's version for a Feedback's Environment: the package version and
 * the commit it was built from, as the server reports its own.
 */
function webVersion(): string {
  const { version } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")
  ) as { version: string }
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    }).trim()
    return commit === "" ? version : `${version} (${commit})`
  } catch {
    return version
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __NITPICK_VERSION__: JSON.stringify(webVersion()),
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // `pnpm dev` runs the nitpick server next to Vite, on the port its config resolves to.
    // WebSocket upgrades too: the device's input socket is under /api.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${loadConfig(process.env).port}`,
        ws: true,
      },
    },
  },
})
