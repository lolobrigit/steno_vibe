import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// Версия приложения: из APP_VERSION (env при сборке Docker) или из .env,
// иначе — из package.json
const env = loadEnv("", __dirname, "")
const appVersion = process.env.APP_VERSION ?? env.APP_VERSION ?? env.VITE_APP_VERSION ?? "dev"

// ── SEO ─────────────────────────────────────────────────────────────
// SITE_URL — публичный адрес приложения с префиксом, например
// https://example.com/whisper/ . Без него canonical/hreflang/sitemap не
// генерируются: абсолютные ссылки нельзя придумать, а относительные поисковики
// отвергают. Языки совпадают с UI_LANGUAGES (src/i18n/index.ts).
const SEO_LANGS = ['en', 'es', 'de', 'ja', 'fr', 'pt', 'ru', 'it', 'nl', 'pl', 'tr', 'id', 'zh']
const siteUrl = (process.env.SITE_URL ?? env.SITE_URL ?? "").replace(/\/?$/, "/")
const hasSite = /^https?:\/\//.test(siteUrl)

function stenoSeo(): Plugin {
  const langUrl = (l: string) => (l === "en" ? siteUrl : `${siteUrl}?lang=${l}`)
  return {
    name: "steno-seo",
    transformIndexHtml(html) {
      if (!hasSite) return html
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: "STENO",
        url: siteUrl,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Any (modern browser)",
        inLanguage: SEO_LANGS,
        description:
          "Speech-to-text for audio and video: local Whisper in the browser or OpenAI-compatible cloud APIs, with speaker labels, subtitles and AI summaries.",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      }
      const tags = [
        `<link rel="canonical" href="${siteUrl}" />`,
        ...SEO_LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${langUrl(l)}" />`),
        `<link rel="alternate" hreflang="x-default" href="${siteUrl}" />`,
        `<meta property="og:url" content="${siteUrl}" />`,
        `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
      ]
      return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`)
    },
    generateBundle() {
      // robots.txt и sitemap.xml лежат рядом с index.html (dist/public)
      const robots = hasSite
        ? `User-agent: *\nAllow: /\nDisallow: ${new URL(siteUrl).pathname}api/\n\nSitemap: ${siteUrl}sitemap.xml\n`
        : `User-agent: *\nAllow: /\n`
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots })
      if (!hasSite) return
      const alt = SEO_LANGS.map(
        (l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${langUrl(l)}"/>`,
      ).join("\n")
      const urls = SEO_LANGS.map(
        (l) => `  <url>\n    <loc>${langUrl(l)}</loc>\n${alt}\n  </url>`,
      ).join("\n")
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`,
      })
    },
  }
}

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
    inspectAttr(), react(), stenoSeo()],
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
