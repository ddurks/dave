import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vite acts purely as dev server + bundler for the ES module graph.
// Babylon stays a global from CDN (see index.html), so source files keep
// their `BABYLON.*` references unchanged.
//
// Asset path resolution:
//   Source code references models as absolute URLs like `/assets/davebot.glb`.
//   The real files live in `body/assets/`, alongside source.
//
//   This used to lean on `publicDir: "public"` containing a symlink
//   `assets -> ../assets`. Git cannot check that out as a symlink on Windows
//   without developer mode; it lands as a 9-byte text file whose contents are
//   the literal string "../assets". Dev survived that by accident, because Vite
//   also serves files under `root` -- but `build` copied the text file to
//   `dist/assets`, and Rollup then failed with EEXIST trying to mkdir the same
//   path for its own chunks. The build was impossible from a Windows checkout.
//
//   So: no symlink, no publicDir. Dev serves the GLBs from root as it already
//   did, and the plugin below copies them into dist/assets after a build.
//
// Prod API URL injection:
//   In `build` mode, inject a `<script>` tag setting window.DAVE_API_URL so
//   the deployed bundle hits davemind.drawvid.com instead of the localhost
//   fallback in src/config.js. Override at build time via DAVE_API_URL env.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(HERE, "assets");

const PROD_API_URL = process.env.DAVE_API_URL || "https://davemind.drawvid.com";

export default defineConfig(({ command }) => ({
  root: ".",
  // The GLBs are copied by copyAssets() instead; see above.
  publicDir: false,
  server: {
    port: 8080,
    // Fail loudly if :8080 is taken rather than drifting to :8081. A silent
    // move means the browser keeps hitting whatever already owns the port,
    // which looks exactly like the code not updating.
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Source uses top-level await (see dave-scene.js). Bump target so esbuild
    // accepts it instead of trying to lower for older browsers.
    target: "es2022",
  },
  plugins: command === "build" ? [injectApiUrl(PROD_API_URL), copyAssets()] : [],
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

/**
 * Copy body/assets into dist/assets once the bundle is written.
 *
 * closeBundle rather than a publicDir copy, so this lands after Rollup has
 * created dist/assets for its own chunks instead of racing it.
 */
function copyAssets() {
  return {
    name: "dave-copy-assets",
    closeBundle() {
      if (!fs.existsSync(ASSET_DIR)) {
        this.warn(`no asset directory at ${ASSET_DIR}`);
        return;
      }
      const dest = path.join(HERE, "dist", "assets");
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(ASSET_DIR)) {
        const from = path.join(ASSET_DIR, name);
        if (fs.statSync(from).isFile()) {
          fs.copyFileSync(from, path.join(dest, name));
        }
      }
    },
  };
}
