import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // The page is served from '/', but relative asset URLs keep working if the
  // app is ever mounted under a prefix. An absolute '/assets/...' would not.
  base: './',
  build: {
    outDir: '../media/webui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Recharts is the bulk of the bundle. Its own chunk means the shell
          // paints before the charting code is parsed.
          charts: ['recharts'],
        },
      },
    },
  },
});
