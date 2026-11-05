import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shell = readFileSync(join(root, 'src/shell.html'), 'utf8');
const engine = readFileSync(join(root, 'src/engine.js'), 'utf8') + '\n' + readFileSync(join(root, 'src/engine2.js'), 'utf8') + '\n';
const ui = readFileSync(join(root, 'src/ui.js'), 'utf8');
if (engine.includes('</script>') || ui.includes('</script>')) {
  throw new Error('Inline script would close the HTML script element.');
}
const html = shell.replace('@@ENGINE@@', engine).replace('@@UI@@', ui);
if (html.includes('@@ENGINE@@') || html.includes('@@UI@@')) throw new Error('Placeholder left in HTML.');
writeFileSync(join(root, 'Exif-Exorcist-v1.0.html'), html);
console.log('Wrote Exif-Exorcist-v1.0.html', html.length, 'bytes');
