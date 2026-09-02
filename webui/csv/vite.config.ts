import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A LIBRARY build, unlike webui/vite.config.ts next door: there is no HTML
// entry here (src/modules/csv/shell.ts writes the page) and the output has to
// be one plain script the webview can load from an extension URI with a
// nonce. `iife` with React bundled in is the shape that satisfies both.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // Vite only substitutes this for an app build. React reads it on every
  // render, and without it the bundle throws on `process is not defined`.
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: '../../media/csv',
    emptyOutDir: true,
    // One stylesheet, named, so shell.ts can point a <link> at it.
    cssCodeSplit: false,
    lib: {
      entry: 'main.tsx',
      formats: ['iife'],
      name: 'SftpCsvGrid',
      fileName: () => 'csv.js',
    },
    rollupOptions: {
      output: { assetFileNames: 'csv.[ext]' },
    },
  },
});
