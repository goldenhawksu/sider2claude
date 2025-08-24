import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  target: 'node18',
  outDir: 'dist',
  external: [
    // 外部依赖，不打包进最终文件 (hono + bun 技术栈)
    'hono',
    'consola',
    'citty',
    'fetch-event-stream',
    'gpt-tokenizer',
    'tiny-invariant',
  ],
});
