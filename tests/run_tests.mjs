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

rmSync(work, { recursive: true, force: true });
if (failed) {
  console.error(failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('All Exif Exorcist tests passed.');
