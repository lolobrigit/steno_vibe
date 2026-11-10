import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// Версия приложения: из APP_VERSION (env при сборке Docker) или из .env,
// иначе — из package.json
const env = loadEnv("", __dirname, "")
const appVersion = process.env.APP_VERSION ?? env.APP_VERSION ?? env.VITE_APP_VERSION ?? "dev"

// https://vite.dev/config/
export default defineConfig({
  // BASE_PATH=/whisper/ при сборке — если приложение разворачивается под префиксом
  // (см. инструкцию по деплою на VPS). По умолчанию — корень.
  base: process.env.BASE_PATH ?? "/",
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    inspectAttr(), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
});
