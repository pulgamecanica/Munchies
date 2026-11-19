import { build } from 'esbuild';
import fs from 'node:fs';
await build({
  entryPoints: { app: 'src/main.jsx' }, bundle: true, minify: true, outdir: 'public',
  define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic', target: ['es2019'], logLevel: 'info',
  loader: { '.css': 'css' },
});
fs.copyFileSync('src/style.css', 'public/app.css');
fs.copyFileSync('src/index.html', 'public/index.html');
