import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The portal, on 5001, in front of portal-api on 5000. Everything under `/api` is proxied to
 * it, so the browser makes same-origin requests and the portal needs no CORS: one fewer thing
 * to get wrong on the demo laptop. `ws: false` and no buffering keep the SSE timeline live.
 */
const PORTAL_WEB_PORT = 5001;
const PORTAL_API_PORT = Number(process.env.PORTAL_API_PORT ?? 5000);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: PORTAL_WEB_PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${PORTAL_API_PORT}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
