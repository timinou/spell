import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

/**
 * Mirrors the asset layout the existing React dashboard uses, so spell-server's
 * `loadWebAssets` walks our `dist/` the same way — base `/web/`, hashed assets
 * under `/web/assets/*`, fallback to `/web/index.html` for client routes.
 */
export default defineConfig({
	plugins: [svelte()],
	base: "/web/",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		assetsDir: "assets",
		sourcemap: false,
	},
	server: {
		port: 5175,
		proxy: {
			"/web/api": "http://127.0.0.1:8787",
			"/web/artifacts": "http://127.0.0.1:8787",
			"/web/ws": { target: "ws://127.0.0.1:8787", ws: true },
		},
	},
});
