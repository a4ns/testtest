// Bundles the game into one self-contained HTML file: dist/liquid-glass-tetris.html
// (no service worker or manifest; everything else is inlined).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');
html = html.replace(/<!--build:remove-->[\s\S]*?<!--\/build:remove-->\s*/g, '');
html = html.replace(/<link rel="stylesheet" href="css\/style\.css" \/>/, () => '<style>\n' + read('css/style.css') + '</style>');
html = html.replace(/<!--build:scripts-->([\s\S]*?)<!--\/build:scripts-->/, (_, block) => {
  const files = [...block.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  const js = files.map((f) => '// ---- ' + f + '\n' + read(f).replace(/<\/script/gi, '<\\/script')).join('\n');
  return '<script>\n' + js + '\n</script>';
});

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'liquid-glass-tetris.html');
fs.writeFileSync(out, html);
console.log('wrote ' + path.relative(root, out) + ' (' + Math.round(html.length / 1024) + ' KB)');
