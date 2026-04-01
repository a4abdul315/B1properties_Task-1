import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://127.0.0.1:4000",
      "/media": "http://127.0.0.1:4000",
      "/notify": "http://127.0.0.1:4000",
      "/sync": "http://127.0.0.1:4000",
    },
  },
});
