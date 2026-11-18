import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The intro draws DIVIJ in the self-hosted Archivo before anything else, so the
// HTML asks for that face (latin subset) up front instead of waiting for the CSS.
function preloadBlockFont(): Plugin {
  return {
    name: 'preload-block-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find((f) => /archivo-latin-wdth-normal-[^/]*\.woff2$/.test(f));
        if (!file) return [];
        return [
          {
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${file}`, crossorigin: '' },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadBlockFont()],
  optimizeDeps: {
    exclude: ['lucide-react', '@ffmpeg/ffmpeg'],
  },
});
