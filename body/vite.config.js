import { defineConfig } from "vite";

// Vite acts purely as dev server + bundler for the ES module graph.
// Babylon stays a global from CDN (see index.html), so source files keep
// their `BABYLON.*` references unchanged.
//
// Asset path resolution:
//   Source code references models as absolute URLs like `/assets/davebot.glb`.
//   The real files live in `body/assets/` (alongside source). To serve them
//   at `/assets/*` in both dev and build, we use Vite's `publicDir` rooted
//   at `body/public/`, which contains a symlink `assets -> ../assets`. This
//   avoids moving the GLBs (which would force edits to dave-* sources).
//
// Prod API URL injection:
//   In `build` mode, inject a `<script>` tag setting window.DAVE_API_URL so
//   the deployed bundle hits davemind.drawvid.com instead of the localhost
//   fallback in src/config.js. Override at build time via DAVE_API_URL env.
const PROD_API_URL = process.env.DAVE_API_URL || "https://davemind.drawvid.com";

export default defineConfig(({ command }) => ({
  root: ".",
  publicDir: "public",
  server: {
    port: 8080,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Source uses top-level await (see dave-scene.js). Bump target so esbuild
    // accepts it instead of trying to lower for older browsers.
    target: "es2022",
  },
  plugins: command === "build" ? [injectApiUrl(PROD_API_URL)] : [],
}));

function injectApiUrl(url) {
  return {
    name: "inject-dave-api-url",
    transformIndexHtml(html) {
      const tag = `<script>window.DAVE_API_URL=${JSON.stringify(url)};</script>`;
      return html.replace(/<\/head>/, `${tag}\n</head>`);
    },
  };
}
