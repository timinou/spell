import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	base: "/web/",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		assetsDir: "assets",
		sourcemap: false,
	},
	server: {
		port: 5173,
		proxy: {
			"/web/api": "http://127.0.0.1:8787",
			"/web/artifacts": "http://127.0.0.1:8787",
			"/web/ws": { target: "ws://127.0.0.1:8787", ws: true },
		},
	},
});
