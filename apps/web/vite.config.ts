import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue(), UnoCSS()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 3333}`,
        changeOrigin: false,
      },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 8000,
  },
});
