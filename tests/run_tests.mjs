import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
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
assert(html.includes('id="clean-pack"'), 'clean pack download is on the page');
assert(html.includes('id="pick-folder"'), 'folder picker is on the page');
assert(html.includes('webkitdirectory'), 'folder input can select a directory');
assert(html.includes('Neutral filenames'), 'neutral filename control is on the page');
assert(html.includes('not the values that were stored'), 'the page says the manifest omits metadata values');

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

/* ------------------------------------------------------------------ regression cases
   Each block below pins one defect that was fixed. They build their inputs in
   memory so they do not need more sample tools than the cases above. */

const enc = new TextEncoder();
const bin = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 255);
const str = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const be32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const box = (type, ...payload) => { const body = cat(...payload); return cat(be32(8 + body.length), bin(type), body); };
const pngChunk = (type, data) => cat(be32(data.length), bin(type), data, be32(0));
async function run(bytes) {
  const stripped = await EE.stripLossless(bytes);
  const after = stripped.ok ? await EE.scan(stripped.bytes) : null;
  return { stripped, after, verdict: EE.judge(stripped, after) };
}

{ // ZIP names: UTF-8 flag for non-ASCII names, a valid DOS date, and no flag for plain names.
  const z = EE.writeZip([{ name: 'фото.jpg', data: Uint8Array.of(1) }, { name: 'plain.txt', data: Uint8Array.of(2) }]);
  assert((z[6] | (z[7] << 8)) === 0x0800, 'zip marks a non-ASCII name as UTF-8');
  assert((z[12] | (z[13] << 8)) === 0x0021, 'zip writes 1980-01-01 instead of a zero date');
  const second = str(z).indexOf('PK\x03\x04', 4);
  assert((z[second + 6] | (z[second + 7] << 8)) === 0, 'zip leaves the flag clear for an ASCII name');
  writeFileSync(join(work, 'utf8.zip'), z);
  const names = execFileSync('python3', ['-c', 'import sys,zipfile; sys.stdout.buffer.write("|".join(zipfile.ZipFile(sys.argv[1]).namelist()).encode("utf-8"))', join(work, 'utf8.zip')], { encoding: 'utf8' });
  assert(names.includes('фото.jpg'), 'zip name survives a round trip, got ' + names.trim());
}

{ // A stray delimiter inside a PDF array used to loop forever.
  const head = '%PDF-1.4\n';
  const obj = '1 0 obj\n[ ) ]\nendobj\n';
  const xrefAt = head.length + obj.length;
  const pdf = bin(head + obj + 'xref\n0 2\n0000000000 65535 f \n' + String(head.length).padStart(10, '0') + ' 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  const r = await run(pdf);
  assert(!r.stripped.ok && r.verdict.level === 'failed', 'malformed PDF is refused, not looped on');
  assert(!/not modified\.\s+The file was not modified/.test(r.stripped.reason), 'refusal message does not repeat itself: ' + r.stripped.reason);
}

{ // A stream whose /Length is wrong must be refused, not copied short.
  const head = '%PDF-1.4\n';
  const o1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const o2 = '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n';
  const o3 = '3 0 obj\n<< /Length 3 >>\nstream\nABCDEFGHIJ\nendstream\nendobj\n';
  const offs = [head.length, head.length + o1.length, head.length + o1.length + o2.length];
  const xrefAt = offs[2] + o3.length;
  const pdf = bin(head + o1 + o2 + o3 + 'xref\n0 4\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  const r = await run(pdf);
  assert(!r.stripped.ok, 'PDF with a wrong stream length is refused');
}

{ // The trailer /ID links copies of a document and is not carried over.
  const out = str(read('out-incremental.pdf'));
  assert(!/\/ID\s*\[/.test(out.slice(out.lastIndexOf('trailer'))), 'stripped PDF trailer has no /ID');
}

{ // APNG animation chunks stay, text chunks and bytes after IEND go.
  const png = cat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', new Uint8Array(13)), pngChunk('acTL', new Uint8Array(8)), pngChunk('tEXt', bin('Author\0Jane Doe')),
    pngChunk('IDAT', new Uint8Array(0)), pngChunk('IEND', new Uint8Array(0)), bin('TRAILER-SECRET'));
  const before = await EE.scan(png);
  assert(before.items.some((i) => i.tag === 'Trailing data'), 'PNG trailing data is reported');
  const r = await run(png);
  assert(r.stripped.ok, 'APNG stripped');
  const out = str(r.stripped.bytes);
  assert(out.includes('acTL'), 'APNG animation control chunk is kept');
  assert(!out.includes('tEXt') && !out.includes('TRAILER-SECRET'), 'PNG text chunk and trailing bytes are removed');
  assert(r.verdict.level === 'clear', 'stripped APNG verdict ' + r.verdict.level);
}

{ // Bytes after the JPEG end-of-image marker are reported, removed, and noted.
  const jpg = cat(read('sample.jpg'), bin('TRAILER-SECRET'));
  const before = await EE.scan(jpg);
  assert(before.items.some((i) => i.tag === 'Trailing data'), 'JPEG trailing data is reported');
  const r = await run(jpg);
  assert(r.stripped.ok && !str(r.stripped.bytes).includes('TRAILER-SECRET'), 'JPEG trailing data is removed');
  assert(r.stripped.notes.some((n) => /followed the end-of-image/.test(n)), 'JPEG trailing data removal is noted');
  assert(r.verdict.level === 'clear', 'JPEG with trailer verdict ' + r.verdict.level);
}

{ // XMP array values and attributes in any namespace are read.
  const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:aux="http://ns.adobe.com/exif/1.0/aux/" aux:SerialNumber="XS-0042">' +
    '<dc:creator><rdf:Seq><rdf:li>Li Author</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
  const payload = cat(bin('http://ns.adobe.com/xap/1.0/\0'), enc.encode(xml));
  const jpg = cat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255), payload, Uint8Array.of(0xff, 0xd9));
  const items = (await EE.scan(jpg)).items;
  assert(items.some((i) => i.tag === 'creator' && i.value === 'Li Author'), 'XMP rdf:li value is reported');
  assert(items.some((i) => i.tag === 'SerialNumber' && i.sensitive === 'serial'), 'XMP attribute outside the old namespace list is reported and flagged');
}

{ // A scan that breaks off is a finding, never an empty result.
  const png = cat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), be32(1000), bin('IHDR'), new Uint8Array(16));
  const scanned = await EE.scan(png);
  assert(scanned.items.some((i) => i.tag === 'Scan incomplete'), 'a failed scan leaves a row behind');
}

const CT_WORD = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const DOC_XML = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>';

{ // A document embedded in a document is opened, scanned, and stripped.
  const outer = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD) },
    { name: 'word/document.xml', data: enc.encode(DOC_XML) },
    { name: 'word/embeddings/inner.docx', data: read('sample.docx') }
  ]);
  const before = await EE.scan(outer);
  assert(before.items.some((i) => /Jane/.test(i.value) && /inner\.docx/.test(i.source)), 'metadata inside an embedded document is reported');
  const r = await run(outer);
  assert(r.stripped.ok, 'document with an embedded document stripped');
  assert(r.verdict.level === 'clear', 'embedded document verdict ' + r.verdict.level + ' after ' + JSON.stringify(r.after && r.after.items.map((i) => i.tag + '@' + i.source)));
  assert(r.stripped.notes.some((n) => /inner\.docx/.test(n)), 'embedded document strip is noted');
}

{ // Best-effort media inside a package keeps the package from being called clear.
  const outer = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD.replace(/wordprocessingml\.document/g, 'presentationml.presentation').replace('/word/document.xml', '/ppt/presentation.xml')) },
    { name: 'ppt/presentation.xml', data: enc.encode('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>') },
    { name: 'ppt/media/media1.mp4', data: read('sample.mp4') }
  ]);
  const r = await run(outer);
  assert(r.stripped.ok, 'presentation with embedded video stripped');
  assert(r.verdict.level !== 'clear', 'embedded best-effort media is not certified, got ' + r.verdict.level);
}

{ // Names Office writes outside docProps: comment authors, sign-in ids, Excel's saved folder path.
  const people = '<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Jane Doe"><w15:presenceInfo w15:providerId="AD" w15:userId="S::jane@example.test::1"/></w15:person></w15:people>';
  const comments = '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Jane Doe" w:initials="JD"/></w:comments>';
  const docx = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD) },
    { name: 'word/document.xml', data: enc.encode(DOC_XML) },
    { name: 'word/people.xml', data: enc.encode(people) },
    { name: 'word/comments.xml', data: enc.encode(comments) }
  ]);
  const before = await EE.scan(docx);
  assert(before.items.some((i) => i.tag === 'userId') && before.items.some((i) => i.tag === 'initials'), 'comment author identifiers are reported');
  const r = await run(docx);
  const out = str(r.stripped.bytes);
  assert(r.stripped.ok && !out.includes('jane@example.test') && !out.includes('"JD"') && !out.includes('Jane Doe'), 'comment author identifiers are cleared');
  assert(r.verdict.level === 'clear', 'docx with comment authors verdict ' + r.verdict.level);

  const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Users\\jane.doe\\Documents\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent></workbook>';
  const xl = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD.replace(/wordprocessingml\.document/g, 'spreadsheetml.sheet').replace('/word/document.xml', '/xl/workbook.xml')) },
    { name: 'xl/workbook.xml', data: enc.encode(wb) },
    { name: 'xl/comments1.xml', data: enc.encode('<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Jane Doe</author></authors></comments>') }
  ]);
  const rx = await run(xl);
  const outx = str(rx.stripped.bytes);
  assert(rx.stripped.ok && !outx.includes('jane.doe') && !outx.includes('Jane Doe'), 'Excel folder path and comment author are cleared');
  assert(outx.includes('<authors><author></author></authors>'), 'Excel comment author list keeps its slots');
}

{ // Encrypted and damaged ZIP entries are refused with the real reason.
  const good = EE.writeZip([{ name: '[Content_Types].xml', data: enc.encode(CT_WORD) }, { name: 'word/document.xml', data: enc.encode(DOC_XML) }]);
  const locked = good.slice();
  locked[str(locked).indexOf('PK\x01\x02') + 8] |= 1;
  const r1 = await EE.stripLossless(locked);
  assert(!r1.ok && /encrypted/i.test(r1.reason), 'encrypted ZIP entry is refused with a reason: ' + r1.reason);
  const damaged = good.slice();
  damaged[str(damaged).indexOf('Hello')] ^= 0xff;
  const r2 = await EE.stripLossless(damaged);
  assert(!r2.ok && /checksum/i.test(r2.reason), 'ZIP entry with a bad checksum is refused: ' + r2.reason);
}

{ // MP4: plain files shrink, files with movie fragments are scrubbed in place.
  const ftyp = box('ftyp', bin('isom'), be32(0), bin('isom'));
  const gps = box('\xa9xyz', Uint8Array.of(0, 18, 0x15, 0xc7), bin('+37.7749-122.4194/'));
  const moov = box('moov', box('mvhd', new Uint8Array(100)), box('udta', gps));
  const mdat = box('mdat', Uint8Array.of(1, 2, 3, 4));
  const plain = cat(ftyp, moov, mdat);
  const rp = await run(plain);
  assert(rp.stripped.ok && rp.stripped.bytes.length < plain.length && !str(rp.stripped.bytes).includes('+37.7749'), 'plain MP4 loses its udta box');
  const fragmented = cat(ftyp, moov, box('moof', box('mfhd', new Uint8Array(8))), mdat);
  const rf = await run(fragmented);
  assert(rf.stripped.ok && rf.stripped.bytes.length === fragmented.length, 'fragmented MP4 keeps its length so stored offsets stay true');
  assert(!str(rf.stripped.bytes).includes('+37.7749') && str(rf.stripped.bytes).includes('free'), 'fragmented MP4 metadata is overwritten with a free box');
  assert(rf.verdict.level === 'unverified', 'fragmented MP4 verdict ' + rf.verdict.level);

  // A container written with a 64-bit size keeps its 16-byte header.
  const body = cat(box('mvhd', new Uint8Array(100)), box('udta', gps));
  const wideMoov = cat(be32(1), bin('moov'), be32(0), be32(16 + body.length), body);
  const rw = await run(cat(ftyp, wideMoov, mdat));
  const ow = rw.stripped.bytes;
  const at = str(ow).indexOf('moov') - 4;
  assert(rw.stripped.ok && ow[at + 3] === 1 && str(ow.subarray(at + 16 + 4, at + 16 + 8)) === 'mvhd', 'a 64-bit moov header is rewritten as a 64-bit header');
}

{ // MP3: two ID3v2 tags in a row, and tags the ID3 reader does not parse.
  const frame = (text) => cat(bin('TIT2'), be32(text.length + 1), Uint8Array.of(0, 0, 0), bin(text));
  const tag = (text) => { const f = frame(text); return cat(bin('ID3'), Uint8Array.of(3, 0, 0, 0, 0, 0, f.length), f); };
  const audio = cat(Uint8Array.of(0xff, 0xfb, 0x90, 0x00), new Uint8Array(60));
  const r = await run(cat(tag('Secret One'), tag('Secret Two'), audio));
  assert(r.stripped.ok && r.stripped.bytes[0] === 0xff && r.stripped.bytes.length === audio.length, 'both ID3v2 tags are removed');
  assert(r.verdict.level === 'clear', 'double-tagged MP3 verdict ' + r.verdict.level);
  const lyrics = bin('LYRICSBEGIN' + 'IND0000200' + '000021' + 'LYRICS200');
  const rl = await run(cat(audio, lyrics));
  assert(rl.stripped.ok && rl.stripped.bytes.length === audio.length, 'Lyrics3 tag is removed');
  const stray = await EE.scan(cat(audio, bin('APETAGEX'), new Uint8Array(8)));
  assert(stray.items.some((i) => i.tag === 'APE tag'), 'an APE tag signature is reported by the scan');
}

{ // TIFF that would lose image data in a rebuild is refused.
  const tiff = cat(bin('II'), Uint8Array.of(42, 0), le32(8), Uint8Array.of(1, 0), Uint8Array.of(0x4a, 0x01, 4, 0), le32(1), le32(0), le32(0));
  const r = await EE.stripLossless(tiff);
  assert(!r.ok && /SubIFD/.test(r.reason), 'TIFF with SubIFDs is refused: ' + r.reason);
}

{ // WebP chunks outside the format's own set are removed.
  const src = read('sample.webp');
  const extra = cat(bin('ABCD'), le32(6), bin('secret'));
  const webp = cat(src, extra);
  webp.set(le32(webp.length - 8), 4);
  const before = await EE.scan(webp);
  assert(before.items.some((i) => i.tag === 'ABCD'), 'unrecognized WebP chunk is reported');
  const r = await run(webp);
  assert(r.stripped.ok && !str(r.stripped.bytes).includes('ABCD'), 'unrecognized WebP chunk is removed');
  writeFileSync(join(work, 'extra.webp'), r.stripped.bytes);
  execFileSync('python3', ['-c', 'from PIL import Image; Image.open(' + JSON.stringify(join(work, 'extra.webp')) + ').load()']);
}

{ // Clean pack: neutral names, a value-free manifest, and hashes of the output bytes.
  function nodeSha(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }
  async function agree(bytes) {
    const viaSubtle = await EE.sha256Hex(bytes);
    const viaJs = await EE.sha256Hex(bytes, true);
    const viaNode = nodeSha(bytes);
    assert(viaSubtle === viaNode && viaJs === viaNode, 'sha256 mismatch ' + viaSubtle + ' ' + viaJs + ' ' + viaNode);
    return viaNode;
  }
  assert(await agree(new Uint8Array(0)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 of empty input');
  assert(await agree(Buffer.from('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 of abc');
  assert(await agree(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')) === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'sha256 of the long test vector');
  await agree(Buffer.alloc(56, 0x61));
  await agree(Buffer.alloc(64, 0x61));
  await agree(Buffer.alloc(1000, 0x62));
  {
    const subtle = globalThis.crypto.subtle;
    const original = subtle.digest;
    let calls = 0;
    subtle.digest = function (alg, data) {
      calls++;
      return original.call(this, alg, data);
    };
    const hex = await EE.sha256Hex(Buffer.from('abc'));
    subtle.digest = original;
    assert(calls === 1 && hex.startsWith('ba7816bf'), 'manifest hashing goes through crypto.subtle when it is available');
  }

  assert(EE.sanitizePrefix('../Client Site') === 'Client-Site', 'prefix drops the directory and keeps the token');
  assert(EE.sanitizePrefix('..') === 'photo' && EE.sanitizePrefix('') === 'photo' && EE.sanitizePrefix('///') === 'photo', 'empty and dotted prefixes become photo');
  assert(EE.sanitizePrefix('a/../../etc') === 'etc', 'prefix keeps only the last path segment');
  assert(EE.sanitizePrefix('a'.repeat(80)).length <= 40 && !EE.sanitizePrefix('folder/name').includes('/'), 'prefix is short and has no slash');
  assert(EE.outputFilename('photo.jpg', 'jpeg') === 'photo-stripped.jpg', 'plain stripped name');
  assert(EE.outputFilename('photo.jpg', 'png') === 'photo-stripped.png', 'extension follows the format that was written');
  assert(EE.outputFilename('dir/photo.jpg', 'jpeg') === 'photo-stripped.jpg', 'stripped name drops directories');
  assert(EE.outputFilename('..\\..\\secret.jpg', 'jpeg') === 'secret-stripped.jpg', 'stripped name cannot escape the zip');

  const planted = [
    { tag: 'GPSLatitude', value: '37 deg SECRET-COORD', group: 'GPS', source: 'JPEG APP1 EXIF', sensitive: 'gps' },
    { tag: 'Make', value: 'SECRET-MAKE', group: 'IFD0', source: 'JPEG APP1 EXIF' },
    { tag: 'BodySerialNumber', value: 'SECRET-SN', group: 'Exif', source: 'JPEG APP1 EXIF', sensitive: 'serial' },
    { tag: 'DateTimeOriginal', value: 'SECRET-DATE', group: 'Exif', source: 'JPEG APP1 EXIF' },
    { tag: 'Software', value: 'SECRET-APP', group: 'IFD0', source: 'JPEG APP1 EXIF' },
    { tag: 'CreatorTool', value: 'SECRET-XMP', group: 'XMP', source: 'JPEG APP1 XMP' },
    { tag: 'By-line', value: 'SECRET-BY', group: 'IPTC', source: 'JPEG APP13' },
    { tag: 'MPF', value: 'SECRET-THUMB', group: 'JPEG', source: 'JPEG APP2' },
    { tag: 'ICC profile', value: 'SECRET-ICC', group: 'JPEG', source: 'JPEG APP2' },
    { tag: '=cmd|calc', value: 'SECRET-FORMULA', group: 'PNG', source: 'PNG tEXt' }
  ];
  const secrets = planted.map((item) => item.value);
  const output = Uint8Array.of(1, 2, 3, 4, 5);
  const original = Uint8Array.of(9, 8, 7, 6);
  const synthetic = await EE.cleanPack([
    {
      originalName: 'Client Folder/DCIM/IMG_2041.JPG',
      originalBytes: original,
      outputBytes: output,
      ok: true,
      format: 'jpeg',
      label: 'JPEG',
      support: 'full',
      method: 'lossless',
      verdict: { level: 'clear', title: 'No metadata detected', detail: 'Re-scan found no metadata.' },
      beforeItems: planted,
      afterItems: []
    },
    {
      originalName: 'shot.jpg',
      outputBytes: null,
      ok: false,
      format: 'bigtiff',
      label: 'BigTIFF',
      support: 'unsupported',
      method: 'lossless',
      verdict: { level: 'failed', title: 'Not stripped', detail: 'BigTIFF is not supported. The file was not modified.' },
      beforeItems: [],
      afterItems: []
    }
  ], {
    neutralNames: true,
    prefix: '../Client Site',
    includeOriginalNames: false,
    includeOriginalHashes: false,
    forceJsHash: true,
    generatedAt: '2026-11-18T00:00:00.000Z'
  });
  const manifestBlob = synthetic.json + '\n' + synthetic.csv + '\n' + synthetic.text;
  for (const secret of secrets) assert(!manifestBlob.includes(secret), 'manifest contains a metadata value: ' + secret);
  assert(!manifestBlob.includes('IMG_2041') && !manifestBlob.includes('Client Folder') && !manifestBlob.includes('DCIM') && !manifestBlob.includes('shot.jpg'), 'original names are omitted unless opted in');
  assert(!synthetic.manifest.files.some((row) => Object.prototype.hasOwnProperty.call(row, 'originalFilename') || Object.prototype.hasOwnProperty.call(row, 'originalSha256')), 'opt-in fields are omitted from each row by default');
  assert(!/"originalFilename"/.test(synthetic.json) && !/"originalSha256"/.test(synthetic.json), 'opt-in keys are absent from the JSON');
  assert(!synthetic.csv.includes('original_filename') && !synthetic.csv.includes('original_sha256'), 'opt-in columns are absent from the CSV');
  assert(!synthetic.text.includes('Original filename:') && !synthetic.text.includes('Original SHA-256:'), 'opt-in lines are absent from the text');
  assert(!/"value"\s*:/.test(synthetic.json), 'manifest JSON has no value field');
  assert(synthetic.manifest.version === '1.0.0' && synthetic.manifest.version === EE.version, 'manifest records the tool version');
  assert(synthetic.manifest.generatedAt === '2026-11-18T00:00:00.000Z', 'manifest records the generation time');
  assert(synthetic.manifest.neutralFilenames === true && synthetic.manifest.filenamePrefix === 'Client-Site', 'prefix is the sanitized token');
  assert(synthetic.manifest.files[0].outputFilename === 'Client-Site-001.jpg', 'neutral name is prefix, sequence, and format extension');
  assert(synthetic.manifest.files[0].sha256 === nodeSha(output), 'manifest hash matches the output bytes');
  assert(synthetic.manifest.files[1].included === false && synthetic.manifest.files[1].sha256 === null && synthetic.manifest.files[1].verdict === 'failed', 'a file that was not stripped is listed and not given an output hash');
  for (const category of ['GPS', 'Camera make/model', 'Camera serial', 'Timestamps', 'Software', 'XMP', 'IPTC', 'Thumbnails', 'Color profile', 'Author and identity']) {
    assert(synthetic.manifest.files[0].categoriesRemoved.includes(category), 'missing category ' + category);
  }
  assert(synthetic.text.includes('GPSLatitude removed (JPEG APP1 EXIF)'), 'field line names the field and not its value');
  assert(synthetic.text.includes('Exif Exorcist 1.0.0') && synthetic.text.includes('Generated: 2026-11-18T00:00:00.000Z'), 'text manifest has version and time');
  assert(synthetic.csv.charCodeAt(0) === 0xFEFF, 'CSV is UTF-8 with a byte-order mark');
  assert(synthetic.csv.includes("'=cmd|calc removed (PNG tEXt)"), 'CSV neutralizes a field name that would be a spreadsheet formula');
  const syntheticZip = join(work, 'synthetic-pack.zip');
  writeFileSync(syntheticZip, synthetic.zip);
  const syntheticNames = execFileSync('python3', ['-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', syntheticZip], { encoding: 'utf8' }).trim().split('\n');
  assert(syntheticNames.join(',') === 'Client-Site-001.jpg,manifest.json,manifest.csv,manifest.txt', 'zip entries are the output plus the three manifests, got ' + syntheticNames.join(','));
  assert(syntheticNames.every((name) => !name.includes('/') && !name.includes('\\') && !name.includes('..')), 'zip entries have no path');
  const zippedOutput = execFileSync('unzip', ['-p', syntheticZip, 'Client-Site-001.jpg']);
  assert(Buffer.compare(zippedOutput, Buffer.from(output)) === 0, 'zip stores the cleaned bytes');
  assert(nodeSha(zippedOutput) === synthetic.manifest.files[0].sha256, 'hash matches the bytes stored in the zip');
  assert(execFileSync('unzip', ['-p', syntheticZip, 'manifest.json'], { encoding: 'utf8' }) === synthetic.json, 'zip stores the JSON manifest');

  const opted = await EE.cleanPack([
    {
      originalName: 'Client Folder/DCIM/IMG_2041.JPG',
      originalBytes: original,
      outputBytes: output,
      ok: true,
      format: 'jpeg',
      label: 'JPEG',
      support: 'full',
      verdict: { level: 'clear', title: 'No metadata detected', detail: 'Re-scan found no metadata.' },
      beforeItems: planted,
      afterItems: []
    },
    {
      originalName: 'shot.jpg',
      outputBytes: output,
      ok: true,
      format: 'jpeg',
      label: 'JPEG',
      support: 'full',
      verdict: { level: 'clear', title: 'No metadata detected', detail: 'Re-scan found no metadata.' },
      beforeItems: [],
      afterItems: []
    }
  ], {
    neutralNames: false,
    prefix: 'SECRETPREFIX',
    includeOriginalNames: true,
    includeOriginalHashes: true,
    generatedAt: '2026-11-18T00:00:00.000Z'
  });
  const optedBlob = opted.json + '\n' + opted.csv + '\n' + opted.text;
  for (const secret of secrets) assert(!optedBlob.includes(secret), 'opt-in manifest still contains a metadata value: ' + secret);
  assert(!optedBlob.includes('SECRETPREFIX') && !optedBlob.includes('Client Folder') && !optedBlob.includes('DCIM'), 'opt-in keeps the file name and drops the folder and the unused prefix');
  assert(opted.manifest.filenamePrefix === null && opted.manifest.neutralFilenames === false, 'neutral names off does not publish a prefix');
  assert(opted.manifest.files[0].outputFilename === 'IMG_2041-stripped.jpg', 'without neutral names the output keeps the file stem');
  assert(opted.manifest.files[1].outputFilename === 'shot-stripped.jpg', 'second file keeps its own stem');
  assert(opted.manifest.files[0].originalFilename === 'IMG_2041.JPG', 'opt-in records the file name only');
  assert(opted.manifest.files[0].originalSha256 === nodeSha(original), 'opt-in original hash matches the original bytes');
  assert(opted.csv.includes('original_filename') && opted.csv.includes('original_sha256'), 'CSV gains the opt-in columns');
  assert(opted.text.includes('Original filename: IMG_2041.JPG') && opted.text.includes('Original SHA-256: ' + nodeSha(original)), 'text manifest shows the opt-in lines');

  const collided = await EE.cleanPack([
    { originalName: 'shot.jpg', outputBytes: Uint8Array.of(1), ok: true, format: 'jpeg', label: 'JPEG', support: 'full', verdict: { level: 'clear', title: 'No metadata detected', detail: 'Re-scan found no metadata.' }, beforeItems: [], afterItems: [] },
    { originalName: 'shot.jpg', outputBytes: Uint8Array.of(2), ok: true, format: 'jpeg', label: 'JPEG', support: 'full', verdict: { level: 'clear', title: 'No metadata detected', detail: 'Re-scan found no metadata.' }, beforeItems: [], afterItems: [] }
  ], { neutralNames: false, generatedAt: '2026-11-18T00:00:00.000Z' });
  assert(collided.manifest.files[0].outputFilename === 'shot-stripped.jpg' && collided.manifest.files[1].outputFilename === 'shot-stripped-2.jpg', 'duplicate output names get a suffix');

  const batch = await EE.processBatch([
    { name: 'sample.jpg', bytes: read('sample.jpg') },
    { name: 'LEAKED-ORIGINAL-NAME.tif', bytes: read('sample.bigtiff') },
    { name: 'sample.png', bytes: read('sample.png') }
  ], {
    neutralNames: true,
    prefix: 'site',
    includeOriginalNames: false,
    includeOriginalHashes: false,
    generatedAt: '2026-11-18T03:04:05.000Z'
  });
  assert(batch.manifest.fileCount === 3 && batch.manifest.includedCount === 2, 'batch keeps going after a file that cannot be stripped');
  assert(batch.manifest.files[0].outputFilename === 'site-001.jpg' && batch.manifest.files[0].verdict === 'clear', 'first output is the stripped jpeg');
  assert(batch.manifest.files[1].included === false && batch.manifest.files[1].verdict === 'failed' && batch.manifest.files[1].outputFilename === null, 'BigTIFF is reported and not packed');
  assert(batch.manifest.files[2].outputFilename === 'site-002.png' && batch.manifest.files[2].verdict === 'clear', 'sequence numbers count outputs, so the png is 002');
  const batchBlob = batch.json + '\n' + batch.csv + '\n' + batch.text;
  assert(!batchBlob.includes('LEAKED-ORIGINAL-NAME') && !batchBlob.includes('sample.jpg') && !batchBlob.includes('sample.png'), 'batch manifest does not repeat the original names');
  assert(!batchBlob.includes(nodeSha(read('sample.jpg'))), 'original jpeg hash is not written unless opted in');
  const scanned = await EE.scan(read('sample.jpg'));
  for (const item of scanned.items) {
    if (item.value && item.value.length >= 6) assert(!batchBlob.includes(item.value), 'real metadata value leaked into the manifest: ' + item.tag);
  }
  assert(batch.manifest.files[0].categoriesRemoved.includes('GPS'), 'jpeg pack records GPS as removed');
  assert(batch.text.includes('GPSLatitude removed'), 'jpeg pack names the GPS field that was removed');
  assert(batch.manifest.files[0].fieldsRemaining.length === 0, 'clear jpeg has no remaining fields in the manifest');
  const batchZip = join(work, 'batch-pack.zip');
  writeFileSync(batchZip, batch.zip);
  const batchNames = execFileSync('python3', ['-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', batchZip], { encoding: 'utf8' }).trim().split('\n');
  assert(batchNames.join(',') === 'site-001.jpg,site-002.png,manifest.json,manifest.csv,manifest.txt', 'batch zip contents ' + batchNames.join(','));
  const packedJpeg = execFileSync('unzip', ['-p', batchZip, 'site-001.jpg']);
  const strippedJpeg = await EE.stripLossless(read('sample.jpg'));
  assert(Buffer.compare(packedJpeg, Buffer.from(strippedJpeg.bytes)) === 0, 'batch output is the stripped jpeg');
  assert(nodeSha(packedJpeg) === batch.manifest.files[0].sha256, 'batch manifest hash matches the jpeg bytes in the zip');
  assert(await EE.sha256Hex(packedJpeg) === batch.manifest.files[0].sha256, 'Web Crypto hash matches the jpeg bytes in the zip');
  assert(await EE.sha256Hex(packedJpeg, true) === batch.manifest.files[0].sha256, 'built-in hash matches the jpeg bytes in the zip');
  const packedPng = execFileSync('unzip', ['-p', batchZip, 'site-002.png']);
  assert(nodeSha(packedPng) === batch.manifest.files[2].sha256, 'batch manifest hash matches the png bytes in the zip');
}

/* ---- Identity data outside the property parts: Office, OpenDocument, PDF ---- */

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
function zipText(bytes, name) {
  const dir = mkdtempSync(join(tmpdir(), 'exif-exorcist-zip-'));
  const path = join(dir, 'x.zip');
  writeFileSync(path, bytes);
  try {
    // Brackets are glob characters to unzip, so [Content_Types].xml is escaped.
    return execFileSync('unzip', ['-p', path, name.replace(/[\[\]]/g, '\\$&')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function zipNames(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'exif-exorcist-zip-'));
  const path = join(dir, 'x.zip');
  writeFileSync(path, bytes);
  const out = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');
  rmSync(dir, { recursive: true, force: true });
  return out;
}

{ // Word: template path, mail merge source, revision dates and ids, thumbnail.
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL_NS + '"';
  const settings = '<w:settings ' + W + '><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/><w:rsids><w:rsidRoot w:val="00AB12CD"/><w:rsid w:val="00AB12CD"/></w:rsids><w:mailMerge><w:query w:val="SELECT * FROM `C:\\Users\\JaneDoe\\list.xlsx`"/></w:mailMerge></w:settings>';
  const settingsRels = '<Relationships ' + PKG_RELS + '><Relationship Id="rId1" Type="' + REL_NS + '/attachedTemplate" Target="file:///C:\\Users\\JaneDoe\\AppData\\Roaming\\Microsoft\\Templates\\Acme.dotm" TargetMode="External"/></Relationships>';
  const doc = '<w:document ' + W + '><w:body><w:p w:rsidR="00AB12CD" w:rsidRDefault="00AB12CD"><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">kept </w:t></w:r></w:p></w:body></w:document>';
  const comments = '<w:comments ' + W + '><w:comment w:id="0" w:author="Jane Doe" w:date="2024-07-04T13:37:00Z" w:initials="JD"/></w:comments>';
  const rootRels = '<Relationships ' + PKG_RELS + '><Relationship Id="rId1" Type="' + REL_NS + '/officeDocument" Target="word/document.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>';
  const docx = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'word/document.xml', data: enc.encode(doc) },
    { name: 'word/comments.xml', data: enc.encode(comments) },
    { name: 'word/settings.xml', data: enc.encode(settings) },
    { name: 'word/_rels/settings.xml.rels', data: enc.encode(settingsRels) },
    { name: 'docProps/thumbnail.jpeg', data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) }
  ]);
  const before = await EE.scan(docx);
  const tags = before.items.map((i) => i.tag);
  for (const tag of ['Local path', 'revision date', 'rsid', 'attachedTemplate', 'mailMerge', 'Thumbnail']) {
    assert(tags.includes(tag), 'Word scan reports ' + tag);
  }
  const r = await run(docx);
  assert(r.stripped.ok, 'Word file with template path stripped');
  assert(r.verdict.level === 'clear', 'Word template/mail-merge verdict ' + r.verdict.level + ' after ' + JSON.stringify(r.after.items.map((i) => i.tag + '@' + i.source)));
  const all = zipNames(r.stripped.bytes).map((n) => zipText(r.stripped.bytes, n) || '').join('\n');
  assert(!/JaneDoe|Acme\.dotm|00AB12CD|2024-07-04/.test(all), 'Word template path, merge source, rsids, and revision dates are gone');
  assert(!zipNames(r.stripped.bytes).includes('docProps/thumbnail.jpeg'), 'Word thumbnail part is removed');
  assert(!/thumbnail/.test(zipText(r.stripped.bytes, '_rels/.rels')), 'thumbnail relationship is removed with the part');
  const outSettings = zipText(r.stripped.bytes, 'word/settings.xml');
  assert(/<w:zoom w:percent="100"\/>/.test(outSettings) && !/attachedTemplate|mailMerge|rsid/.test(outSettings), 'settings keep unrelated elements');
  assert(/xml:space="preserve">kept </.test(zipText(r.stripped.bytes, 'word/document.xml')), 'document text and other attributes are untouched');
}

{ // Word: tracked changes and custom XML are reported and keep the file from being called clear.
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = '<w:document ' + W + '><w:body><w:p><w:del w:id="2" w:author="Jane Doe" w:date="2024-07-04T13:38:00Z"><w:r><w:delText>old wording</w:delText></w:r></w:del></w:p></w:body></w:document>';
  const tracked = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD) },
    { name: 'word/document.xml', data: enc.encode(doc) }
  ]);
  const r = await run(tracked);
  assert(r.stripped.ok && r.verdict.level === 'residual', 'tracked changes block a clear result, got ' + r.verdict.level);
  assert(r.after.items.some((i) => i.tag === 'Tracked changes'), 'tracked changes are named in the re-scan');
  assert(!/Jane Doe|2024-07-04/.test(zipText(r.stripped.bytes, 'word/document.xml')), 'tracked change author and date are cleared');
  assert(/old wording/.test(zipText(r.stripped.bytes, 'word/document.xml')), 'tracked change text is left for the author to resolve');

  const custom = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_WORD) },
    { name: 'word/document.xml', data: enc.encode(DOC_XML) },
    { name: 'customXml/item1.xml', data: enc.encode('<root xmlns="urn:x"><owner>Jane Doe</owner></root>') }
  ]);
  const rc = await run(custom);
  assert(rc.verdict.level === 'residual' && rc.after.items.some((i) => i.tag === 'Custom XML part'), 'custom XML part blocks a clear result, got ' + rc.verdict.level);
}

{ // Excel: printer settings go with their references; connections and link paths are reported.
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + REL_NS + '"';
  const CT_XL = CT_WORD.replace(/wordprocessingml\.document/g, 'spreadsheetml.sheet').replace('/word/document.xml', '/xl/workbook.xml');
  const sheet = '<worksheet ' + S + '><sheetData/><pageSetup orientation="landscape" r:id="rId1"/></worksheet>';
  const sheetRels = '<Relationships ' + PKG_RELS + '><Relationship Id="rId1" Type="' + REL_NS + '/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>';
  const pivot = '<pivotCacheDefinition ' + S + ' refreshedBy="Jane Doe" recordCount="0"/>';
  const printer = new Uint8Array(Buffer.from('\\\\PRINTSRV\\JaneDoe-HP', 'utf16le'));
  const base = [
    { name: '[Content_Types].xml', data: enc.encode(CT_XL) },
    { name: 'xl/workbook.xml', data: enc.encode('<workbook ' + S + '/>') },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: enc.encode(sheetRels) },
    { name: 'xl/printerSettings/printerSettings1.bin', data: printer },
    { name: 'xl/pivotCache/pivotCacheDefinition1.xml', data: enc.encode(pivot) }
  ];
  const xlsx = EE.writeZip(base);
  const before = await EE.scan(xlsx);
  assert(before.items.some((i) => i.tag === 'Printer settings') && before.items.some((i) => i.tag === 'refreshedBy'), 'Excel scan reports printer settings and refreshedBy');
  const r = await run(xlsx);
  assert(r.verdict.level === 'clear', 'Excel printer/pivot verdict ' + r.verdict.level + ' after ' + JSON.stringify(r.after.items.map((i) => i.tag + '@' + i.source)));
  assert(!zipNames(r.stripped.bytes).some((n) => /printerSettings/.test(n)), 'printer settings part is removed');
  assert(/<pageSetup orientation="landscape"\/>/.test(zipText(r.stripped.bytes, 'xl/worksheets/sheet1.xml')), 'pageSetup keeps its settings and loses the printer reference');
  assert(!/printerSettings/.test(zipText(r.stripped.bytes, 'xl/worksheets/_rels/sheet1.xml.rels')), 'printer settings relationship is removed');
  assert(!/Jane Doe/.test(zipText(r.stripped.bytes, 'xl/pivotCache/pivotCacheDefinition1.xml')), 'pivot cache refreshedBy is cleared');

  // A reference the stripper does not know how to remove keeps the part in place.
  const odd = base.slice();
  odd[2] = { name: 'xl/worksheets/sheet1.xml', data: enc.encode('<worksheet ' + S + '><sheetData/><unknownThing r:id="rId1"/></worksheet>') };
  const ro = await run(EE.writeZip(odd));
  assert(zipNames(ro.stripped.bytes).some((n) => /printerSettings1\.bin/.test(n)), 'printer settings stay when a reference cannot be removed');
  assert(/printerSettings/.test(zipText(ro.stripped.bytes, 'xl/worksheets/_rels/sheet1.xml.rels')), 'their relationship stays too, so nothing dangles');
  assert(ro.verdict.level === 'residual', 'kept printer settings block a clear result, got ' + ro.verdict.level);

  const conn = '<connections ' + S + '><connection id="1" name="q"><dbPr connection="Provider=SQLOLEDB;Data Source=sql01.example.test;User ID=JaneDoe"/></connection></connections>';
  const linkRels = '<Relationships ' + PKG_RELS + '><Relationship Id="rId1" Type="' + REL_NS + '/externalLinkPath" Target="file:///C:\\Users\\JaneDoe\\budget.xlsx" TargetMode="External"/></Relationships>';
  const linked = EE.writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT_XL) },
    { name: 'xl/workbook.xml', data: enc.encode('<workbook ' + S + '/>') },
    { name: 'xl/connections.xml', data: enc.encode(conn) },
    { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: enc.encode(linkRels) }
  ]);
  const rl = await run(linked);
  assert(rl.verdict.level === 'residual', 'data connection and external link verdict ' + rl.verdict.level);
  assert(rl.after.items.some((i) => i.tag === 'Data connection') && rl.after.items.some((i) => i.tag === 'Local path'), 'connection string and link path are named in the re-scan');
}

{ // OpenDocument: printer and data source in settings.xml, and change-tracking dates.
  const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
  const settings = '<office:document-settings ' + O + '><office:settings><config:config-item-set config:name="ooo:configuration-settings"><config:config-item config:name="PrinterName" config:type="string">\\\\PRINTSRV\\JaneDoe-HP</config:config-item><config:config-item config:name="CurrentDatabaseDataSource" config:type="string">C:\\Users\\JaneDoe\\db.odb</config:config-item><config:config-item config:name="PrinterPaperFromSetup" config:type="boolean">false</config:config-item></config:config-item-set></office:settings></office:document-settings>';
  const content = '<office:document-content ' + O + '><office:body><office:text><text:p>Hello<office:annotation><dc:creator>Jane Doe</dc:creator><dc:date>2024-07-04T13:37:00</dc:date><text:p>note</text:p></office:annotation></text:p></office:text></office:body></office:document-content>';
  const odt = EE.writeZip([
    { name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text') },
    { name: 'content.xml', data: enc.encode(content) },
    { name: 'settings.xml', data: enc.encode(settings) }
  ]);
  const before = await EE.scan(odt);
  assert(before.items.some((i) => i.tag === 'PrinterName') && before.items.some((i) => i.tag === 'date'), 'ODF scan reports the printer name and the annotation date');
  const r = await run(odt);
  assert(r.verdict.level === 'clear', 'ODF settings verdict ' + r.verdict.level + ' after ' + JSON.stringify(r.after.items.map((i) => i.tag + '@' + i.source)));
  const outSettings = zipText(r.stripped.bytes, 'settings.xml');
  assert(!/JaneDoe|PRINTSRV/.test(outSettings), 'ODF printer and data source names are cleared');
  assert(/PrinterPaperFromSetup" config:type="boolean">false</.test(outSettings), 'other ODF settings keep their values');
  const outContent = zipText(r.stripped.bytes, 'content.xml');
  assert(!/2024-07-04|Jane Doe/.test(outContent) && /<dc:date>1970-01-01T00:00:00<\/dc:date>/.test(outContent), 'ODF annotation date is reset and stays a valid date');
}

function buildPdf(objs) {
  let out = '%PDF-1.7\n';
  const offs = {};
  for (const [n, body] of objs) {
    offs[n] = out.length;
    out += n + ' 0 obj\n' + body + '\nendobj\n';
  }
  const max = Math.max(...objs.map((o) => o[0])) + 1;
  const xref = out.length;
  out += 'xref\n0 ' + max + '\n0000000000 65535 f \n';
  for (let i = 1; i < max; i++) out += String(offs[i] || 0).padStart(10, '0') + (offs[i] ? ' 00000 n \n' : ' 65535 f \n');
  out += 'trailer\n<< /Size ' + max + ' /Root 1 0 R /Info 2 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return bin(out);
}

{ // PDF: reviewer names and times on annotations, PieceInfo, and page timestamps.
  const content = 'BT ET';
  const objs = [
    [1, '<< /Type /Catalog /Pages 3 0 R /PieceInfo << /App << /LastModified (D:20240704133742Z) /Private << /Owner (Jane Doe) >> >> >> /AcroForm << /Fields [8 0 R] >> >>'],
    [2, '<< /Producer (Test) >>'],
    [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
    [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Annots [6 0 R 7 0 R 8 0 R] /LastModified (D:20240704133742Z) >>'],
    [5, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'],
    [6, '<< /Type /Annot /Subtype /Text /Rect [100 100 120 120] /Contents (Please check this figure) /T (Jane Doe) /M (D:20240704133742Z) /CreationDate (D:20240704133742Z) /NM (annot-1234) /Popup 7 0 R >>'],
    [7, '<< /Type /Annot /Subtype /Popup /Rect [130 100 300 200] /Parent 6 0 R >>'],
    [8, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (surname) /V (typed value) /Rect [50 600 250 620] >>']
  ];
  const pdf = buildPdf(objs);
  const before = await EE.scan(pdf);
  assert(before.items.some((i) => i.tag === 'Annotation author' && /Jane Doe/.test(i.value)), 'PDF annotation author is reported');
  assert(before.items.some((i) => i.tag === 'PieceInfo') && before.items.some((i) => i.tag === 'LastModified'), 'PDF PieceInfo and LastModified are reported');
  const r = await run(pdf);
  assert(r.stripped.ok, 'PDF with annotations stripped: ' + (r.stripped.reason || ''));
  assert(r.verdict.level === 'clear', 'PDF annotation verdict ' + r.verdict.level + ' after ' + JSON.stringify(r.after.items.map((i) => i.tag + '@' + i.source)));
  const out = str(r.stripped.bytes);
  assert(!/Jane Doe|20240704|annot-1234|PieceInfo/.test(out), 'PDF annotation author, dates, id, and PieceInfo are gone');
  assert(/Please check this figure/.test(out), 'PDF annotation text is kept');
  assert(/\/T \(surname\)/.test(out) && /\/V \(typed value\)/.test(out), 'PDF form field name and value are kept');
  const outPath = join(work, 'out-annotations.pdf');
  writeFileSync(outPath, r.stripped.bytes);
  let qpdfOk = true;
  try { execFileSync('qpdf', ['--check', outPath], { stdio: 'pipe' }); } catch (e) { qpdfOk = false; }
  assert(qpdfOk, 'qpdf accepts the PDF after annotations are rewritten');

  // An attachment is part of the document. It is reported and it blocks a clear result.
  const withFile = buildPdf([
    [1, '<< /Type /Catalog /Pages 3 0 R /Names << /EmbeddedFiles << /Names [(notes.txt) 6 0 R] >> >> >>'],
    [2, '<< >>'],
    [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
    [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>'],
    [5, '<< /Length 5 >>\nstream\nBT ET\nendstream'],
    [6, '<< /Type /Filespec /F (JaneDoe-notes.txt) /EF << /F 7 0 R >> >>'],
    [7, '<< /Type /EmbeddedFile /Length 5 >>\nstream\nhello\nendstream']
  ]);
  const rf = await run(withFile);
  assert(rf.stripped.ok && rf.verdict.level === 'residual', 'PDF attachment verdict ' + rf.verdict.level);
  assert(rf.after.items.some((i) => i.tag === 'Attachment' && /JaneDoe-notes\.txt/.test(i.value)), 'PDF attachment is named in the re-scan');
}

{ // GIF plain text extensions carry a string and are removed.
  const header = cat(bin('GIF89a'), Uint8Array.of(1, 0, 1, 0, 0x80, 0, 0), Uint8Array.of(0, 0, 0, 255, 255, 255));
  const image = Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0);
  const text = cat(Uint8Array.of(0x21, 0x01, 12, 0, 0, 0, 0, 8, 0, 8, 0, 8, 8, 1, 0), Uint8Array.of(8), bin('Jane Doe'), Uint8Array.of(0));
  const gif = cat(header, image, text, Uint8Array.of(0x3b));
  const before = await EE.scan(gif);
  assert(before.items.some((i) => i.tag === 'Plain text' && /Jane Doe/.test(i.value)), 'GIF plain text extension is reported');
  const r = await run(gif);
  assert(r.stripped.ok && !/Jane Doe/.test(str(r.stripped.bytes)), 'GIF plain text extension is removed');
  assert(r.verdict.level === 'clear', 'GIF plain text verdict ' + r.verdict.level);
  assert(r.stripped.bytes.length === header.length + image.length + 1, 'GIF image data is untouched');
}

{ // The orientation note is given for PNG and WebP too, not only JPEG.
  const tiff = Uint8Array.of(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0);
  const png = cat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', new Uint8Array(13)), pngChunk('eXIf', tiff), pngChunk('IDAT', new Uint8Array(0)), pngChunk('IEND', new Uint8Array(0)));
  const rp = await run(png);
  assert(rp.stripped.ok && rp.stripped.notes.some((n) => /orientation flag \(value 6\)/.test(n)), 'PNG orientation loss is noted');
  function riff(type, data) {
    const h = new Uint8Array(8);
    h.set(bin(type), 0);
    new DataView(h.buffer).setUint32(4, data.length, true);
    return cat(h, data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  }
  const body = cat(bin('WEBP'), riff('VP8X', Uint8Array.of(0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0)), riff('VP8 ', new Uint8Array(10)), riff('EXIF', tiff));
  const webp = cat(bin('RIFF'), new Uint8Array(4), body);
  new DataView(webp.buffer).setUint32(4, body.length, true);
  const rw = await run(webp);
  assert(rw.stripped.ok && rw.stripped.notes.some((n) => /orientation flag \(value 6\)/.test(n)), 'WebP orientation loss is noted: ' + (rw.stripped.reason || rw.stripped.notes.join(' | ')));
}

{ // The page is built from all three sources, not only the engine.
  const shell = readFileSync(join(root, 'src/shell.html'), 'utf8');
  const ui = readFileSync(join(root, 'src/ui.js'), 'utf8');
  assert(html === shell.replace('@@ENGINE@@', () => src).replace('@@UI@@', () => ui), 'Exif-Exorcist-v1.0.html matches src/shell.html, src/engine*.js, and src/ui.js. Run node tests/build_html.mjs.');
}

rmSync(work, { recursive: true, force: true });
if (failed) {
  console.error(failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('All Exif Exorcist tests passed.');
