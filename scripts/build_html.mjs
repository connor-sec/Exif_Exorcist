import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Source files carry the v1.0 / 1.0.0 template. A release tag replaces those
// markers so the badge, title, and engine VERSION match the file name.
// engine-raster.js is concatenated first: engine-containers.js reads the
// helpers it publishes on __exifExorcistParts.
const TEMPLATE_TAG = 'v1.0';
const TEMPLATE_SEMVER = '1.0.0';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1) {
  throw new Error('Usage: node scripts/build_html.mjs [vMAJOR.MINOR[.PATCH]]');
}

const tag = args[0] || TEMPLATE_TAG;
if (!/^v[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(tag)) {
  throw new Error('Unsupported version "' + tag + '". Expected vMAJOR.MINOR or vMAJOR.MINOR.PATCH, for example v1.1.');
}
const numeric = tag.slice(1);
const semver = /^[0-9]+\.[0-9]+$/.test(numeric) ? numeric + '.0' : numeric;
const asset = 'Exif-Exorcist-' + tag + '.html';
if (!/^Exif-Exorcist-v[0-9]+\.[0-9]+(\.[0-9]+)?\.html$/.test(asset) || asset.includes('/')) {
  throw new Error('Refusing to write "' + asset + '".');
}

const shell = readFileSync(join(root, 'src/shell.html'), 'utf8');
const engine = readFileSync(join(root, 'src/engine-raster.js'), 'utf8') + '\n' + readFileSync(join(root, 'src/engine-containers.js'), 'utf8') + '\n';
const ui = readFileSync(join(root, 'src/ui.js'), 'utf8');
if (engine.includes('</script>') || ui.includes('</script>')) {
  throw new Error('Inline script would close the HTML script element.');
}
// A function replacement, so a "$&" or "$'" inside the scripts is copied as written.
let html = shell.replace('@@ENGINE@@', () => engine).replace('@@UI@@', () => ui);
if (html.includes('@@ENGINE@@') || html.includes('@@UI@@')) throw new Error('Placeholder left in HTML.');

function replaceOnce(haystack, from, to, label) {
  const count = haystack.split(from).length - 1;
  if (count !== 1) {
    throw new Error('Expected exactly one ' + label + ', found ' + count + '.');
  }
  if (from === to) return haystack;
  return haystack.replace(from, () => to);
}

const stamps = [
  ['<title>Exif Exorcist ' + TEMPLATE_TAG + '</title>', '<title>Exif Exorcist ' + tag + '</title>', 'document title'],
  ['<span class="version">' + TEMPLATE_TAG + '</span>', '<span class="version">' + tag + '</span>', 'version badge'],
  ["var VERSION = '" + TEMPLATE_SEMVER + "';", "var VERSION = '" + semver + "';", 'engine VERSION'],
  ['<summary>Supported formats in ' + TEMPLATE_TAG + '</summary>', '<summary>Supported formats in ' + tag + '</summary>', 'formats summary'],
  ['Exif Exorcist ' + TEMPLATE_TAG + '. Maintained by', 'Exif Exorcist ' + tag + '. Maintained by', 'footer version'],
  ['Exif Exorcist ' + TEMPLATE_TAG + ' — offline metadata stripper', 'Exif Exorcist ' + tag + ' — offline metadata stripper', 'raster banner'],
  ['Exif Exorcist ' + TEMPLATE_TAG + ' — containers, PDF, clean pack, and the public API.', 'Exif Exorcist ' + tag + ' — containers, PDF, clean pack, and the public API.', 'containers banner']
];
for (const [from, to, label] of stamps) html = replaceOnce(html, from, to, label);

if (tag !== TEMPLATE_TAG) {
  for (const [from, , label] of stamps) {
    if (html.includes(from)) throw new Error('Template ' + label + ' was left in the built HTML.');
  }
}

const expectedBadge = '<span class="version">' + tag + '</span>';
const expectedTitle = '<title>Exif Exorcist ' + tag + '</title>';
const expectedConstant = "var VERSION = '" + semver + "';";
for (const [needle, label] of [[expectedBadge, 'version badge'], [expectedTitle, 'document title'], [expectedConstant, 'engine VERSION']]) {
  const count = html.split(needle).length - 1;
  if (count !== 1) throw new Error('Built HTML has ' + count + ' copies of the ' + label + ', expected 1.');
}

writeFileSync(join(root, asset), html);
console.log('Wrote ' + asset, html.length, 'bytes');
