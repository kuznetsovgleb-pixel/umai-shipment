import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base должен совпадать с именем репозитория на GitHub Pages,
// например для https://<user>.github.io/umai-shipment/ это "/umai-shipment/"
export default defineConfig({
  plugins: [react()],
  base: "/umai-shipment/",
});
