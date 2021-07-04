import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import WindiCSS from 'vite-plugin-windicss';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  return {
    base: mode === 'production' || process.env.npm_lifecycle_event === 'preview' ? '/vizscript/' : undefined,
    plugins: [vue(), WindiCSS()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src')
      }
    }
  };
});
