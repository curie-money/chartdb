import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';
import UnpluginInjectPreload from 'unplugin-inject-preload/vite';

// Curie dbd: mango serves this build under /dbd/. Must end with "/".
const basePath = (process.env.VITE_BASE_PATH ?? '/').replace(/\/?$/, '/');

// https://vitejs.dev/config/
export default defineConfig({
    base: basePath,
    plugins: [
        react(),
        {
            // index.html loads the runtime config with an absolute "/config.js";
            // keep it under the base path.
            name: 'dbd-config-js-base',
            transformIndexHtml: (html) =>
                html.replace('src="/config.js"', `src="${basePath}config.js"`),
        },
        visualizer({
            filename: './stats/stats.html',
            open: false,
        }),
        UnpluginInjectPreload({
            files: [
                {
                    entryMatch: /logo-light.png$/,
                    outputMatch: /logo-light-.*.png$/,
                },
                {
                    entryMatch: /logo-dark.png$/,
                    outputMatch: /logo-dark-.*.png$/,
                },
            ],
        }),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    build: {
        rollupOptions: {
            external: (id) => /__test__/.test(id),
            output: {
                assetFileNames: (assetInfo) => {
                    if (
                        assetInfo.names &&
                        assetInfo.originalFileNames.some((name) =>
                            name.startsWith('src/assets/templates/')
                        )
                    ) {
                        return 'assets/[name][extname]';
                    }
                    return 'assets/[name]-[hash][extname]';
                },
            },
        },
    },
});
