import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const stdioProxyConfig = {
  entryPoints: ['src/mcp/stdioProxy.ts'],
  bundle: true,
  outfile: 'dist/mcp/stdioProxy.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
};

if (watch) {
  const [extCtx, proxyCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(stdioProxyConfig),
  ]);
  await Promise.all([extCtx.watch(), proxyCtx.watch()]);
  console.log('[chalk] watching extension and stdioProxy...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(stdioProxyConfig),
  ]);
}
