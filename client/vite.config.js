import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// base './' so the built app also works from file:// inside the Electron shell.
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 5173,
        strictPort: false,
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
    },
});
