/*!
 * Exif Exorcist v1.0 — containers, PDF, and the public API.
 * Copyright (C) 2026 connor-sec
 * License: AGPL-3.0-only
 */
(function (root) {
  'use strict';
  var P = root.__exifExorcistParts;
  var ascii = P.ascii, latin1 = P.latin1, fromLatin1 = P.fromLatin1, concat = P.concat;
  var u16be = P.u16be, u16le = P.u16le, u32be = P.u32be, u32le = P.u32le;
  var setU32be = P.setU32be, setU32le = P.setU32le, u64be = P.u64be, setU64be = P.setU64be;
  var indexOfBytes = P.indexOfBytes, lastIndexOfAscii = P.lastIndexOfAscii;
  var inflate = P.inflate, crc32 = P.crc32, item = P.item, dedupe = P.dedupe;
  var parseXmp = P.parseXmp, parseTiffMetadata = P.parseTiffMetadata, mergeSafety = P.mergeSafety;
  var stripJpeg = P.stripJpeg, scanJpeg = P.scanJpeg, rebuildTiff = P.rebuildTiff;
  var scanPngFull = P.scanPngFull, stripPng = P.stripPng;
  var scanWebp = P.scanWebp, stripWebp = P.stripWebp;
  var scanGif = P.scanGif, stripGif = P.stripGif;
  var startsWith = P.startsWith;

  function readCString(data, p) {
    var s = '';
    while (p < data.length && data[p] !== 0) { s += String.fromCharCode(data[p]); p++; }
    return { s: s, end: p < data.length ? p + 1 : p };
  }

  function okResult(format, support, bytes, notes, blocksClear) {
    return { ok: true, format: format, support: support, bytes: bytes, notes: notes || [], blocksClear: !!blocksClear, changed: true };
  }
  function failResult(format, reason) {
    return { ok: false, format: format || 'unknown', support: 'unsupported', bytes: null, notes: [], blocksClear: true, changed: false, reason: reason };
  }

  /* ------------------------------------------------------------------ boxes */

  function parseBoxes(bytes, start, end) {
    var boxes = [];
    var p = start;
    while (p + 8 <= end) {
      var size = u32be(bytes, p);
      var type = ascii(bytes, p + 4, 4);
      var header = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u64be(bytes, p + 8);
        header = 16;
      } else if (size === 0) size = end - p;
      if (!isFinite(size) || size < header || p + size > end) break;
      boxes.push({ type: type, start: p, header: header, end: p + size, size: size });
      p += size;
    }
    return boxes;
  }

  function ftypInfo(bytes) {
    if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null;
    var size = u32be(bytes, 0);
    if (size < 16 || size > bytes.length) size = Math.min(bytes.length, Math.max(16, size));
    var brands = [ascii(bytes, 8, 4)];
    for (var i = 16; i + 4 <= size; i += 4) brands.push(ascii(bytes, i, 4));
    return { major: brands[0], brands: brands };
  }

  var HEIC_BRANDS = { heic: 1, heix: 1, hevc: 1, hevx: 1, heim: 1, heis: 1, hevm: 1, hevs: 1, mif1: 1, msf1: 1 };
  var AVIF_BRANDS = { avif: 1, avis: 1 };

  function brandHit(brands, set) {
    for (var i = 0; i < brands.length; i++) if (set[brands[i]]) return true;
    return false;
  }

  /* ------------------------------------------------------------------ HEIC */

  function parseIloc(payload) {
    if (payload.length < 8) return [];
    var ver = payload[0];
    var siz = u16be(payload, 4);
    var noff = siz >> 12;
    var nlen = (siz >> 8) & 15;
    var nbas = (siz >> 4) & 15;
    var nind = siz & 15;
    var pos = ver < 2 ? 8 : 10;
    var num = ver < 2 ? u16be(payload, 6) : u32be(payload, 6);
    function getVar(n) {
      if (!n) return 0;
      var v = n === 8 ? u64be(payload, pos) : u32be(payload, pos);
      pos += n;
      return v;
    }
    var out = [];
    /* The counts come from the file. Stop at the end of the box instead of
       trusting a count that can claim four billion items. */
    for (var i = 0; i < num; i++) {
      if (pos + 6 > payload.length) break;
      var id = ver < 2 ? u16be(payload, pos) : u32be(payload, pos);
      pos += ver < 2 ? 2 : 4;
      var construction = 0;
      if (ver === 1 || ver === 2) { construction = u16be(payload, pos) & 15; pos += 2; }
      var dataRef = u16be(payload, pos); pos += 2;
      var base = getVar(nbas);
      if (pos + 2 > payload.length) break;
      var extNum = u16be(payload, pos); pos += 2;
      var extents = [];
      var whole = true;
      for (var j = 0; j < extNum; j++) {
        if (pos + ((ver === 1 || ver === 2) ? nind : 0) + noff + nlen > payload.length) { whole = false; break; }
        if ((ver === 1 || ver === 2) && nind) getVar(nind);
        extents.push({ offset: getVar(noff), length: getVar(nlen) });
      }
      if (!whole) break;
      out.push({ id: id, construction: construction, dataRef: dataRef, base: base, extents: extents });
    }
    return out;
  }

  function parseInfe(payload) {
    if (payload.length < 8) return null;
    var ver = payload[0];
    var pos = 4;
    var id = 0;
    var type = '';
    var contentType = '';
    if (ver === 0 || ver === 1) {
      id = u16be(payload, pos);
      return { id: id, type: '', contentType: '' };
    }
    if (ver === 2) id = u16be(payload, pos), pos += 2;
    else if (ver === 3) id = u32be(payload, pos), pos += 4;
    else return null;
    pos += 2;
    type = ascii(payload, pos, 4);
    pos += 4;
    var name = readCString(payload, pos);
    pos = name.end;
    if (type === 'mime') contentType = readCString(payload, pos).s;
    return { id: id, type: type, contentType: contentType };
  }

  function heifItems(bytes) {
    var top = parseBoxes(bytes, 0, bytes.length);
    var meta = null;
    for (var i = 0; i < top.length; i++) if (top[i].type === 'meta') meta = top[i];
    if (!meta) return [];
    var children = parseBoxes(bytes, meta.start + meta.header + 4, meta.end);
    var infos = {};
    var locs = [];
    for (var c = 0; c < children.length; c++) {
      var box = children[c];
      var payload = bytes.subarray(box.start + box.header, box.end);
      if (box.type === 'iloc') locs = parseIloc(payload);
      if (box.type === 'iinf') {
        var skip = payload[0] === 0 ? 6 : 8;
        var infes = parseBoxes(payload, skip, payload.length);
        for (var k = 0; k < infes.length; k++) {
          if (infes[k].type !== 'infe') continue;
          var info = parseInfe(payload.subarray(infes[k].start + infes[k].header, infes[k].end));
          if (info) infos[info.id] = info;
        }
      }
    }
    return locs.map(function (loc) {
      var info = infos[loc.id] || { type: '', contentType: '' };
      return {
        id: loc.id, type: info.type, contentType: info.contentType || '',
        construction: loc.construction, dataRef: loc.dataRef, base: loc.base, extents: loc.extents
      };
    });
  }

  function isHeifMetaItem(it) {
    var t = it.type;
    if (t === 'Exif' || t === 'xml ' || t === 'mime') {
      if (t === 'mime' && it.contentType && !/xml|xmp|rdf/i.test(it.contentType)) return false;
      return true;
    }
    return false;
  }

  function readHeifExtent(bytes, it) {
    var parts = [];
    for (var i = 0; i < it.extents.length; i++) {
      var start = (it.base || 0) + it.extents[i].offset;
      var len = it.extents[i].length;
      if (start < 0 || len < 0 || start + len > bytes.length) return null;
      parts.push(bytes.subarray(start, start + len));
    }
    return concat(parts);
  }

  function scanHeic(bytes) {
    var items = [];
    var list = heifItems(bytes);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!isHeifMetaItem(it)) continue;
      if (it.dataRef) {
        items.push(item(it.type || 'item', 'Metadata item is not stored in this file', 'HEIF', 'HEIC item'));
        continue;
      }
      var payload = readHeifExtent(bytes, it);
      if (!payload || !payload.length) continue;
      var allZero = true;
      for (var z = 0; z < payload.length; z++) if (payload[z] !== 0) { allZero = false; break; }
      if (allZero) continue;
      if (it.type === 'Exif') {
        var parsed = [];
        if (payload.length > 8 && (ascii(payload, 4, 2) === 'II' || ascii(payload, 4, 2) === 'MM')) {
          var skip = 4 + u32be(payload, 0);
          parsed = parseTiffMetadata(payload, skip, 'HEIC Exif');
        } else if (ascii(payload, 0, 6) === 'Exif\x00\x00') parsed = parseTiffMetadata(payload, 6, 'HEIC Exif');
        else parsed = parseTiffMetadata(payload, 0, 'HEIC Exif');
        if (parsed.length) items.push.apply(items, parsed);
        else items.push(item('Exif', 'Exif item (' + payload.length + ' bytes)', 'HEIF', 'HEIC Exif'));
      } else {
        var xmp = parseXmp(payload, 'HEIC XMP');
        if (xmp.length) items.push.apply(items, xmp);
        else items.push(item(it.type, 'Metadata item (' + payload.length + ' bytes)', 'HEIF', 'HEIC item'));
      }
    }
    return items;
  }

  function stripHeic(bytes) {
    var notes = [];
    var out = bytes.slice();
    var list = heifItems(bytes);
    var zeroed = 0;
    var blocked = false;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!isHeifMetaItem(it)) continue;
      if (it.construction !== 0 || it.dataRef) {
        blocked = true;
        notes.push('Left HEIF item ' + (it.id) + ' in place (construction ' + it.construction + ', data reference ' + it.dataRef + ').');
        continue;
      }
      for (var e = 0; e < it.extents.length; e++) {
        var start = (it.base || 0) + it.extents[e].offset;
        var end = start + it.extents[e].length;
        if (start >= 0 && end <= out.length && end >= start) {
          out.fill(0, start, end);
          zeroed++;
        } else blocked = true;
      }
    }
    var top = parseBoxes(out, 0, out.length);
    for (var b = 0; b < top.length; b++) {
      if (top[b].type === 'uuid' && isXmpUuid(out, top[b])) {
        var s = top[b].start + top[b].header + 16;
        if (s < top[b].end) out.fill(0, s, top[b].end);
        notes.push('Zeroed an XMP uuid box without moving sample offsets.');
      }
    }
    notes.unshift(zeroed ? ('Zeroed ' + zeroed + ' HEIF metadata extent(s). The image item was not rewritten.') : 'No HEIF Exif/XMP extents were found to zero.');
    notes.push('HEIC handling is best effort. A re-scan that finds nothing is not a certification.');
    return okResult('heic', 'best-effort', out, notes, true || blocked);
  }

  /* ------------------------------------------------------------------ MP4 / MOV / M4A */

  var MP4_CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, edts: 1, dinf: 1, mvex: 1, moof: 1, traf: 1, udta: 1 };
  var XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
  var QT_NAMES = {
    '\xa9nam': 'Title', '\xa9ART': 'Artist', '\xa9cmt': 'Comment', '\xa9too': 'Encoder',
    '\xa9xyz': 'GPSCoordinates', '\xa9mak': 'Make', '\xa9mod': 'Model', '\xa9day': 'Date',
    '\xa9alb': 'Album', '\xa9gen': 'Genre', '\xa9wrt': 'Composer', 'aART': 'AlbumArtist',
    'slno': 'SerialNumber', '\xa9des': 'Description', '\xa9cpy': 'Copyright'
  };

  function isXmpUuid(bytes, box) {
    var p = box.start + box.header;
    if (p + 16 > box.end) return false;
    for (var i = 0; i < 16; i++) if (bytes[p + i] !== XMP_UUID[i]) return false;
    return true;
  }

  /* ISO files write meta as a FullBox (4 bytes of version and flags before the
     children). QuickTime files often write it as a plain atom with the children
     right after the header. A FullBox starts with 00 00 00 00, which is never a
     valid child size, so the first word tells the two apart. */
  function metaChildStart(bytes, box) {
    var body = box.start + box.header;
    if (body + 8 <= box.end) {
      var first = u32be(bytes, body);
      if (first >= 8 && body + first <= box.end) return body;
    }
    return Math.min(box.end, body + 4);
  }

  function metaIsMetadata(bytes, box) {
    var children = parseBoxes(bytes, metaChildStart(bytes, box), box.end);
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.type === 'ilst' || c.type === 'keys') return true;
      if (c.type === 'hdlr' && c.end >= c.start + c.header + 12) {
        var handler = ascii(bytes, c.start + c.header + 8, 4);
        if (handler === 'mdta' || handler === 'mdir' || handler === 'appl') return true;
      }
    }
    return false;
  }

  function qtPayloadText(payload) {
    if (!payload || !payload.length) return '';
    var start = 0;
    if (payload.length > 4 && payload[0] === 0) start = 4;
    var s = latin1(payload.subarray(start)).replace(/\u0000/g, '').trim();
    if (!s) return '';
    var ok = true;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 32 || c > 126) { ok = false; break; }
    }
    return ok ? s : '';
  }

  function scanQt(bytes) {
    var items = [];
    function walk(start, end) {
      var boxes = parseBoxes(bytes, start, end);
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (QT_NAMES[b.type]) {
          var payload = bytes.subarray(b.start + b.header, b.end);
          var kids = parseBoxes(payload, 0, payload.length);
          var text = '';
          for (var k = 0; k < kids.length; k++) {
            if (kids[k].type === 'data') text = qtPayloadText(payload.subarray(kids[k].start + kids[k].header, kids[k].end));
          }
          if (!text) text = qtPayloadText(payload);
          if (text) items.push(item(QT_NAMES[b.type], text, 'QuickTime', 'MP4 atom'));
        }
        if (b.type === 'uuid' && isXmpUuid(bytes, b)) {
          items.push.apply(items, parseXmp(bytes.subarray(b.start + b.header + 16, b.end), 'MP4 XMP'));
        }
        if (b.type === 'XMP_' || b.type === 'xml ') {
          items.push.apply(items, parseXmp(bytes.subarray(b.start + b.header, b.end), 'MP4 XMP'));
        }
        if (MP4_CONTAINERS[b.type] || b.type === 'ilst') walk(b.start + b.header, b.end);
        else if (b.type === 'meta') {
          var cs = metaChildStart(bytes, b);
          items.push.apply(items, scanQtKeys(bytes, cs, b.end));
          walk(cs, b.end);
        }
      }
    }
    walk(0, bytes.length);
    return items;
  }

  /* Key-based QuickTime metadata (meta > keys + ilst). This is where phones
     write make, model, software, creation date, and the ISO 6709 location. */
  function scanQtKeys(bytes, start, end) {
    var items = [];
    var children = parseBoxes(bytes, start, end);
    var keys = null;
    var ilst = null;
    for (var i = 0; i < children.length; i++) {
      if (children[i].type === 'keys') keys = children[i];
      if (children[i].type === 'ilst') ilst = children[i];
    }
    if (!keys || !ilst) return items;
    var names = [];
    var q = keys.start + keys.header + 8;
    while (q + 8 <= keys.end && names.length < 1000) {
      var ksize = u32be(bytes, q);
      if (ksize < 8 || q + ksize > keys.end) break;
      names.push(latin1(bytes.subarray(q + 8, q + ksize)));
      q += ksize;
    }
    var entries = parseBoxes(bytes, ilst.start + ilst.header, ilst.end);
    for (var e = 0; e < entries.length; e++) {
      var name = names[u32be(bytes, entries[e].start + 4) - 1];
      if (!name) continue;
      var kids = parseBoxes(bytes, entries[e].start + entries[e].header, entries[e].end);
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].type !== 'data') continue;
        var raw = bytes.subarray(Math.min(kids[k].end, kids[k].start + kids[k].header + 8), kids[k].end);
        var text = new TextDecoder('utf-8', { fatal: false }).decode(raw).replace(/[\u0000-\u001f]/g, ' ').trim();
        if (!text || /�/.test(text)) text = '(' + raw.length + ' bytes)';
        items.push(item(name.replace(/^com\.apple\.quicktime\./, ''), text, 'QuickTime', 'MP4 keys'));
      }
    }
    return items;
  }

  function zeroTimes(copy) {
    var header = u32be(copy, 0) === 1 ? 16 : 8;
    if (copy.length < header + 12) return;
    var version = copy[header];
    var n = version === 1 ? 16 : 8;
    if (header + 4 + n > copy.length) return;
    for (var i = 0; i < n; i++) copy[header + 4 + i] = 0;
  }

  /* Boxes that hold file offsets this code does not rewrite: movie fragments,
     segment and fragment indexes, sample auxiliary offsets (encrypted media),
     and item locations. When any is present, nothing may move. */
  var OFFSET_SENSITIVE = { moof: 1, sidx: 1, ssix: 1, mfra: 1, saio: 1, iloc: 1 };

  function hasOffsetSensitiveBox(bytes, start, end, depth) {
    if (depth > 12) return false;
    var boxes = parseBoxes(bytes, start, end);
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (OFFSET_SENSITIVE[b.type]) return true;
      if (b.type === 'udta') continue;
      if (MP4_CONTAINERS[b.type] && hasOffsetSensitiveBox(bytes, b.start + b.header, b.end, depth + 1)) return true;
      if (b.type === 'meta' && hasOffsetSensitiveBox(bytes, metaChildStart(bytes, b), b.end, depth + 1)) return true;
    }
    return false;
  }

  function freeBox(size, header) {
    var f = new Uint8Array(size);
    if (header === 16) {
      setU32be(f, 0, 1);
      setU64be(f, 8, size);
    } else {
      setU32be(f, 0, size);
    }
    f[4] = 0x66; f[5] = 0x72; f[6] = 0x65; f[7] = 0x65;
    return f;
  }

  function stripIsoBmff(bytes, format) {
    var dropped = [];
    var removed = 0;
    /* Offset-sensitive files are scrubbed in place: each metadata box becomes a
       free box of the same size, so every stored offset stays true. */
    var inPlace = hasOffsetSensitiveBox(bytes, 0, bytes.length, 0);
    function shouldDrop(box) {
      if (box.type === 'udta' || box.type === 'XMP_' || box.type === 'xml ') return true;
      if (box.type === 'uuid' && (isXmpUuid(bytes, box) || indexOfBytes(bytes.subarray(box.start, box.end), fromLatin1('<?xpacket')) >= 0)) return true;
      if (box.type === 'meta' && metaIsMetadata(bytes, box)) return true;
      return false;
    }
    function rebuildRange(start, end) {
      var boxes = parseBoxes(bytes, start, end);
      if (!boxes.length) return bytes.subarray(start, end);
      var parts = [];
      var cursor = start;
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.start > cursor) parts.push(bytes.subarray(cursor, b.start));
        if (shouldDrop(b)) {
          removed++;
          if (inPlace) parts.push(freeBox(b.end - b.start, b.header));
          else dropped.push([b.start, b.end]);
        } else if (MP4_CONTAINERS[b.type] || b.type === 'meta') {
          var childStart = b.type === 'meta' ? metaChildStart(bytes, b) : b.start + b.header;
          var inner = rebuildRange(childStart, b.end);
          /* Keep the header the size it was (8 bytes, or 16 with a 64-bit size).
             Shortening it would move everything after it without the offset map knowing. */
          var headRest = bytes.subarray(b.start + b.header, childStart);
          var size = b.header + headRest.length + inner.length;
          var hdr = new Uint8Array(b.header);
          if (b.header === 16) {
            setU32be(hdr, 0, 1);
            setU64be(hdr, 8, size);
          } else {
            if (size > 0xffffffff) throw new Error('A container box is too large to rewrite.');
            setU32be(hdr, 0, size);
          }
          hdr.set(bytes.subarray(b.start + 4, b.start + 8), 4);
          parts.push(hdr, headRest, inner);
        } else if (b.type === 'mvhd' || b.type === 'tkhd' || b.type === 'mdhd') {
          var copy = bytes.slice(b.start, b.end);
          zeroTimes(copy);
          parts.push(copy);
        } else {
          parts.push(bytes.subarray(b.start, b.end));
        }
        cursor = b.end;
      }
      if (cursor < end) parts.push(bytes.subarray(cursor, end));
      return concat(parts);
    }
    var out = rebuildRange(0, bytes.length);
    dropped.sort(function (a, b) { return a[0] - b[0]; });
    function mapOffset(off) {
      var shift = 0;
      for (var i = 0; i < dropped.length; i++) {
        if (dropped[i][1] <= off) shift += dropped[i][1] - dropped[i][0];
        else break;
      }
      return off - shift;
    }
    function fix(start, end) {
      var boxes = parseBoxes(out, start, end);
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.type === 'stco' || b.type === 'co64') {
          var p = b.start + b.header;
          if (p + 8 > b.end) continue;
          var wide = b.type === 'co64';
          /* The entry count is file data. Never walk past the end of the box. */
          var count = Math.min(u32be(out, p + 4), Math.floor((b.end - (p + 8)) / (wide ? 8 : 4)));
          for (var n = 0; n < count; n++) {
            var at = p + 8 + n * (wide ? 8 : 4);
            var old = wide ? u64be(out, at) : u32be(out, at);
            var neu = mapOffset(old);
            if (wide) setU64be(out, at, neu);
            else setU32be(out, at, neu);
          }
        } else if (MP4_CONTAINERS[b.type]) fix(b.start + b.header, b.end);
        else if (b.type === 'meta') fix(metaChildStart(out, b), b.end);
      }
    }
    if (dropped.length) fix(0, out.length);
    var notes = [];
    if (removed && inPlace) notes.push('Overwrote ' + removed + ' metadata box(es) (user data, iTunes meta, and/or XMP uuid) with free space of the same size. This file stores offsets this tool does not rewrite (fragments, indexes, or encryption data), so nothing was moved.');
    else if (removed) notes.push('Removed ' + removed + ' metadata box(es) (user data, iTunes meta, and/or XMP uuid) and rewrote chunk offsets.');
    else notes.push('No udta, iTunes meta, or XMP uuid boxes were present.');
    notes.push('Creation and modification times in mvhd, tkhd, and mdhd were set to zero.');
    notes.push('MP4, MOV, and M4A handling is best effort. Timed metadata stored as media samples can remain. This result is not a certification.');
    return okResult(format, 'best-effort', out, notes, true);
  }

  /* ------------------------------------------------------------------ MP3 */

  function syncsafe(b, o) {
    return ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);
  }

  function decodeId3Raw(data) {
    if (!data.length) return '';
    var enc = data[0];
    var rest = data.subarray(1);
    try {
      if (enc === 0) return latin1(rest);
      if (enc === 3) return new TextDecoder('utf-8').decode(rest);
      if (enc === 2) return new TextDecoder('utf-16be').decode(rest);
      if (enc === 1) return new TextDecoder('utf-16').decode(rest);
    } catch (e) { /* fall through */ }
    return latin1(rest);
  }

  function decodeId3Text(data) {
    if (!data.length) return '';
    var enc = data[0];
    var rest = data.subarray(1);
    try {
      if (enc === 0) return latin1(rest).replace(/\u0000/g, '').trim();
      if (enc === 3) return new TextDecoder('utf-8').decode(rest).replace(/\u0000/g, '').trim();
      if (enc === 2) return new TextDecoder('utf-16be').decode(rest).replace(/\u0000/g, '').trim();
      if (enc === 1) return new TextDecoder('utf-16').decode(rest).replace(/\u0000/g, '').trim();
    } catch (e) { /* fall through */ }
    return latin1(rest).replace(/\u0000/g, '').trim();
  }

  function scanId3(bytes) {
    var items = [];
    if (ascii(bytes, 0, 3) !== 'ID3') return items;
    var ver = bytes[3];
    var flags = bytes[5];
    var size = syncsafe(bytes, 6);
    var pos = 10;
    var end = Math.min(bytes.length, 10 + size);
    if (flags & 0x40) {
      if (ver === 4) pos += syncsafe(bytes, pos) ;
      else if (pos + 4 <= end) pos += 4 + u32be(bytes, pos);
    }
    if (ver === 3) {
      /* extended header size includes itself on some writers; already handled loosely */
    }
    while (pos + (ver === 2 ? 6 : 10) <= end) {
      var id, fsize, frameStart;
      if (ver === 2) {
        if (pos + 6 > end) break;
        id = ascii(bytes, pos, 3);
        if (id === '\x00\x00\x00') break;
        fsize = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
        frameStart = pos + 6;
      } else {
        id = ascii(bytes, pos, 4);
        if (id === '\x00\x00\x00\x00' || id === '') break;
        fsize = ver === 4 ? syncsafe(bytes, pos + 4) : u32be(bytes, pos + 4);
        frameStart = pos + 10;
      }
      if (!fsize || frameStart + fsize > end) break;
      var data = bytes.subarray(frameStart, frameStart + fsize);
      if (id === 'TXX' || id === 'TXXX') {
        var bits = decodeId3Raw(data).split('\u0000').map(function (s) { return s.trim(); }).filter(Boolean);
        if (bits.length) items.push(item(bits[0], bits[1] || bits[0], 'ID3', 'ID3v2'));
      } else if (id.charAt(0) === 'T') {
        var text = decodeId3Text(data);
        if (text) items.push(item(id, text, 'ID3', 'ID3v2'));
      } else if (id === 'COMM' || id === 'COM') {
        var text3 = decodeId3Text(data.subarray(data.length > 3 ? 3 : 0));
        if (text3) items.push(item('Comment', text3, 'ID3', 'ID3v2'));
      } else if (id === 'APIC' || id === 'PIC' || id === 'PRIV' || id === 'GEOB') {
        items.push(item(id, 'Binary frame (' + fsize + ' bytes)', 'ID3', 'ID3v2'));
      }
      pos = frameStart + fsize;
    }
    if (bytes.length >= 128 && ascii(bytes, bytes.length - 128, 3) === 'TAG') {
      var base = bytes.length - 128;
      var title = latin1(bytes.subarray(base + 3, base + 33)).replace(/\u0000/g, '').trim();
      var artist = latin1(bytes.subarray(base + 33, base + 63)).replace(/\u0000/g, '').trim();
      var album = latin1(bytes.subarray(base + 63, base + 93)).replace(/\u0000/g, '').trim();
      var year = latin1(bytes.subarray(base + 93, base + 97)).replace(/\u0000/g, '').trim();
      var comment = latin1(bytes.subarray(base + 97, base + 125)).replace(/\u0000/g, '').trim();
      if (title) items.push(item('Title', title, 'ID3', 'ID3v1'));
      if (artist) items.push(item('Artist', artist, 'ID3', 'ID3v1'));
      if (album) items.push(item('Album', album, 'ID3', 'ID3v1'));
      if (year) items.push(item('Year', year, 'ID3', 'ID3v1'));
      if (comment) items.push(item('Comment', comment, 'ID3', 'ID3v1'));
    }
    return items;
  }

  /* Tags the ID3 reader does not parse still have to show up in the scan.
     Otherwise a tag the stripper failed to remove would pass the re-scan. */
  function scanMp3(bytes) {
    var items = scanId3(bytes);
    if (indexOfBytes(bytes, fromLatin1('APETAGEX')) >= 0) items.push(item('APE tag', 'APE tag present', 'APE', 'APE tag'));
    if (indexOfBytes(bytes, fromLatin1('LYRICSBEGIN')) >= 0) items.push(item('Lyrics3 tag', 'Lyrics3 tag present', 'Lyrics3', 'Lyrics3 tag'));
    if (bytes.length >= 227 + 128 && ascii(bytes, bytes.length - 128 - 227, 4) === 'TAG+') items.push(item('Extended ID3v1 tag', 'Extended ID3v1 tag present', 'ID3', 'ID3v1'));
    return items;
  }

  function id3v2Size(bytes, at, end) {
    if (at + 10 > end || ascii(bytes, at, 3) !== 'ID3') return 0;
    if (bytes[at + 3] === 0xff || bytes[at + 4] === 0xff) return 0;
    if ((bytes[at + 6] | bytes[at + 7] | bytes[at + 8] | bytes[at + 9]) & 0x80) return 0;
    return 10 + syncsafe(bytes, at + 6) + ((bytes[at + 5] & 0x10) ? 10 : 0);
  }

  function stripMp3(bytes) {
    var start = 0;
    var end = bytes.length;
    var notes = [];
    /* Files that were tagged twice carry more than one ID3v2 tag in a row. */
    for (var guard = 0; guard < 16; guard++) {
      var tagLen = id3v2Size(bytes, start, end);
      if (!tagLen) break;
      if (start + tagLen > end) throw new Error('ID3 tag extends past the end of the file.');
      start += tagLen;
      notes.push('Removed ID3v2 tag (' + tagLen + ' bytes).');
    }
    if (end - start >= 128 && ascii(bytes, end - 128, 3) === 'TAG') {
      end -= 128;
      notes.push('Removed ID3v1 tag.');
      if (end - start >= 227 && ascii(bytes, end - 227, 4) === 'TAG+') {
        end -= 227;
        notes.push('Removed extended ID3v1 tag.');
      }
    }
    if (end - start >= 15 && ascii(bytes, end - 9, 9) === 'LYRICS200') {
      var lyr = parseInt(ascii(bytes, end - 15, 6), 10);
      if (lyr > 0 && lyr + 15 < end - start && ascii(bytes, end - 15 - lyr, 11) === 'LYRICSBEGIN') {
        end -= lyr + 15;
        notes.push('Removed Lyrics3 tag.');
      }
    }
    if (end - start >= 32 && ascii(bytes, end - 32, 8) === 'APETAGEX') {
      var tagSize = u32le(bytes, end - 32 + 12);
      var flags = u32le(bytes, end - 32 + 20);
      var hasHeader = flags & 0x80000000;
      var remove = tagSize + (hasHeader ? 32 : 0);
      if (remove > 0 && remove < end - start) {
        end -= remove;
        notes.push('Removed APEv2 tag.');
      }
    }
    if (!notes.length) notes.push('No ID3 or APE tag was present.');
    var out = bytes.slice(start, end);
    if (!out.length) throw new Error('Stripping the tags left no audio frames. The file was not modified.');
    return okResult('mp3', 'full', out, notes, false);
  }

  function looksLikeMp3(bytes) {
    if (ascii(bytes, 0, 3) === 'ID3') return true;
    if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
    var ver = (bytes[1] >> 3) & 3;
    var layer = (bytes[1] >> 1) & 3;
    var br = (bytes[2] >> 4) & 15;
    var sr = (bytes[2] >> 2) & 3;
    if (ver === 1 || layer === 0 || br === 0 || br === 15 || sr === 3) return false;
    return true;
  }

  /* ------------------------------------------------------------------ ZIP / Office / ODF */

  var MAX_ZIP_TOTAL = 1024 * 1024 * 1024;

  async function readZip(bytes) {
    var eocd = -1;
    var min = Math.max(0, bytes.length - 65557);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory was not found.');
    var entries = u16le(bytes, eocd + 10);
    var cdOff = u32le(bytes, eocd + 16);
    if (u16le(bytes, eocd + 4) !== 0 || u16le(bytes, eocd + 6) !== 0 || entries === 0xffff || cdOff === 0xffffffff ||
        (eocd >= 20 && ascii(bytes, eocd - 20, 4) === 'PK\x06\x07')) {
      throw new Error('ZIP64 and multi-part archives are not supported.');
    }
    var out = [];
    var p = cdOff;
    var budget = MAX_ZIP_TOTAL;
    for (var n = 0; n < entries; n++) {
      if (p + 46 > bytes.length || ascii(bytes, p, 4) !== 'PK\x01\x02') throw new Error('Bad ZIP central directory.');
      var flags = u16le(bytes, p + 8);
      var method = u16le(bytes, p + 10);
      var wantCrc = u32le(bytes, p + 16);
      var compSize = u32le(bytes, p + 20);
      var fullSize = u32le(bytes, p + 24);
      var nameLen = u16le(bytes, p + 28);
      var extraLen = u16le(bytes, p + 30);
      var commentLen = u16le(bytes, p + 32);
      var localOff = u32le(bytes, p + 42);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      /* An encrypted entry would otherwise be copied as if it were plain data
         and written back without its encryption flag. */
      if (flags & 1) throw new Error('This ZIP has encrypted entries.');
      if (compSize === 0xffffffff || fullSize === 0xffffffff || localOff === 0xffffffff) throw new Error('ZIP64 and multi-part archives are not supported.');
      if (localOff + 30 > bytes.length || ascii(bytes, localOff, 4) !== 'PK\x03\x04') throw new Error('Bad ZIP local header for ' + name);
      var lname = u16le(bytes, localOff + 26);
      var lextra = u16le(bytes, localOff + 28);
      var dataStart = localOff + 30 + lname + lextra;
      if (dataStart + compSize > bytes.length) throw new Error('ZIP entry ' + name + ' runs past the end of the file.');
      /* Total expanded size is capped so a small archive cannot exhaust memory. */
      if (fullSize > budget) throw new Error('This ZIP expands past the ' + Math.round(MAX_ZIP_TOTAL / 1048576) + ' MB safety limit.');
      var comp = bytes.subarray(dataStart, dataStart + compSize);
      var data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = await inflate(comp, 'deflate-raw', Math.max(1, fullSize));
      else throw new Error('Unsupported ZIP compression method ' + method + ' in ' + name);
      /* The declared size and checksum must match what was read. If they do not,
         the archive is damaged or built to confuse, and rewriting it is a guess. */
      if (data.length !== fullSize) throw new Error('ZIP entry ' + name + ' does not match its declared size.');
      if (crc32(data) !== wantCrc) throw new Error('ZIP entry ' + name + ' failed its checksum.');
      budget -= data.length;
      out.push({ name: name, data: data });
    }
    return out;
  }

  function writeZip(entries) {
    var parts = [];
    var central = [];
    var offset = 0;
    var enc = new TextEncoder();
    /* No ZIP64 here, so the classic limits are hard limits. Past them the
       header fields wrap and the archive is silently corrupt. */
    if (entries.length > 0xfffe) throw new Error('Too many files for one ZIP.');
    /* 1980-01-01 00:00. A zero date is not a valid DOS date, and the real
       time would be one more thing the output says about when it was made. */
    var DOS_DATE = 0x0021;
    for (var i = 0; i < entries.length; i++) {
      var nameBytes = enc.encode(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      /* Bit 11 says the name is UTF-8. Without it, readers decode non-ASCII
         names as CP437 and show the wrong characters. */
      var gp = 0;
      for (var nb = 0; nb < nameBytes.length; nb++) if (nameBytes[nb] > 127) { gp = 0x0800; break; }
      if (nameBytes.length > 0xffff) throw new Error('A file name is too long for a ZIP.');
      if (data.length > 0xfffffffe || offset + 30 + nameBytes.length + data.length > 0xfffffffe) throw new Error('The files are too large for one ZIP (4 GB limit).');
      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, gp, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(12, DOS_DATE, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      parts.push(local, data);
      var c = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, gp, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      c.set(nameBytes, 46);
      central.push(c);
      offset += local.length + data.length;
    }
    var cdSize = 0;
    for (var k = 0; k < central.length; k++) cdSize += central[k].length;
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return concat(parts.concat(central, [eocd]));
  }

  var EMPTY_ODF_META = fromLatin1(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2"><office:meta/></office:document-meta>\n'
  );

  /* Names and account identifiers that Office writes outside docProps:
     comment and revision authors, initials, sign-in ids, the comment author
     lists of PowerPoint and Excel, and the local folder path Excel records
     (which usually contains the Windows user name). Values are blanked, not
     removed, so every index and reference in the document still resolves. */
  var OFFICE_SCRUB = [
    { re: /\b((?:[A-Za-z0-9]+:)?(?:author|initials|userId|userName|lastModifiedBy))=(?:"[^"]*"|'[^']*')/g, to: '$1=""' },
    { file: /(?:commentAuthors|(?:^|\/)authors)\.xml$/i, re: /\b(name)=(?:"[^"]*"|'[^']*')/g, to: '$1=""' },
    { file: /persons\/[^\/]*\.xml$/i, re: /\b(displayName)=(?:"[^"]*"|'[^']*')/g, to: '$1=""' },
    { file: /comments?\d*\.xml$/i, re: /(<(?:[A-Za-z0-9]+:)?author(?:\s[^<>]*)?>)[^<]*(<\/(?:[A-Za-z0-9]+:)?author>)/g, to: '$1$2' },
    { re: /<mc:AlternateContent\b[^>]*>\s*<mc:Choice\b[^>]*>\s*<x15ac:absPath\b[^>]*\/>\s*<\/mc:Choice>\s*<\/mc:AlternateContent>/g, to: '' },
    { re: /(<x15ac:absPath\b[^>]*\burl=)(?:"[^"]*"|'[^']*')/g, to: '$1""' }
  ];
  /* The same idea for OpenDocument: change-tracking and annotation authors
     live in content.xml and styles.xml, not in meta.xml. */
  var ODF_SCRUB = [
    { re: /(<dc:creator>)[^<]*(<\/dc:creator>)/g, to: '$1$2' },
    { re: /(<meta:creator-initials>)[^<]*(<\/meta:creator-initials>)/g, to: '$1$2' }
  ];

  /* What the scrub rules above target, as report rows. The scan and the
     scrub have to agree, or the re-scan cannot vouch for the scrub. */
  function officeIdentityItems(name, text, label, odf) {
    var items = [];
    var m;
    function add(tag, value) {
      value = String(value || '').trim();
      if (value && items.length < 40) items.push(item(tag, value, label, name));
    }
    if (odf) {
      if (/^(?:content|styles)\.xml$/i.test(name)) {
        var oc = /<(?:dc:(creator)|meta:(creator-initials))>([^<]+)</g;
        while ((m = oc.exec(text))) add(m[1] || m[2], m[3]);
      }
      return items;
    }
    var attr = /\b(?:[A-Za-z0-9]+:)?(author|initials|userId|userName|lastModifiedBy)=(?:"([^"]+)"|'([^']+)')/g;
    while ((m = attr.exec(text))) add(m[1], m[2] != null ? m[2] : m[3]);
    if (/(?:commentAuthors|(?:^|\/)authors)\.xml$/i.test(name)) {
      var nm = /\bname=(?:"([^"]+)"|'([^']+)')/g;
      while ((m = nm.exec(text))) add('author', m[1] != null ? m[1] : m[2]);
    }
    if (/persons\/[^\/]*\.xml$/i.test(name)) {
      var dn = /\bdisplayName=(?:"([^"]+)"|'([^']+)')/g;
      while ((m = dn.exec(text))) add('author', m[1] != null ? m[1] : m[2]);
    }
    if (/comments?\d*\.xml$/i.test(name)) {
      var au = /<(?:[A-Za-z0-9]+:)?author(?:\s[^<>]*)?>([^<]+)</g;
      while ((m = au.exec(text))) add('author', m[1]);
    }
    var ap = /<x15ac:absPath\b[^>]*\burl=(?:"([^"]+)"|'([^']+)')/g;
    while ((m = ap.exec(text))) add('absPath', m[1] != null ? m[1] : m[2]);
    return items;
  }

  function scrubOdfXml(data) {
    var text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    var next = text;
    for (var r = 0; r < ODF_SCRUB.length; r++) next = next.replace(ODF_SCRUB[r].re, ODF_SCRUB[r].to);
    if (next === text) return null;
    return new TextEncoder().encode(next);
  }

  function scrubOfficeXml(name, data) {
    var text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    var orig = text;
    var notes = [];
    /* Only the three property parts are removed, so only their entries go.
       Both spellings of an empty element are matched: a relationship left
       pointing at a deleted part makes Office report the file as damaged. */
    if (name === '[Content_Types].xml') {
      text = text.replace(/<Override\b[^>]*PartName="\/docProps\/(?:core|app|custom)\.xml"[^>]*?(?:\/>|>\s*<\/Override>)/gi, '');
    }
    if (/\.rels$/i.test(name)) {
      text = text.replace(/<Relationship\b[^>]*(?:docProps\/(?:core|app|custom)\.xml|core-properties|extended-properties|custom-properties)[^>]*?(?:\/>|>\s*<\/Relationship>)/gi, '');
    }
    if (/\.(xml|rels)$/i.test(name)) {
      var next = text;
      for (var r = 0; r < OFFICE_SCRUB.length; r++) {
        if (OFFICE_SCRUB[r].file && !OFFICE_SCRUB[r].file.test(name)) continue;
        next = next.replace(OFFICE_SCRUB[r].re, OFFICE_SCRUB[r].to);
      }
      if (next !== text) notes.push('Cleared author and user identifiers in ' + name);
      text = next;
    }
    if (text === orig) return { changed: false, data: data, notes: notes };
    notes.unshift('Updated ' + name);
    return { changed: true, data: new TextEncoder().encode(text), notes: notes };
  }

  function classifyZip(entries) {
    var mime = null;
    var ct = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === 'mimetype') mime = latin1(entries[i].data);
      if (entries[i].name === '[Content_Types].xml') ct = new TextDecoder('utf-8', { fatal: false }).decode(entries[i].data);
    }
    if (mime) {
      if (mime.indexOf('opendocument.text') >= 0) return fmt('odt', 'ODT', 'full', 'application/vnd.oasis.opendocument.text');
      if (mime.indexOf('opendocument.spreadsheet') >= 0) return fmt('ods', 'ODS', 'full', 'application/vnd.oasis.opendocument.spreadsheet');
      if (mime.indexOf('opendocument.presentation') >= 0) return fmt('odp', 'ODP', 'full', 'application/vnd.oasis.opendocument.presentation');
    }
    if (ct) {
      if (ct.indexOf('wordprocessingml') >= 0) return fmt('docx', 'DOCX', 'full', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (ct.indexOf('spreadsheetml') >= 0) return fmt('xlsx', 'XLSX', 'full', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (ct.indexOf('presentationml') >= 0) return fmt('pptx', 'PPTX', 'full', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    }
    return fmt('zip', 'ZIP', 'unsupported', 'application/zip');
  }

  async function scanOffice(bytes, depth) {
    depth = depth || 0;
    var entries = await readZip(bytes);
    var kind = classifyZip(entries);
    var odf = kind.format === 'odt' || kind.format === 'ods' || kind.format === 'odp';
    var items = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var lower = e.name.toLowerCase();
      if (/docprops\/.*\.xml$/.test(lower) || lower === 'meta.xml') {
        var text = new TextDecoder('utf-8', { fatal: false }).decode(e.data);
        var re = /<([A-Za-z0-9]+):([A-Za-z0-9]+)>([^<]{1,500})<\/\1:\2>/g;
        var m;
        while ((m = re.exec(text))) {
          var value = m[3].trim();
          if (!value) continue;
          items.push(item(m[2], value, kind.label, e.name));
        }
      }
      if (/\.(xml|rels)$/i.test(e.name)) {
        var xml = new TextDecoder('utf-8', { fatal: false }).decode(e.data);
        items.push.apply(items, officeIdentityItems(e.name, xml, kind.label, odf));
      }
      /* Embedded parts are scanned with the full detector, so a workbook
         behind a chart or a document inside a document is opened too. Before,
         nested packages were skipped and could not hold back a clear result. */
      var nested = await detect(e.data);
      if (nested.support === 'full' || nested.support === 'best-effort') {
        if (depth >= MAX_NESTING) {
          items.push(item('Embedded file', 'Nested too deeply to scan', kind.label, e.name));
          continue;
        }
        var sub = await scan(e.data, depth + 1);
        for (var s = 0; s < sub.items.length; s++) {
          sub.items[s].source = e.name + ' → ' + sub.items[s].source;
          items.push(sub.items[s]);
        }
      }
    }
    return items;
  }

  async function stripOffice(bytes, kind, depth) {
    var entries = await readZip(bytes);
    var notes = [];
    var kept = [];
    var odf = kind.format === 'odt' || kind.format === 'ods' || kind.format === 'odp';
    var blocksClear = false;
    if (odf) {
      for (var m = 0; m < entries.length; m++) {
        /* An encrypted package lists every part as encrypted in its manifest.
           Swapping in a plain meta.xml would leave a file that cannot be opened. */
        if (entries[m].name === 'META-INF/manifest.xml' && indexOfBytes(entries[m].data, fromLatin1('encryption-data')) >= 0) {
          throw new Error('Password-protected OpenDocument files are not supported.');
        }
      }
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var lower = e.name.toLowerCase();
      if (!odf && /^docprops\/(core|app|custom)\.xml$/.test(lower)) {
        notes.push('Removed ' + e.name);
        continue;
      }
      var data = e.data;
      if (odf && lower === 'meta.xml') {
        data = EMPTY_ODF_META;
        notes.push('Replaced meta.xml with an empty office:meta element.');
      } else if (odf && (lower === 'content.xml' || lower === 'styles.xml')) {
        var odfScrub = scrubOdfXml(data);
        if (odfScrub) {
          data = odfScrub;
          notes.push('Cleared change-tracking and comment author names in ' + e.name);
        }
      } else if (!odf && /\.(xml|rels)$/i.test(e.name)) {
        var scrub = scrubOfficeXml(e.name, data);
        if (scrub.changed) {
          data = scrub.data;
          notes.push.apply(notes, scrub.notes);
        }
      }
      /* Embedded pictures, media, PDFs, and whole embedded documents go through
         the same strippers. A part that could not be stripped, or that only has
         best-effort support, keeps the package from being reported as clear. */
      var nested = await detect(data);
      if (nested.support === 'full' || nested.support === 'best-effort') {
        var stripped = await stripLossless(data, depth + 1);
        if (stripped.ok) {
          data = stripped.bytes;
          notes.push('Stripped embedded ' + e.name + ' (' + nested.label + ')');
          if (stripped.support !== 'full' || stripped.blocksClear) blocksClear = true;
        } else {
          notes.push('Left embedded ' + e.name + ' (' + nested.label + ') as it was: ' + stripped.reason);
          blocksClear = true;
        }
      }
      kept.push({ name: e.name, data: data });
    }
    if (odf) {
      kept.sort(function (a, b) {
        if (a.name === 'mimetype') return -1;
        if (b.name === 'mimetype') return 1;
        return 0;
      });
    }
    if (!notes.length) notes.push('No document properties were found.');
    return okResult(kind.format, 'full', writeZip(kept), notes, blocksClear);
  }

  /* ------------------------------------------------------------------ PDF */

  function isWs(c) { return c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32; }
  function isDelim(c) {
    return isWs(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  }
  function skipWs(bytes, i) {
    while (i < bytes.length) {
      if (bytes[i] === 37) { while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; }
      if (!isWs(bytes[i])) break;
      i++;
    }
    return i;
  }
  function matchKw(bytes, i, word) {
    for (var k = 0; k < word.length; k++) if (bytes[i + k] !== word.charCodeAt(k)) return false;
    return isDelim(bytes[i + word.length]) || i + word.length >= bytes.length;
  }
  function readPdfNumber(bytes, i) {
    var start = i;
    if (bytes[i] === 43 || bytes[i] === 45) i++;
    while (i < bytes.length && bytes[i] >= 48 && bytes[i] <= 57) i++;
    if (bytes[i] === 46) { i++; while (i < bytes.length && bytes[i] >= 48 && bytes[i] <= 57) i++; }
    var num = parseFloat(latin1(bytes.subarray(start, i)));
    return { num: num, end: i };
  }
  function readNameToken(bytes, i) {
    var start = i + 1;
    var j = start;
    while (j < bytes.length && !isDelim(bytes[j])) j++;
    var raw = latin1(bytes.subarray(start, j));
    var name = raw.replace(/#([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    return { name: name, raw: raw, end: j };
  }
  function parsePdfValue(bytes, i) {
    i = skipWs(bytes, i);
    var start = i;
    var c = bytes[i];
    if (c === 60) {
      if (bytes[i + 1] === 60) {
        i += 2;
        var entries = [];
        while (i < bytes.length) {
          i = skipWs(bytes, i);
          if (bytes[i] === 62 && bytes[i + 1] === 62) { i += 2; break; }
          if (bytes[i] !== 47) throw new Error('PDF dictionary key was not a name.');
          var name = readNameToken(bytes, i); i = name.end;
          var val = parsePdfValue(bytes, i); i = val.end;
          entries.push({ name: name.name, nameRaw: name.raw, value: val.value });
        }
        var dict = { type: 'dict', entries: entries, raw: bytes.subarray(start, i) };
        dict.get = function (n) {
          for (var k = 0; k < entries.length; k++) if (entries[k].name === n) return entries[k].value;
          return null;
        };
        return { value: dict, end: i };
      }
      i++;
      while (i < bytes.length && bytes[i] !== 62) i++;
      return { value: { type: 'hex', raw: bytes.subarray(start, i + 1) }, end: i + 1 };
    }
    if (c === 91) {
      i++;
      var items = [];
      while (i < bytes.length) {
        i = skipWs(bytes, i);
        if (bytes[i] === 93) { i++; break; }
        var v = parsePdfValue(bytes, i); i = v.end;
        items.push(v.value);
      }
      return { value: { type: 'array', items: items, raw: bytes.subarray(start, i) }, end: i };
    }
    if (c === 40) {
      i++;
      var depth = 1;
      while (i < bytes.length && depth) {
        if (bytes[i] === 92) { i += 2; continue; }
        if (bytes[i] === 40) depth++;
        else if (bytes[i] === 41) depth--;
        if (depth) i++;
        else i++;
      }
      return { value: { type: 'string', raw: bytes.subarray(start, i) }, end: i };
    }
    if (c === 47) {
      var nm = readNameToken(bytes, i);
      return { value: { type: 'name', name: nm.name, raw: bytes.subarray(start, nm.end) }, end: nm.end };
    }
    if (c === 43 || c === 45 || c === 46 || (c >= 48 && c <= 57)) {
      var num = readPdfNumber(bytes, i);
      var j = skipWs(bytes, num.end);
      if (bytes[j] === 43 || bytes[j] === 45 || (bytes[j] >= 48 && bytes[j] <= 57)) {
        var num2 = readPdfNumber(bytes, j);
        var k = skipWs(bytes, num2.end);
        if (bytes[k] === 82 && (k + 1 >= bytes.length || isDelim(bytes[k + 1]))) {
          return { value: { type: 'ref', id: num.num, gen: num2.num, raw: bytes.subarray(start, k + 1) }, end: k + 1 };
        }
      }
      return { value: { type: 'number', num: num.num, raw: bytes.subarray(start, num.end) }, end: num.end };
    }
    var ks = i;
    while (i < bytes.length && !isDelim(bytes[i])) i++;
    /* A stray delimiter (or the end of the data) yields no token. Returning an
       empty one made the array and dictionary loops spin forever on bad input. */
    if (i === ks) throw new Error('Unexpected character in PDF object at offset ' + ks + '.');
    return { value: { type: 'keyword', word: latin1(bytes.subarray(ks, i)), raw: bytes.subarray(ks, i) }, end: i };
  }

  function emitDict(dict, omit, replace) {
    var s = '<<';
    for (var i = 0; i < dict.entries.length; i++) {
      var e = dict.entries[i];
      if (omit && omit[e.name]) continue;
      s += ' /' + e.nameRaw + ' ';
      if (replace && replace[e.name] != null) s += replace[e.name];
      else s += latin1(e.value.raw);
    }
    s += ' >>';
    return s;
  }

  function undoPredictor(data, columns, predictor) {
    if (!predictor || predictor === 1) return data;
    var out, i, left;
    if (predictor === 2) {
      out = new Uint8Array(data.length);
      for (i = 0; i < data.length; i++) {
        left = (i % columns) ? out[i - 1] : 0;
        out[i] = (data[i] + left) & 255;
      }
      return out;
    }
    if (predictor >= 10 && predictor <= 15) {
      var rowIn = columns + 1;
      var rows = Math.floor(data.length / rowIn);
      out = new Uint8Array(rows * columns);
      var prev = new Uint8Array(columns);
      for (var r = 0; r < rows; r++) {
        var filter = data[r * rowIn];
        var src = r * rowIn + 1;
        var dst = r * columns;
        for (var c = 0; c < columns; c++) {
          var L = c ? out[dst + c - 1] : 0;
          var up = prev[c];
          var ul = c ? prev[c - 1] : 0;
          var v = data[src + c];
          if (filter === 1) v = (v + L) & 255;
          else if (filter === 2) v = (v + up) & 255;
          else if (filter === 3) v = (v + ((L + up) >> 1)) & 255;
          else if (filter === 4) {
            var p = L + up - ul;
            var pa = Math.abs(p - L), pb = Math.abs(p - up), pc = Math.abs(p - ul);
            var pr = (pa <= pb && pa <= pc) ? L : (pb <= pc ? up : ul);
            v = (v + pr) & 255;
          }
          out[dst + c] = v;
        }
        prev = out.subarray(dst, dst + columns);
      }
      return out;
    }
    throw new Error('Unsupported PDF predictor ' + predictor);
  }

  /* Checks that a stream of the stated length really ends in "endstream" and
     returns the offset after it. A wrong /Length is common in damaged files.
     Trusting it would copy a stream that is too short or too long. */
  function streamEnd(bytes, streamStart, length, id) {
    if (!(length >= 0) || length !== Math.floor(length) || streamStart + length > bytes.length) {
      throw new Error('PDF stream ' + id + ' has a length that does not fit the file.');
    }
    var i = streamStart + length;
    while (i < bytes.length && isWs(bytes[i])) i++;
    if (!matchKw(bytes, i, 'endstream')) throw new Error('PDF stream ' + id + ' does not end where its length says.');
    return skipWs(bytes, i + 9);
  }

  function readPdfObject(bytes, offset) {
    var i = skipWs(bytes, offset);
    var start = i;
    var id = readPdfNumber(bytes, i); i = skipWs(bytes, id.end);
    var gen = readPdfNumber(bytes, i); i = skipWs(bytes, gen.end);
    if (!matchKw(bytes, i, 'obj')) throw new Error('Expected obj at offset ' + offset);
    i += 3;
    var parsed = parsePdfValue(bytes, i);
    i = skipWs(bytes, parsed.end);
    var stream = null;
    var streamStart = 0;
    var lengthIndirect = false;
    var lengthDirect = null;
    if (matchKw(bytes, i, 'stream')) {
      i += 6;
      if (bytes[i] === 13) i++;
      if (bytes[i] === 10) i++;
      streamStart = i;
      var lenVal = parsed.value.type === 'dict' ? parsed.value.get('Length') : null;
      if (lenVal && lenVal.type === 'number') lengthDirect = lenVal.num;
      else if (lenVal && lenVal.type === 'ref') lengthIndirect = true;
      else throw new Error('Stream is missing a length.');
      if (lengthDirect != null) {
        i = streamEnd(bytes, streamStart, lengthDirect, id.num);
        stream = bytes.slice(streamStart, streamStart + lengthDirect);
      }
    }
    if (!lengthIndirect) {
      /* The object is copied out byte for byte, so its end has to be known.
         Guessing here used to produce a cut-off object in the output. */
      if (!matchKw(bytes, i, 'endobj')) throw new Error('PDF object ' + id.num + ' has no endobj where one is expected.');
      i += 6;
      return {
        id: id.num, gen: gen.num, start: start, end: i, value: parsed.value,
        stream: stream, raw: bytes.slice(start, i), lengthIndirect: false, streamStart: streamStart
      };
    }
    return {
      id: id.num, gen: gen.num, start: start, end: null, value: parsed.value,
      stream: null, raw: null, lengthIndirect: true, streamStart: streamStart
    };
  }

  function finishIndirect(bytes, obj, objects) {
    if (!obj.lengthIndirect) return;
    var lenVal = obj.value.get('Length');
    var nobj = objects.get(lenVal.id);
    if (!nobj || nobj.value.type !== 'number') throw new Error('Indirect stream length could not be resolved.');
    var length = nobj.value.num;
    var i = streamEnd(bytes, obj.streamStart, length, obj.id);
    obj.stream = bytes.slice(obj.streamStart, obj.streamStart + length);
    if (!matchKw(bytes, i, 'endobj')) throw new Error('PDF object ' + obj.id + ' has no endobj where one is expected.');
    i += 6;
    obj.end = i;
    obj.raw = bytes.slice(obj.start, i);
    obj.lengthIndirect = false;
  }

  async function decodeStream(obj) {
    var data = obj.stream;
    /* /Filter may be a name or an array holding one name. Both mean the same. */
    var filters = filtersOf(obj.value);
    if (filters.length > 1 || (filters.length === 1 && filters[0] !== 'FlateDecode' && filters[0] !== 'Fl')) {
      throw new Error('Unsupported PDF filter ' + filters.join(' + '));
    }
    if (filters.length === 1) data = await inflate(data, 'deflate');
    var parms = firstParms(obj.value);
    if (parms && parms.type === 'dict') {
      var predictor = parms.get('Predictor');
      var columns = parms.get('Columns');
      var pred = predictor && predictor.type === 'number' ? predictor.num : 1;
      var cols = columns && columns.type === 'number' ? columns.num : 1;
      if (pred && pred !== 1) data = undoPredictor(data, cols, pred);
    }
    return data;
  }

  function firstParms(dict) {
    var parms = dict && dict.get ? dict.get('DecodeParms') : null;
    if (parms && parms.type === 'array') parms = parms.items[0] || null;
    return parms;
  }

  function parseObjStm(data, dict) {
    var nv = dict.get('N');
    var fv = dict.get('First');
    if (!nv || nv.type !== 'number' || !fv || fv.type !== 'number') throw new Error('Object stream is missing /N or /First.');
    var N = nv.num;
    var First = fv.num;
    /* Each object needs at least a few bytes. A larger count is not real. */
    if (!(N >= 0) || N > data.length || !(First >= 0) || First > data.length) throw new Error('Object stream header does not fit its data.');
    var pos = 0;
    function readIntAt(p) {
      p = skipWs(data, p);
      var n = readPdfNumber(data, p);
      return n;
    }
    var pairs = [];
    for (var i = 0; i < N; i++) {
      var a = readIntAt(pos); pos = a.end;
      var b = readIntAt(pos); pos = b.end;
      pairs.push({ id: a.num, off: b.num });
    }
    var values = [];
    for (var j = 0; j < pairs.length; j++) {
      var at = First + pairs[j].off;
      var parsed = parsePdfValue(data, at);
      values.push({ id: pairs[j].id, value: parsed.value });
    }
    return values;
  }

  function parseClassicXref(bytes, pos) {
    var i = skipWs(bytes, pos + 4);
    var entries = [];
    while (i < bytes.length && !matchKw(bytes, i, 'trailer')) {
      var start = readPdfNumber(bytes, i); i = skipWs(bytes, start.end);
      var count = readPdfNumber(bytes, i); i = count.end;
      if (bytes[i] === 13) i++;
      if (bytes[i] === 10) i++;
      for (var n = 0; n < count.num; n++) {
        var slice = latin1(bytes.subarray(i, i + 20));
        entries.push({
          id: start.num + n,
          offset: parseInt(slice.slice(0, 10), 10),
          gen: parseInt(slice.slice(11, 16), 10),
          type: slice.charAt(17) === 'n' ? 1 : 0
        });
        i += 20;
      }
      i = skipWs(bytes, i);
    }
    if (!matchKw(bytes, i, 'trailer')) throw new Error('PDF trailer is missing.');
    i += 7;
    var dict = parsePdfValue(bytes, i);
    return { entries: entries, trailer: dict.value };
  }

  async function parseXrefStreamEntries(obj) {
    var dict = obj.value;
    var W = dict.get('W');
    if (!W || W.type !== 'array') throw new Error('XRef stream is missing /W.');
    var w = W.items.map(function (n) { return n.num; });
    if (w.length < 3 || !w.every(function (n) { return n >= 0 && n <= 8 && n === Math.floor(n); })) throw new Error('XRef stream has an unusable /W.');
    var rowSize = w[0] + w[1] + w[2];
    if (!rowSize) throw new Error('XRef stream has an unusable /W.');
    var data = obj.stream;
    var filters = filtersOf(dict);
    if (filters.length > 1 || (filters.length === 1 && filters[0] !== 'FlateDecode' && filters[0] !== 'Fl')) {
      throw new Error('Unsupported filter on the PDF cross-reference stream.');
    }
    if (filters.length === 1) data = await inflate(data, 'deflate');
    var parms = firstParms(dict);
    var predictor = 1;
    var columns = rowSize;
    if (parms && parms.type === 'dict') {
      if (parms.get('Predictor')) predictor = parms.get('Predictor').num;
      if (parms.get('Columns')) columns = parms.get('Columns').num;
    }
    if (predictor !== 1) data = undoPredictor(data, columns, predictor);
    var index = dict.get('Index');
    var sections = [];
    if (index && index.type === 'array') {
      for (var s = 0; s + 1 < index.items.length; s += 2) sections.push([index.items[s].num, index.items[s + 1].num]);
    } else {
      var sizeVal = dict.get('Size');
      if (!sizeVal || sizeVal.type !== 'number') throw new Error('XRef stream is missing /Size.');
      sections.push([0, sizeVal.num]);
    }
    /* The section counts are file data. The decoded table is the real limit. */
    var rowsLeft = Math.floor(data.length / rowSize);
    var entries = [];
    var p = 0;
    function field(width) {
      var v = 0;
      for (var i = 0; i < width; i++) v = v * 256 + data[p++];
      return width ? v : 0;
    }
    for (var si = 0; si < sections.length; si++) {
      var id = sections[si][0];
      for (var n = 0; n < sections[si][1]; n++, id++) {
        if (rowsLeft-- <= 0) break;
        var type = w[0] ? field(w[0]) : 1;
        var f2 = field(w[1]);
        var f3 = field(w[2]);
        if (type === 0) entries.push({ id: id, type: 0, gen: f3 });
        else if (type === 1) entries.push({ id: id, type: 1, offset: f2, gen: f3 });
        else if (type === 2) entries.push({ id: id, type: 2, objstm: f2, index: f3, gen: 0 });
      }
    }
    return entries;
  }

  async function loadPdf(bytes) {
    var sx = lastIndexOfAscii(bytes, 'startxref');
    if (sx < 0) throw new Error('PDF startxref was not found.');
    var pos = readPdfNumber(bytes, skipWs(bytes, sx + 9)).num;
    var map = new Map();
    var trailer = null;
    var visited = new Set();
    /* Every revision of the file adds one cross-reference section. All of them
       are needed: stopping early (the old limit was 20) left objects out of the
       rewrite and still reported success. */
    var MAX_SECTIONS = 4096;
    async function walk(at) {
      if (!(at >= 0) || at >= bytes.length) throw new Error('A PDF cross-reference offset points outside the file.');
      if (visited.has(at)) return;
      if (visited.size >= MAX_SECTIONS) throw new Error('PDF has too many cross-reference sections.');
      visited.add(at);
      var i = skipWs(bytes, at);
      if (matchKw(bytes, i, 'xref')) {
        var classic = parseClassicXref(bytes, i);
        if (!classic.trailer || classic.trailer.type !== 'dict') throw new Error('PDF trailer is not a dictionary.');
        if (!trailer) trailer = classic.trailer;
        for (var c = 0; c < classic.entries.length; c++) if (!map.has(classic.entries[c].id)) map.set(classic.entries[c].id, classic.entries[c]);
        /* Hybrid-reference files keep part of the table in a cross-reference
           stream named by /XRefStm. Objects listed only there were being lost. */
        var hybrid = classic.trailer.get('XRefStm');
        if (hybrid && hybrid.type === 'number') await walk(hybrid.num);
        var prev = classic.trailer.get('Prev');
        if (prev && prev.type === 'number') await walk(prev.num);
        return;
      }
      var obj = readPdfObject(bytes, i);
      if (obj.lengthIndirect) throw new Error('XRef stream length is indirect.');
      if (obj.value.type !== 'dict' || !obj.stream) throw new Error('PDF cross-reference section was not found where startxref points.');
      if (!trailer) trailer = obj.value;
      var ents = await parseXrefStreamEntries(obj);
      for (var e = 0; e < ents.length; e++) if (!map.has(ents[e].id)) map.set(ents[e].id, ents[e]);
      var prev2 = obj.value.get('Prev');
      if (prev2 && prev2.type === 'number') await walk(prev2.num);
      map.set(obj.id, { id: obj.id, type: 0, gen: obj.gen, xrefStream: true });
    }
    await walk(pos);
    if (!trailer) throw new Error('PDF trailer was not found.');
    if (trailer.get('Encrypt')) throw new Error('Encrypted PDFs are not modified.');
    var objects = new Map();
    map.forEach(function (entry) {
      if (entry.type === 1 && !entry.xrefStream) {
        var obj = readPdfObject(bytes, entry.offset);
        /* The object is written back under the number the table gives it, so
           the two have to agree. A stale table would otherwise renumber objects. */
        if (obj.id !== entry.id) throw new Error('PDF cross-reference table points object ' + entry.id + ' at object ' + obj.id + '.');
        obj.gen = entry.gen;
        objects.set(entry.id, obj);
      }
    });
    /* A stream length can itself live in an object stream. Resolve what can be
       resolved now and the rest after the object streams are unpacked. */
    objects.forEach(function (obj) {
      if (!obj.lengthIndirect) return;
      var ref = obj.value.get('Length');
      var target = objects.get(ref.id);
      if (target && !target.lengthIndirect) finishIndirect(bytes, obj, objects);
    });
    var groups = new Map();
    map.forEach(function (entry) {
      if (entry.type === 2) {
        if (!groups.has(entry.objstm)) groups.set(entry.objstm, []);
        groups.get(entry.objstm).push(entry);
      }
    });
    for (var pair of groups) {
      var stm = objects.get(pair[0]);
      if (!stm) throw new Error('Object stream ' + pair[0] + ' is missing.');
      if (stm.lengthIndirect || !stm.stream) throw new Error('Object stream ' + pair[0] + ' could not be read.');
      var data = await decodeStream(stm);
      var inner = parseObjStm(data, stm.value);
      var byIndex = {};
      for (var ii = 0; ii < inner.length; ii++) byIndex[ii] = inner[ii];
      var list = pair[1];
      for (var li = 0; li < list.length; li++) {
        var got = byIndex[list[li].index];
        if (!got) throw new Error('Object stream index missing.');
        if (got.id !== list[li].id) throw new Error('Object stream ' + pair[0] + ' does not hold object ' + list[li].id + ' at the listed position.');
        objects.set(list[li].id, { id: got.id, gen: 0, value: got.value, stream: null, raw: null, fromObjStm: true });
      }
    }
    objects.forEach(function (obj) { if (obj.lengthIndirect) finishIndirect(bytes, obj, objects); });
    return { trailer: trailer, objects: objects, map: map };
  }

  function pdfHeader(bytes) {
    var i = 0;
    while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
    if (bytes[i] === 13) i++;
    if (bytes[i] === 10) i++;
    if (bytes[i] === 37) {
      while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
      if (bytes[i] === 13) i++;
      if (bytes[i] === 10) i++;
    }
    return bytes.slice(0, i);
  }

  function filtersOf(dict) {
    if (!dict || dict.type !== 'dict') return [];
    var f = dict.get('Filter');
    if (!f) return [];
    if (f.type === 'name') return [f.name];
    if (f.type === 'array') return f.items.filter(function (x) { return x.type === 'name'; }).map(function (x) { return x.name; });
    return [];
  }

  async function stripPdf(bytes) {
    var loaded = await loadPdf(bytes);
    var trailer = loaded.trailer;
    var objects = loaded.objects;
    var rootRef = trailer.get('Root');
    if (!rootRef || rootRef.type !== 'ref') throw new Error('PDF /Root is missing.');
    var root = objects.get(rootRef.id);
    if (!root) throw new Error('PDF catalog is missing.');
    var infoRef = trailer.get('Info');
    var metaRef = root.value.type === 'dict' ? root.value.get('Metadata') : null;
    var notes = [];
    var skip = {};
    var replacement = {};
    var imageTrouble = 0;
    if (infoRef && infoRef.type === 'ref') {
      replacement[infoRef.id] = fromLatin1(infoRef.id + ' ' + (objects.get(infoRef.id) ? objects.get(infoRef.id).gen : 0) + ' obj\n<<>>\nendobj\n');
      notes.push('Cleared the document information dictionary.');
    }
    if (metaRef && metaRef.type === 'ref') {
      skip[metaRef.id] = 1;
      if (root.value.type === 'dict') {
        var gen = root.gen || 0;
        replacement[root.id] = fromLatin1(root.id + ' ' + gen + ' obj\n' + emitDict(root.value, { Metadata: 1 }) + '\nendobj\n');
        notes.push('Removed the catalog Metadata reference and dropped the metadata stream.');
      }
    }
    objects.forEach(function (obj, id) {
      if (!obj.value || obj.value.type !== 'dict') return;
      var type = obj.value.get('Type');
      if (type && type.type === 'name' && (type.name === 'Metadata' || type.name === 'XRef' || type.name === 'ObjStm')) skip[id] = 1;
      var subtype = obj.value.get('Subtype');
      var filters = filtersOf(obj.value);
      if (obj.stream && subtype && subtype.type === 'name' && subtype.name === 'Image' && filters.length === 1 && filters[0] === 'DCTDecode' && obj.stream[0] === 0xff && obj.stream[1] === 0xd8) {
        var stripped;
        try {
          stripped = stripJpeg(obj.stream);
        } catch (err) {
          /* One picture the JPEG walker cannot follow should not stop the whole
             document. It is left as it was, and the result is not called clear. */
          imageTrouble++;
          return;
        }
        if (stripped.bytes.length !== obj.stream.length || indexOfBytes(obj.stream, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) >= 0) {
          var dictText = emitDict(obj.value, null, { Length: String(stripped.bytes.length) });
          var head = fromLatin1(obj.id + ' ' + obj.gen + ' obj\n' + dictText + '\nstream\n');
          var tail = fromLatin1('\nendstream\nendobj\n');
          replacement[id] = concat([head, stripped.bytes, tail]);
          notes.push('Stripped EXIF from an embedded JPEG (object ' + id + ').');
        }
      }
    });
    if (!notes.length) notes.push('No document information dictionary or metadata stream was found. The file was still rewritten without incremental-update history.');
    var ids = Array.from(objects.keys()).filter(function (id) { return id > 0 && !skip[id]; }).sort(function (a, b) { return a - b; });
    var chunks = [pdfHeader(bytes)];
    if (chunks[0].length && chunks[0][chunks[0].length - 1] !== 10) chunks.push(fromLatin1('\n'));
    var offsets = {};
    /* Running total. Re-adding every chunk for every object was quadratic and
       stalled on documents with tens of thousands of objects. */
    var written = 0;
    for (var w0 = 0; w0 < chunks.length; w0++) written += chunks[w0].length;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var obj = objects.get(id);
      var body;
      if (replacement[id]) body = replacement[id];
      else if (obj.raw) body = concat([obj.raw, fromLatin1('\n')]);
      else if (obj.value && obj.value.raw) body = fromLatin1(obj.id + ' ' + (obj.gen || 0) + ' obj\n' + latin1(obj.value.raw) + '\nendobj\n');
      else throw new Error('Cannot serialize PDF object ' + id);
      offsets[id] = { off: written, gen: obj.gen || 0 };
      written += body.length;
      chunks.push(body);
    }
    var maxId = 0;
    objects.forEach(function (_, id) { if (id > maxId) maxId = id; });
    ids.forEach(function (id) { if (id > maxId) maxId = id; });
    var xrefAt = written;
    if (xrefAt > 9999999999) throw new Error('PDF is too large for a classic cross-reference table.');
    function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
    var rows = ['xref\n0 ' + (maxId + 1) + '\n', pad(0, 10) + ' ' + pad(65535, 5) + ' f \n'];
    for (var idn = 1; idn <= maxId; idn++) {
      if (offsets[idn]) rows.push(pad(offsets[idn].off, 10) + ' ' + pad(offsets[idn].gen, 5) + ' n \n');
      else rows.push(pad(0, 10) + ' ' + pad(0, 5) + ' f \n');
    }
    var xref = rows.join('');
    var trailerText = 'trailer\n<< /Size ' + (maxId + 1) + ' /Root ' + latin1(rootRef.raw);
    if (infoRef && infoRef.type === 'ref' && !skip[infoRef.id]) trailerText += ' /Info ' + latin1(infoRef.raw);
    /* The trailer /ID is left out. Its first half is a permanent identifier
       given to the document when it was created, so it ties the stripped copy
       to the original. Only encrypted files need it, and those are refused. */
    if (trailer.get('ID')) notes.push('Left out the trailer /ID. It is a fixed identifier that links copies of the same document.');
    trailerText += ' >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
    chunks.push(fromLatin1(xref + trailerText));
    notes.push('Flattened the cross-reference table so earlier incremental copies of metadata are not kept.');
    if (imageTrouble) notes.push(imageTrouble + ' embedded JPEG image(s) could not be parsed and were left as they were. Metadata inside them, if any, is still there.');
    return okResult('pdf', 'full', concat(chunks), notes, imageTrouble > 0);
  }

  /* ------------------------------------------------------------------ detect / scan / strip */

  function fmt(format, label, support, mime) {
    return { format: format, label: label, support: support, mime: mime };
  }

  function detectSync(bytes) {
    if (!bytes || !bytes.length) return fmt('unknown', 'Unknown', 'unsupported', '');
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return fmt('png', 'PNG', 'full', 'image/png');
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return fmt('jpeg', 'JPEG', 'full', 'image/jpeg');
    if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return fmt('gif', 'GIF', 'full', 'image/gif');
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return fmt('webp', 'WebP', 'full', 'image/webp');
    if ((ascii(bytes, 0, 2) === 'II' && bytes[2] === 42 && bytes[3] === 0) || (ascii(bytes, 0, 2) === 'MM' && bytes[2] === 0 && bytes[3] === 42)) return fmt('tiff', 'TIFF', 'full', 'image/tiff');
    if ((ascii(bytes, 0, 2) === 'II' && bytes[2] === 43) || (ascii(bytes, 0, 2) === 'MM' && bytes[3] === 43)) return fmt('bigtiff', 'BigTIFF', 'unsupported', 'image/tiff');
    if (ascii(bytes, 0, 5) === '%PDF-' || (bytes.length > 8 && ascii(bytes, 0, 1) === '%' && indexOfBytes(bytes.subarray(0, 1024), fromLatin1('%PDF-')) === 0)) return fmt('pdf', 'PDF', 'full', 'application/pdf');
    if (indexOfBytes(bytes.subarray(0, Math.min(bytes.length, 1024)), fromLatin1('%PDF-')) >= 0 && indexOfBytes(bytes.subarray(0, 16), fromLatin1('%PDF-')) >= 0) return fmt('pdf', 'PDF', 'full', 'application/pdf');
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)) return fmt('zip', 'ZIP', 'unsupported', 'application/zip');
    var info = ftypInfo(bytes);
    if (info) {
      if (brandHit(info.brands, AVIF_BRANDS) && !brandHit(info.brands, { heic: 1, heix: 1, hevc: 1, hevx: 1 })) return fmt('avif', 'AVIF', 'unsupported', 'image/avif');
      if (brandHit(info.brands, HEIC_BRANDS)) return fmt('heic', 'HEIC', 'best-effort', 'image/heic');
      if (info.brands.indexOf('M4A ') >= 0 || info.brands.indexOf('M4B ') >= 0) return fmt('m4a', 'M4A', 'best-effort', 'audio/mp4');
      if (info.major === 'qt  ' || info.brands.indexOf('qt  ') >= 0) return fmt('mov', 'MOV', 'best-effort', 'video/quicktime');
      return fmt('mp4', 'MP4', 'best-effort', 'video/mp4');
    }
    if (bytes.length > 12) {
      var t = ascii(bytes, 4, 4);
      if (t === 'moov' || t === 'mdat' || t === 'wide' || t === 'free' || t === 'skip' || t === 'pnot') return fmt('mov', 'MOV', 'best-effort', 'video/quicktime');
    }
    if (looksLikeMp3(bytes)) return fmt('mp3', 'MP3', 'full', 'audio/mpeg');
    return fmt('unknown', 'Unknown', 'unsupported', '');
  }

  async function detect(bytes) {
    var sync = detectSync(bytes);
    if (sync.format !== 'zip') return sync;
    try {
      var entries = await readZip(bytes);
      return classifyZip(entries);
    } catch (e) {
      /* Keep the reason. "Not an Office package" is the wrong thing to tell
         someone whose document is encrypted, damaged, or over the size limit. */
      var bad = fmt('zip', 'ZIP', 'unsupported', 'application/zip');
      bad.reason = e && e.message ? e.message : String(e);
      return bad;
    }
  }

  var MAX_NESTING = 4;

  async function scan(bytes, depth) {
    depth = depth || 0;
    var detected = await detect(bytes);
    var items = [];
    var notes = [];
    if (detected.reason) notes.push('This ZIP could not be read: ' + detected.reason);
    try {
      if (detected.format === 'jpeg') items = scanJpeg(bytes);
      else if (detected.format === 'png') items = await scanPngFull(bytes);
      else if (detected.format === 'webp') items = scanWebp(bytes);
      else if (detected.format === 'gif') items = scanGif(bytes);
      else if (detected.format === 'tiff') items = parseTiffMetadata(bytes, 0, 'TIFF');
      else if (detected.format === 'heic') items = scanHeic(bytes);
      else if (detected.format === 'pdf') items = items.concat(await scanPdfLight(bytes));
      else if (detected.format === 'mp3') items = scanMp3(bytes);
      else if (detected.format === 'mp4' || detected.format === 'mov' || detected.format === 'm4a') items = scanQt(bytes);
      else if (detected.format === 'docx' || detected.format === 'xlsx' || detected.format === 'pptx' || detected.format === 'odt' || detected.format === 'ods' || detected.format === 'odp') items = await scanOffice(bytes, depth);
      else notes.push(detected.format === 'bigtiff' ? 'BigTIFF is recognized and left untouched.' : 'This file type is not supported.');
    } catch (e) {
      notes.push('Scan failed: ' + e.message);
      /* A scan that broke off has not looked at the whole file. Say so as a
         finding, so the re-scan cannot come back empty and read as "clear". */
      if (detected.support !== 'unsupported') {
        items.push(item('Scan incomplete', 'The scan stopped early (' + e.message + '). Metadata may be present that is not listed.', 'Scan', 'scanner'));
      }
    }
    items = mergeSafety(items, bytes);
    return { detected: detected, items: items, notes: notes };
  }

  async function scanPdfLight(bytes) {
    var items = [];
    try {
      var loaded = await loadPdf(bytes);
      var infoRef = loaded.trailer.get('Info');
      if (infoRef && loaded.objects.get(infoRef.id)) {
        var info = loaded.objects.get(infoRef.id).value;
        if (info && info.type === 'dict') {
          for (var i = 0; i < info.entries.length; i++) {
            var e = info.entries[i];
            var value = e.value.type === 'string' ? pdfString(e.value.raw) : (e.value.type === 'hex' ? pdfHex(e.value.raw) : (e.value.type === 'name' ? e.value.name : latin1(e.value.raw)));
            if (value && value.trim()) items.push(item(e.name, value.trim(), 'PDF', 'PDF Info'));
          }
        }
      }
      var root = loaded.objects.get(loaded.trailer.get('Root').id);
      var meta = root && root.value.get && root.value.get('Metadata');
      if (meta && meta.type === 'ref' && loaded.objects.get(meta.id) && loaded.objects.get(meta.id).stream) {
        var stream = loaded.objects.get(meta.id).stream;
        var filters = filtersOf(loaded.objects.get(meta.id).value);
        var data = stream;
        if (filters.length === 1 && filters[0] === 'FlateDecode') data = await inflate(stream, 'deflate');
        items.push.apply(items, parseXmp(data, 'PDF XMP'));
      }
    } catch (e) {
      items.push(item('PDF', 'Could not fully parse this PDF (' + e.message + ')', 'PDF', 'PDF'));
    }
    return items;
  }

  function pdfString(raw) {
    var s = latin1(raw);
    if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') s = s.slice(1, -1);
    /* One pass, so an escaped backslash is not read twice. Octal escapes included. */
    s = s.replace(/\\([0-7]{1,3}|\r\n|[\s\S])/g, function (_, c) {
      if (c === 'n') return '\n';
      if (c === 'r') return '\r';
      if (c === 't') return '\t';
      if (c === 'b') return '\b';
      if (c === 'f') return '\f';
      if (c === '\n' || c === '\r' || c === '\r\n') return '';
      if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8) & 255);
      return c;
    });
    return pdfTextDecode(s);
  }
  function pdfHex(raw) {
    var s = latin1(raw).replace(/[<>\s]/g, '');
    if (s.length % 2) s += '0';
    var out = '';
    for (var i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode(parseInt(s.substr(i, 2), 16));
    return pdfTextDecode(out);
  }
  /* PDF text strings are UTF-16BE or UTF-8 when they start with a byte-order
     mark. Shown raw, a UTF-16 title reads as noise. */
  function pdfTextDecode(s) {
    try {
      if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) return new TextDecoder('utf-16be').decode(fromLatin1(s.slice(2)));
      if (s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb && s.charCodeAt(2) === 0xbf) return new TextDecoder('utf-8').decode(fromLatin1(s.slice(3)));
    } catch (e) { /* fall back to the raw bytes */ }
    return s;
  }

  async function stripLossless(bytes, depth) {
    depth = depth || 0;
    if (depth > MAX_NESTING) return failResult('unknown', 'Nested container is too deep.');
    var detected;
    try { detected = await detect(bytes); }
    catch (e) { return failResult('unknown', e.message); }
    if (detected.support === 'unsupported') {
      var why = detected.format === 'bigtiff' ? 'BigTIFF is not supported. The file was not modified.'
        : detected.format === 'avif' ? 'AVIF is not a v1 format. The file was not modified.'
        : detected.format === 'zip' && detected.reason ? 'This ZIP could not be read (' + detected.reason + '). It was not modified.'
        : detected.format === 'zip' ? 'This ZIP is not an Office or ODF package. It was not modified.'
        : 'Unsupported file type. The file was not modified.';
      return failResult(detected.format, why);
    }
    try {
      if (detected.format === 'jpeg') {
        var j = stripJpeg(bytes);
        return okResult('jpeg', 'full', j.bytes, j.notes, false);
      }
      if (detected.format === 'png') {
        var p = stripPng(bytes);
        return okResult('png', 'full', p.bytes, p.notes, false);
      }
      if (detected.format === 'webp') {
        var w = stripWebp(bytes);
        return okResult('webp', 'full', w.bytes, w.notes, false);
      }
      if (detected.format === 'gif') {
        var g = stripGif(bytes);
        return okResult('gif', 'full', g.bytes, g.notes, false);
      }
      if (detected.format === 'tiff') {
        var t = rebuildTiff(bytes);
        return okResult('tiff', 'full', t, ['Rebuilt the TIFF with image tags only. Descriptive tags, EXIF, GPS, XMP, and IPTC were left out. ICC profiles are removed, so colors may shift.'], false);
      }
      if (detected.format === 'heic') return stripHeic(bytes);
      if (detected.format === 'pdf') return await stripPdf(bytes);
      if (detected.format === 'mp3') return stripMp3(bytes);
      if (detected.format === 'mp4' || detected.format === 'mov' || detected.format === 'm4a') return stripIsoBmff(bytes, detected.format);
      if (detected.format === 'docx' || detected.format === 'xlsx' || detected.format === 'pptx' || detected.format === 'odt' || detected.format === 'ods' || detected.format === 'odp') {
        return await stripOffice(bytes, detected, depth);
      }
    } catch (e) {
      /* Some messages already end with this sentence. Say it once. */
      var msg = String(e && e.message ? e.message : e).replace(/\s*(?:The file|It) was not modified\.\s*$/, '');
      if (!/[.!?]$/.test(msg)) msg += '.';
      return failResult(detected.format, msg + ' The file was not modified.');
    }
    return failResult(detected.format, 'No stripper is available. The file was not modified.');
  }

  function judge(stripped, after) {
    if (!stripped || !stripped.ok) {
      return { level: 'failed', title: 'Not stripped', detail: (stripped && stripped.reason) || 'The file was not modified.' };
    }
    var left = (after && after.items ? after.items : []).filter(function (it) { return !it.structural; });
    if (left.length) {
      return {
        level: 'residual',
        title: 'Metadata remains',
        detail: 'Re-scan still found ' + left.length + ' metadata item' + (left.length === 1 ? '' : 's') + '. This file is not clean.'
      };
    }
    if (stripped.support !== 'full' || stripped.blocksClear) {
      return {
        level: 'unverified',
        title: 'Not certified',
        detail: 'Re-scan found no known metadata. This format is best effort, so the file is not certified clean. Check it with another tool before you rely on it.'
      };
    }
    return {
      level: 'clear',
      title: 'No metadata detected',
      detail: 'Re-scan found no metadata. Lossless stripping for this format removes the containers this tool knows how to read.'
    };
  }

  var EXTENSIONS = {
    jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', tiff: '.tif', heic: '.heic',
    pdf: '.pdf', docx: '.docx', xlsx: '.xlsx', pptx: '.pptx', odt: '.odt', ods: '.ods', odp: '.odp',
    mp3: '.mp3', mp4: '.mp4', mov: '.mov', m4a: '.m4a'
  };

  delete root.__exifExorcistParts;
  root.ExifExorcist = {
    version: '1.0.0',
    detect: detect,
    detectSync: detectSync,
    scan: scan,
    stripLossless: stripLossless,
    judge: judge,
    writeZip: writeZip,
    extensionFor: function (format) { return EXTENSIONS[format] || '.bin'; },
    sensitivity: P.sensitivity
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
