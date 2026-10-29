// @ts-check
import { defineConfig } from "astro/config";

try {
  process.loadEnvFile();
} catch {
  // sin .env
}

export default defineConfig({
  output: "static",
  site: process.env.AGORA_SITE_URL || undefined,
  trailingSlash: "ignore",
  build: { format: "directory" },
  devToolbar: { enabled: false },
});
