import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/vaultlens/',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // The production static server serves .js with the module worker MIME type.
        assetFileNames: asset => asset.names.some(name => name.endsWith('.mjs'))
          ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
