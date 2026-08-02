import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { appbuilderApiDevServer } from "./vite-plugins/appbuilder-api-dev-server";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isProd = mode === "production";

  return {
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(
        env.npm_package_version || "1.0.0",
      ),
      "import.meta.env.VITE_APP_NAME": JSON.stringify("AKAB Portal"),
    },
    optimizeDeps: { exclude: ["@electric-sql/pglite"] },
    plugins: [
      react(),
      tailwindcss(),
      // Dev-only: mount /api/* from api/ folder (same handlers as production)
      !isProd && appbuilderApiDevServer(),
    ].filter(Boolean),
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      target: "es2020",
      chunkSizeWarningLimit: 900,
      // Production never loads browser PGlite — drop it from the rollup graph
      // so the image stays small and WASM cannot hang the portal.
      rollupOptions: {
        // Keep dynamic import path from resolving pglite into prod assets
        external: isProd
          ? (id) =>
              id === "@electric-sql/pglite" ||
              id.includes("@electric-sql/pglite") ||
              id === "drizzle-orm/pglite" ||
              id.includes("drizzle-orm/pglite")
          : undefined,
        output: {
          manualChunks: {
            vendor: ["react", "react-dom", "react-router-dom"],
            motion: ["motion"],
          },
        },
      },
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      // Dynamic preview hosts (sandbox) + any reverse-proxy hostname
      allowedHosts: true,
      // HMR over TLS proxy (sandbox). On bare localhost Vite falls back fine.
      hmr: process.env.VITE_HMR_CLIENT_PORT
        ? {
            clientPort: Number(process.env.VITE_HMR_CLIENT_PORT),
            protocol: process.env.VITE_HMR_PROTOCOL || "wss",
          }
        : process.env.VERCEL || process.env.APPBUILDER
          ? { clientPort: 443, protocol: "wss" }
          : undefined,
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      strictPort: true,
    },
  };
});
