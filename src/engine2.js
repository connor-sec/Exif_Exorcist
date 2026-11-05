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
    for (var i = 0; i < num; i++) {
      var id = ver < 2 ? u16be(payload, pos) : u32be(payload, pos);
      pos += ver < 2 ? 2 : 4;
      var construction = 0;
      if (ver === 1 || ver === 2) { construction = u16be(payload, pos) & 15; pos += 2; }
      var dataRef = u16be(payload, pos); pos += 2;
      var base = getVar(nbas);
      var extNum = u16be(payload, pos); pos += 2;
      var extents = [];
      for (var j = 0; j < extNum; j++) {
        if ((ver === 1 || ver === 2) && nind) getVar(nind);
        extents.push({ offset: getVar(noff), length: getVar(nlen) });
      }
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

  function metaIsMetadata(bytes, box) {
    var children = parseBoxes(bytes, box.start + box.header + 4, box.end);
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
        else if (b.type === 'meta') walk(b.start + b.header + 4, b.end);
      }
    }
    walk(0, bytes.length);
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

  function stripIsoBmff(bytes, format) {
    var dropped = [];
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
          dropped.push([b.start, b.end]);
        } else if (MP4_CONTAINERS[b.type] || b.type === 'meta') {
          var childStart = b.start + b.header + (b.type === 'meta' ? 4 : 0);
          var inner = rebuildRange(childStart, b.end);
          var headRest = bytes.subarray(b.start + 8, childStart);
          var bodyLen = headRest.length + inner.length;
          var size = 8 + bodyLen;
          var hdr = new Uint8Array(8);
          setU32be(hdr, 0, size);
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
          var count = u32be(out, p + 4);
          var wide = b.type === 'co64';
          for (var n = 0; n < count; n++) {
            var at = p + 8 + n * (wide ? 8 : 4);
            var old = wide ? u64be(out, at) : u32be(out, at);
            var neu = mapOffset(old);
            if (wide) setU64be(out, at, neu);
            else setU32be(out, at, neu);
          }
        } else if (MP4_CONTAINERS[b.type]) fix(b.start + b.header, b.end);
        else if (b.type === 'meta') fix(b.start + b.header + 4, b.end);
      }
    }
    fix(0, out.length);
    var notes = [];
    if (dropped.length) notes.push('Removed ' + dropped.length + ' metadata box(es) (user data, iTunes meta, and/or XMP uuid) and rewrote chunk offsets.');
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
    while (pos + 10 <= end) {
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

  function stripMp3(bytes) {
    var start = 0;
    var end = bytes.length;
    var notes = [];
    if (ascii(bytes, 0, 3) === 'ID3') {
      var size = syncsafe(bytes, 6);
      var footer = bytes[5] & 0x10;
      start = 10 + size + (footer ? 10 : 0);
      if (start > bytes.length) throw new Error('ID3 tag extends past the end of the file.');
      notes.push('Removed ID3v2 tag (' + start + ' bytes).');
    }
    if (end - start >= 128 && ascii(bytes, end - 128, 3) === 'TAG') {
      end -= 128;
      notes.push('Removed ID3v1 tag.');
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

  async function readZip(bytes) {
    var eocd = -1;
    var min = Math.max(0, bytes.length - 65557);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory was not found.');
    if (u16le(bytes, eocd + 4) !== 0 || u32le(bytes, eocd + 16) === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
    var entries = u16le(bytes, eocd + 10);
    var cdOff = u32le(bytes, eocd + 16);
    var out = [];
    var p = cdOff;
    for (var n = 0; n < entries; n++) {
      if (ascii(bytes, p, 4) !== 'PK\x01\x02') throw new Error('Bad ZIP central directory.');
      var method = u16le(bytes, p + 10);
      var compSize = u32le(bytes, p + 20);
      var nameLen = u16le(bytes, p + 28);
      var extraLen = u16le(bytes, p + 30);
      var commentLen = u16le(bytes, p + 32);
      var localOff = u32le(bytes, p + 42);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (ascii(bytes, localOff, 4) !== 'PK\x03\x04') throw new Error('Bad ZIP local header for ' + name);
      var lname = u16le(bytes, localOff + 26);
      var lextra = u16le(bytes, localOff + 28);
      var dataStart = localOff + 30 + lname + lextra;
      var comp = bytes.subarray(dataStart, dataStart + compSize);
      var data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = await inflate(comp, 'deflate-raw');
      else throw new Error('Unsupported ZIP compression method ' + method + ' in ' + name);
      out.push({ name: name, data: data });
    }
    return out;
  }

  function writeZip(entries) {
    var parts = [];
    var central = [];
    var offset = 0;
    var enc = new TextEncoder();
    for (var i = 0; i < entries.length; i++) {
      var nameBytes = enc.encode(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(8, 0, true);
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

  function scrubOfficeXml(name, data) {
    var text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    var orig = text;
    var notes = [];
    if (name === '[Content_Types].xml') {
      text = text.replace(/<Override\b[^>]*PartName="\/docProps\/[^"]*"[^>]*\/>/g, '');
    }
    if (/\.rels$/i.test(name)) {
      text = text.replace(/<Relationship\b[^>]*(?:docProps\/|core-properties|extended-properties|custom-properties)[^>]*\/>/g, '');
    }
    if (/\.(xml|rels)$/i.test(name)) {
      var next = text.replace(/\b((?:[A-Za-z0-9]+:)?author)="[^"]*"/g, '$1=""');
      if (next !== text) notes.push('Cleared author attributes in ' + name);
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

  async function scanOffice(bytes) {
    var entries = await readZip(bytes);
    var kind = classifyZip(entries);
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
        var am = xml.match(/\bauthor="([^"]+)"/);
        if (am && am[1]) items.push(item('author', am[1], kind.label, e.name));
      }
      var nested = detectSync(e.data);
      if (nested && nested.support === 'full' && nested.format !== 'zip') {
        var sub = await scan(e.data);
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
      } else if (/\.(xml|rels)$/i.test(e.name)) {
        var scrub = scrubOfficeXml(e.name, data);
        if (scrub.changed) {
          data = scrub.data;
          notes.push.apply(notes, scrub.notes);
        }
      }
      var nested = detectSync(data);
      if (nested && (nested.support === 'full' || nested.support === 'best-effort') && nested.format !== kind.format && !/^zip|docx|xlsx|pptx|odt|ods|odp$/.test(nested.format)) {
        var stripped = await stripLossless(data, depth + 1);
        if (stripped.ok) {
          data = stripped.bytes;
          notes.push('Stripped embedded ' + e.name + ' (' + nested.label + ')');
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
    return okResult(kind.format, 'full', writeZip(kept), notes, false);
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
        stream = bytes.slice(streamStart, streamStart + lengthDirect);
        i = streamStart + lengthDirect;
        i = skipWs(bytes, i);
        if (matchKw(bytes, i, 'endstream')) i += 9;
        i = skipWs(bytes, i);
      }
    }
    if (!lengthIndirect) {
      if (matchKw(bytes, i, 'endobj')) i += 6;
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
    obj.stream = bytes.slice(obj.streamStart, obj.streamStart + length);
    var i = skipWs(bytes, obj.streamStart + length);
    if (matchKw(bytes, i, 'endstream')) i += 9;
    i = skipWs(bytes, i);
    if (matchKw(bytes, i, 'endobj')) i += 6;
    obj.end = i;
    obj.raw = bytes.slice(obj.start, i);
    obj.lengthIndirect = false;
  }

  async function decodeStream(obj) {
    var data = obj.stream;
    var filter = obj.value.get && obj.value.get('Filter');
    var name = filter && filter.type === 'name' ? filter.name : '';
    if (name === 'FlateDecode') data = await inflate(data, 'deflate');
    else if (name) throw new Error('Unsupported PDF filter ' + name);
    var parms = obj.value.get && obj.value.get('DecodeParms');
    if (parms && parms.type === 'dict') {
      var predictor = parms.get('Predictor');
      var columns = parms.get('Columns');
      var pred = predictor && predictor.type === 'number' ? predictor.num : 1;
      var cols = columns && columns.type === 'number' ? columns.num : 1;
      if (pred && pred !== 1) data = undoPredictor(data, cols, pred);
    }
    return data;
  }

  function parseObjStm(data, dict) {
    var N = dict.get('N').num;
    var First = dict.get('First').num;
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
    var data = obj.stream;
    var filter = dict.get('Filter');
    if (filter && filter.type === 'name' && filter.name === 'FlateDecode') data = await inflate(data, 'deflate');
    var parms = dict.get('DecodeParms');
    var predictor = 1;
    var columns = w[0] + w[1] + w[2];
    if (parms && parms.type === 'dict') {
      if (parms.get('Predictor')) predictor = parms.get('Predictor').num;
      if (parms.get('Columns')) columns = parms.get('Columns').num;
    }
    if (predictor !== 1) data = undoPredictor(data, columns, predictor);
    var index = dict.get('Index');
    var sections = [];
    if (index && index.type === 'array') {
      for (var s = 0; s < index.items.length; s += 2) sections.push([index.items[s].num, index.items[s + 1].num]);
    } else sections.push([0, dict.get('Size').num]);
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
    async function walk(at, depth) {
      if (depth > 20 || at < 0 || at >= bytes.length) return;
      var i = skipWs(bytes, at);
      if (matchKw(bytes, i, 'xref')) {
        var classic = parseClassicXref(bytes, i);
        if (!trailer) trailer = classic.trailer;
        for (var c = 0; c < classic.entries.length; c++) if (!map.has(classic.entries[c].id)) map.set(classic.entries[c].id, classic.entries[c]);
        var prev = classic.trailer.get && classic.trailer.get('Prev');
        if (prev && prev.type === 'number') await walk(prev.num, depth + 1);
        return;
      }
      var obj = readPdfObject(bytes, i);
      if (obj.lengthIndirect) {
        var len = obj.value.get('Length');
        if (len && len.type === 'number') { /* already handled */ }
      }
      if (!obj.stream && obj.value.type === 'dict' && obj.value.get('Type') && obj.value.get('Type').name === 'XRef' && obj.lengthIndirect) {
        throw new Error('XRef stream length is indirect.');
      }
      if (obj.value.type === 'dict' && obj.stream) {
        if (!trailer) trailer = obj.value;
        var ents = await parseXrefStreamEntries(obj);
        for (var e = 0; e < ents.length; e++) if (!map.has(ents[e].id)) map.set(ents[e].id, ents[e]);
        var prev2 = obj.value.get('Prev');
        if (prev2 && prev2.type === 'number') await walk(prev2.num, depth + 1);
        map.set(obj.id, { id: obj.id, type: 0, gen: obj.gen, xrefStream: true });
      }
    }
    await walk(pos, 0);
    if (!trailer) throw new Error('PDF trailer was not found.');
    if (trailer.get('Encrypt')) throw new Error('Encrypted PDFs are not modified.');
    var objects = new Map();
    map.forEach(function (entry) {
      if (entry.type === 1 && !entry.xrefStream) {
        var obj = readPdfObject(bytes, entry.offset);
        obj.gen = entry.gen;
        objects.set(entry.id, obj);
      }
    });
    objects.forEach(function (obj) { if (obj.lengthIndirect) finishIndirect(bytes, obj, objects); });
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
      var data = await decodeStream(stm);
      var inner = parseObjStm(data, stm.value);
      var byIndex = {};
      for (var ii = 0; ii < inner.length; ii++) byIndex[ii] = inner[ii];
      var list = pair[1];
      for (var li = 0; li < list.length; li++) {
        var got = byIndex[list[li].index];
        if (!got) throw new Error('Object stream index missing.');
        objects.set(list[li].id, { id: got.id, gen: 0, value: got.value, stream: null, raw: null, fromObjStm: true });
      }
    }
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
        var stripped = stripJpeg(obj.stream);
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
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var obj = objects.get(id);
      var body;
      if (replacement[id]) body = replacement[id];
      else if (obj.raw) body = concat([obj.raw, fromLatin1('\n')]);
      else if (obj.value && obj.value.raw) body = fromLatin1(obj.id + ' ' + (obj.gen || 0) + ' obj\n' + latin1(obj.value.raw) + '\nendobj\n');
      else throw new Error('Cannot serialize PDF object ' + id);
      var at = 0;
      for (var c = 0; c < chunks.length; c++) at += chunks[c].length;
      offsets[id] = { off: at, gen: obj.gen || 0 };
      chunks.push(body);
    }
    var maxId = 0;
    objects.forEach(function (_, id) { if (id > maxId) maxId = id; });
    ids.forEach(function (id) { if (id > maxId) maxId = id; });
    var xrefAt = 0;
    for (var c2 = 0; c2 < chunks.length; c2++) xrefAt += chunks[c2].length;
    function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
    var xref = 'xref\n0 ' + (maxId + 1) + '\n';
    xref += pad(0, 10) + ' ' + pad(65535, 5) + ' f \n';
    for (var idn = 1; idn <= maxId; idn++) {
      if (offsets[idn]) xref += pad(offsets[idn].off, 10) + ' ' + pad(offsets[idn].gen, 5) + ' n \n';
      else xref += pad(0, 10) + ' ' + pad(0, 5) + ' f \n';
    }
    var idObj = trailer.get('ID');
    var trailerText = 'trailer\n<< /Size ' + (maxId + 1) + ' /Root ' + latin1(rootRef.raw);
    if (infoRef && infoRef.type === 'ref' && !skip[infoRef.id]) trailerText += ' /Info ' + latin1(infoRef.raw);
    if (idObj && idObj.raw) trailerText += ' /ID ' + latin1(idObj.raw);
    trailerText += ' >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
    chunks.push(fromLatin1(xref + trailerText));
    notes.push('Flattened the cross-reference table so earlier incremental copies of metadata are not kept.');
    return okResult('pdf', 'full', concat(chunks), notes, false);
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
      return fmt('zip', 'ZIP', 'unsupported', 'application/zip');
    }
  }

  async function scan(bytes) {
    var detected = await detect(bytes);
    var items = [];
    var notes = [];
    try {
      if (detected.format === 'jpeg') items = scanJpeg(bytes);
      else if (detected.format === 'png') items = await scanPngFull(bytes);
      else if (detected.format === 'webp') items = scanWebp(bytes);
      else if (detected.format === 'gif') items = scanGif(bytes);
      else if (detected.format === 'tiff') items = parseTiffMetadata(bytes, 0, 'TIFF');
      else if (detected.format === 'heic') items = scanHeic(bytes);
      else if (detected.format === 'pdf') items = items.concat(await scanPdfLight(bytes));
      else if (detected.format === 'mp3') items = scanId3(bytes);
      else if (detected.format === 'mp4' || detected.format === 'mov' || detected.format === 'm4a') items = scanQt(bytes);
      else if (detected.format === 'docx' || detected.format === 'xlsx' || detected.format === 'pptx' || detected.format === 'odt' || detected.format === 'ods' || detected.format === 'odp') items = await scanOffice(bytes);
      else notes.push(detected.format === 'bigtiff' ? 'BigTIFF is recognized and left untouched.' : 'This file type is not supported.');
    } catch (e) {
      notes.push('Scan failed: ' + e.message);
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
    return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
  }
  function pdfHex(raw) {
    var s = latin1(raw).replace(/[<>\s]/g, '');
    var out = '';
    for (var i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode(parseInt(s.substr(i, 2), 16));
    return out;
  }

  async function stripLossless(bytes, depth) {
    depth = depth || 0;
    if (depth > 4) return failResult('unknown', 'Nested container is too deep.');
    var detected;
    try { detected = await detect(bytes); }
    catch (e) { return failResult('unknown', e.message); }
    if (detected.support === 'unsupported') {
      var why = detected.format === 'bigtiff' ? 'BigTIFF is not supported. The file was not modified.'
        : detected.format === 'avif' ? 'AVIF is not a v1 format. The file was not modified.'
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
      return failResult(detected.format, e.message + ' The file was not modified.');
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
