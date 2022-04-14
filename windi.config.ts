import { defineConfig } from 'vite-plugin-windicss';
import colors from 'windicss/colors';

export default defineConfig({
  theme: {
    colors: {
      primary: colors.blue,
      background: {
        // 50: '#fafafa',
        // 100: '#f4f4f5',
        // 200: '#e4e4e7',
        // 300: '#d4d4d8',
        400: '#2e2f35',
        500: '#25272a',
        // 600: '#52525b',
        700: '#070a0d',
        // 800: '#27272a',
        // 900: '#18181b'
      },
      red: colors.red,
      blue: colors.blue,
      green: colors.green,
    },
  },
});
