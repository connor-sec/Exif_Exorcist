import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(root, 'Exif-Exorcist-v1.0.html');
const html = readFileSync(htmlPath, 'utf8');
const engine = html.split('/* EXIF_EXORCIST_ENGINE_START */')[1].split('/* EXIF_EXORCIST_ENGINE_END */')[0];
const src = readFileSync(join(root, 'src/engine.js'), 'utf8') + '\n' + readFileSync(join(root, 'src/engine2.js'), 'utf8') + '\n';
if (engine.trim() !== src.trim()) {
  throw new Error('Exif-Exorcist-v1.0.html engine does not match src/. Run node tests/build_html.mjs.');
}
eval(engine);
const EE = globalThis.ExifExorcist;

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed++;
    console.error('FAIL:', message);
  }
}

assert(html.includes('http-equiv="Content-Security-Policy"'), 'CSP meta tag');
assert(html.includes("default-src 'none'"), 'CSP default-src none');
assert(html.includes("connect-src 'none'"), 'CSP blocks network connects');
assert(!/<script\b[^>]*\bsrc=/i.test(html), 'no external scripts');
assert(!/<link\b[^>]*\bhref=/i.test(html), 'no external stylesheets');
assert(!/https?:\/\//.test(html.split('<script>')[0].split('</style>')[0] || ''), 'head has no network URLs');
assert(html.includes('Canvas re-encode'), 'canvas warning is in the page');
assert(html.includes('quality can drop'), 'quality-loss warning is explicit');

const work = mkdtempSync(join(tmpdir(), 'exif-exorcist-'));
execFileSync('python3', [join(root, 'tests/generate_samples.py'), work], { stdio: 'inherit' });

function read(name) {
  return new Uint8Array(readFileSync(join(work, name)));
}
function exif(path) {
  const out = execFileSync('exiftool', ['-j', '-a', '-G1', '-s', path], { encoding: 'utf8' });
  return JSON.parse(out)[0];
}
function identifying(tags) {
  const ignore = /FileName|Directory|FileSize|FileModify|FileAccess|FileInode|FilePermissions|FileType|FileTypeExtension|MIMEType|ExifTool|ImageWidth|ImageHeight|ImageSize|Megapixels|BitDepth|ColorType|Compression$|GIFVersion|EncodingProcess|YCbCr|JFIF|ColorComponents|BitsPerSample|Photometric|Strip|RowsPer|Planar|SamplesPer|Orientation|XResolution|YResolution|ResolutionUnit|Compressor|Handler|Track(?!.*Serial)|Media(?!Data)|Duration|Bitrate|MajorBrand|MinorVersion|Compatible|MovieHeader|Matrix|Preferred|Preview|Poster|Selection|CurrentTime|NextTrack|TimeScale|GraphicsMode|OpColor|SourceImage|PixelAspect|BufferSize|VideoFrame|AudioFormat|AudioChannel|AudioBits|AudioSample|Balance|AvgBitrate|Rotation|Zip|Warning|DirectoryItem|PrimaryItem|MediaData|ColorSpace|Interop|ComponentsConfiguration|Flashpix|ExifVersion|GPSVersion|Filter|Interlace|CopyrightFlag|OriginalMedia|Emphasis|ChannelMode|MPEGAudio|SampleRate|AudioLayer/;
  const bad = /GPS(?!Version)|Serial|Artist|Author|Creator|Copyright|Make|Model|ImageDescription|UserComment|Title|Subject|Keyword|Producer|Comment|Company|LastModified|CreateDate|ModifyDate|Description|Album|Year|Encoder|Software|DateTime|Lens|UserDefined|XPComment|Owner/;
  return Object.entries(tags).filter(([key, value]) => {
    const text = String(value);
    if (!text.trim()) return false;
    if (ignore.test(key)) return false;
    if (/^0000:00:00|^1904:01:01/.test(text)) return false;
    return bad.test(key);
  });
}

async function stripTo(name) {
  const input = read(name);
  const before = await EE.scan(input);
  const stripped = await EE.stripLossless(input);
  const outPath = join(work, 'out-' + name);
  if (stripped.ok) writeFileSync(outPath, stripped.bytes);
  const after = stripped.ok ? await EE.scan(stripped.bytes) : before;
  const verdict = EE.judge(stripped, after);
  return { input, before, stripped, after, verdict, outPath };
}

const full = ['sample.jpg', 'sample.png', 'sample.webp', 'sample.gif', 'sample.tif', 'sample.pdf', 'objectstreams.pdf', 'incremental.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.odt', 'sample.ods', 'sample.odp', 'sample.mp3'];
const best = ['sample.heic', 'sample.mp4', 'sample.mov', 'sample.m4a'];

for (const name of full.concat(best)) {
  const result = await stripTo(name);
  assert(result.before.items.some((item) => item.sensitive === 'gps' || /Jane|Secret|Acme|SN-/.test(item.value + item.tag)), name + ' scan found the planted metadata');
  assert(result.stripped.ok, name + ' stripped: ' + (result.stripped.reason || ''));
  if (!result.stripped.ok) continue;
  const left = identifying(exif(result.outPath));
  assert(left.length === 0, name + ' exiftool still reports ' + JSON.stringify(left));
  const expectClear = full.includes(name);
  if (expectClear) {
    assert(result.verdict.level === 'clear', name + ' verdict ' + result.verdict.level + ' after ' + JSON.stringify(result.after.items.map((i) => i.tag)));
    assert(!/clean/i.test(result.verdict.title), name + ' positive title does not say clean');
  } else {
    assert(result.verdict.level === 'unverified', name + ' best-effort verdict ' + result.verdict.level);
    assert(result.verdict.level !== 'clear', name + ' was certified');
  }
  if (left.length) assert(result.verdict.level !== 'clear', name + ' claimed clear while exiftool still sees metadata');
}

const mis = await EE.detect(read('photo.jpg'));
assert(mis.format === 'png', 'magic bytes beat the .jpg name, got ' + mis.format);

const residual = await stripTo('residual.docx');
assert(residual.stripped.ok, 'residual docx stripped');
assert(residual.verdict.level === 'residual', 'document text GPSLatitude stays and blocks a clear result, got ' + residual.verdict.level);
assert(/not clean/i.test(residual.verdict.detail), 'residual copy says the file is not clean');

const big = read('sample.bigtiff');
const bigStrip = await EE.stripLossless(big);
const bigVerdict = EE.judge(bigStrip, await EE.scan(big));
assert(!bigStrip.ok, 'BigTIFF is not modified');
assert(bigVerdict.level === 'failed', 'BigTIFF verdict ' + bigVerdict.level);
assert(bigVerdict.level !== 'clear', 'BigTIFF was certified');

for (const name of ['out-sample.jpg', 'out-sample.png', 'out-sample.webp', 'out-sample.gif', 'out-sample.tif']) {
  execFileSync('python3', ['-c', 'from PIL import Image; Image.open(' + JSON.stringify(join(work, name)) + ').load()']);
}
execFileSync('qpdf', ['--check', join(work, 'out-sample.pdf')], { stdio: 'pipe' });
execFileSync('qpdf', ['--check', join(work, 'out-objectstreams.pdf')], { stdio: 'pipe' });
execFileSync('qpdf', ['--check', join(work, 'out-incremental.pdf')], { stdio: 'pipe' });
for (const name of ['out-sample.mp4', 'out-sample.mov', 'out-sample.m4a', 'out-sample.mp3']) {
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', join(work, name)], { stdio: 'pipe' });
}

const zipBytes = EE.writeZip([
  { name: 'a.jpg', data: read('out-sample.jpg') },
  { name: 'b.png', data: read('out-sample.png') }
]);
const zipPath = join(work, 'bundle.zip');
writeFileSync(zipPath, zipBytes);
const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
assert(listing.includes('a.jpg') && listing.includes('b.png'), 'zip contains both files');
const unzipped = execFileSync('unzip', ['-p', zipPath, 'a.jpg']);
assert(Buffer.compare(unzipped, read('out-sample.jpg')) === 0, 'zip stores the stripped jpeg bytes');

const gpsRow = (await EE.scan(read('sample.jpg'))).items.find((item) => item.tag === 'GPSLatitude');
assert(gpsRow && gpsRow.sensitive === 'gps', 'GPS latitude is flagged');
const serialRow = (await EE.scan(read('sample.jpg'))).items.find((item) => /Serial/.test(item.tag));
assert(serialRow && serialRow.sensitive === 'serial', 'serial number is flagged');

rmSync(work, { recursive: true, force: true });
if (failed) {
  console.error(failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('All Exif Exorcist tests passed.');
