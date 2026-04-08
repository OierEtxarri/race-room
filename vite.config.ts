import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appBase = process.env.VITE_APP_BASE?.trim() || '/';
const apiBaseUrl = process.env.VITE_API_BASE_URL?.trim() || '';

export default defineConfig({
  base: appBase,
  plugins: [react()],
  server: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: apiBaseUrl
      ? undefined
      : {
          '/api': 'http://localhost:8787',
        },
  },
});
