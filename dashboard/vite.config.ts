import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, "../dist/dashboard");

export default defineConfig({
  root,
  plugins: [tailwindcss(), react()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
  },
});
