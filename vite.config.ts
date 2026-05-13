import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  root: "src",
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [svelte(), viteSingleFile()],
});
