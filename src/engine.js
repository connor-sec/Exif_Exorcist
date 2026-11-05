/*!
 * Exif Exorcist v1.0 — offline metadata stripper
 * Copyright (C) 2026 connor-sec
 * License: AGPL-3.0-only
 *
 * Lossless mode removes metadata containers (JPEG segments, PNG chunks,
 * GIF extensions, WebP chunks, TIFF IFD tags, ISO-BMFF atoms, PDF info/XMP,
 * OOXML docProps, ODF meta.xml, ID3/APE). It does not redraw pixels.
 * Canvas re-encode lives in the HTML UI and is a separate, lossy path.
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';

  function concat(parts) {
    var n = 0;
    var i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n);
    var o = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], o);
      o += parts[i].length;
    }
    return out;
  }

  function ascii(bytes, off, len) {
    var s = '';
    var end = Math.min(bytes.length, off + len);
    for (var i = off; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function latin1(bytes) {
    var s = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + chunk)));
    }
    return s;
  }

  function fromLatin1(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function setU16be(b, o, v) { b[o] = (v >> 8) & 255; b[o + 1] = v & 255; }
  function setU32be(b, o, v) {
    b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  }
  function setU32le(b, o, v) {
    b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255;
  }

  function u64be(b, o) {
    var hi = u32be(b, o);
    var lo = u32be(b, o + 4);
    return hi * 0x100000000 + lo;
  }
  function setU64be(b, o, v) {
    var hi = Math.floor(v / 0x100000000);
    var lo = v >>> 0;
    setU32be(b, o, hi);
    setU32be(b, o + 4, lo);
  }

  function indexOfBytes(hay, needle, from) {
    from = from || 0;
    if (!needle.length) return from;
    var last = hay.length - needle.length;
    outer: for (var i = from; i <= last; i++) {
      for (var j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  function lastIndexOfAscii(hay, s) {
    var n = s.length;
    outer: for (var i = hay.length - n; i >= 0; i--) {
      for (var j = 0; j < n; j++) if (hay[i + j] !== s.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }

  function fourcc(s) {
    return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
  }

  function bytesEq(b, off, arr) {
    if (off < 0 || off + arr.length > b.length) return false;
    for (var i = 0; i < arr.length; i++) if (b[off + i] !== arr[i]) return false;
    return true;
  }

  function startsWith(b, arr) { return bytesEq(b, 0, arr); }

  async function inflate(bytes, format) {
    if (!bytes.length) return new Uint8Array(0);
    var ds = new DecompressionStream(format);
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function sensitivity(tag) {
    var t = String(tag || '').toLowerCase();
    if (t.indexOf('gps') >= 0 || t.indexOf('latitude') >= 0 || t.indexOf('longitude') >= 0 ||
        t.indexOf('iso6709') >= 0 || t === 'location' || t.indexOf('coordinates') >= 0) return 'gps';
    if (t.indexOf('serial') >= 0 || t.indexOf('uniqueid') >= 0 || t.indexOf('imageunique') >= 0) return 'serial';
    return null;
  }

  function item(tag, value, group, source, extra) {
    var o = {
      tag: String(tag),
      value: value == null ? '' : String(value),
      group: group || '',
      source: source || '',
      sensitive: sensitivity(tag),
      structural: false
    };
    if (extra) {
      if (extra.sensitive) o.sensitive = extra.sensitive;
      if (extra.structural) o.structural = true;
    }
    if (group === 'GPS' && !o.sensitive) o.sensitive = 'gps';
    return o;
  }

  function dedupe(items) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.value) continue;
      var k = it.tag + '\0' + it.value + '\0' + it.source;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(it);
    }
    return out;
  }

  function decodeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function parseXmp(data, source) {
    var text = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: false }).decode(data);
    var items = [];
    var re = /<([A-Za-z0-9]+):([A-Za-z0-9]+)>([^<]{1,800})<\/\1:\2>/g;
    var m;
    var skip = { li: 1, Seq: 1, Alt: 1, Bag: 1, Description: 1, RDF: 1, xmpmeta: 1 };
    while ((m = re.exec(text))) {
      if (skip[m[2]]) continue;
      var value = decodeXml(m[3]).trim();
      if (!value) continue;
      items.push(item(m[2], value, 'XMP', source));
    }
    var attr = /(?:exif|tiff|photoshop|xmp|dc|pdf|xmpRights):([A-Za-z0-9]+)="([^"]*)"/g;
    while ((m = attr.exec(text))) {
      var v = decodeXml(m[2]).trim();
      if (!v) continue;
      items.push(item(m[1], v, 'XMP', source));
    }
    return items;
  }

  function findIso6709(bytes) {
    var s = latin1(bytes);
    var m = s.match(/[+-]\d{2}\.\d{2,}[+-]\d{2,3}\.\d{2,}/);
    return m ? m[0] : null;
  }

  function hasExifHeader(bytes) {
    var sig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    var from = 0;
    while (from < bytes.length) {
      var i = indexOfBytes(bytes, sig, from);
      if (i < 0) return false;
      var o = i + 6;
      if (o + 4 <= bytes.length) {
        var ii = bytes[o] === 0x49 && bytes[o + 1] === 0x49 && bytes[o + 2] === 0x2a && bytes[o + 3] === 0x00;
        var mm = bytes[o] === 0x4d && bytes[o + 1] === 0x4d && bytes[o + 2] === 0x00 && bytes[o + 3] === 0x2a;
        if (ii || mm) return true;
      }
      from = i + 1;
    }
    return false;
  }

  function safetyScan(bytes) {
    var found = [];
    function hit(asciiNeedle, tag, value, sens) {
      var n = fromLatin1(asciiNeedle);
      if (indexOfBytes(bytes, n) >= 0) found.push(item(tag, value, 'Signature', 'byte signature', sens ? { sensitive: sens } : null));
    }
    if (hasExifHeader(bytes)) {
      found.push(item('EXIF header', 'Exif header signature still present', 'Signature', 'byte signature'));
    }
    hit('<?xpacket', 'XMP packet', 'XMP packet still present');
    hit('<x:xmpmeta', 'XMP packet', 'XMP metadata element still present');
    hit('http://ns.adobe.com/xap/1.0/', 'XMP packet', 'XMP namespace still present');
    hit('GPSLatitude', 'GPSLatitude', 'GPSLatitude marker still present', 'gps');
    hit('GPSLongitude', 'GPSLongitude', 'GPSLongitude marker still present', 'gps');
    hit('BodySerialNumber', 'BodySerialNumber', 'BodySerialNumber marker still present', 'serial');
    hit('LensSerialNumber', 'LensSerialNumber', 'LensSerialNumber marker still present', 'serial');
    hit('CameraSerialNumber', 'CameraSerialNumber', 'CameraSerialNumber marker still present', 'serial');
    var iso = findIso6709(bytes);
    if (iso) found.push(item('ISO6709', iso, 'Location', 'byte signature', { sensitive: 'gps' }));
    return found;
  }

  function mergeSafety(items, bytes) {
    var safety = safetyScan(bytes);
    var hasExif = items.some(function (i) { return /exif|tiff|app1/i.test(i.source || ''); });
    var hasXmp = items.some(function (i) { return i.group === 'XMP' || /xmp/i.test(i.source || ''); });
    var hasGps = items.some(function (i) { return i.sensitive === 'gps'; });
    var hasSerial = items.some(function (i) { return i.sensitive === 'serial'; });
    for (var i = 0; i < safety.length; i++) {
      var s = safety[i];
      if (s.tag === 'EXIF header' && hasExif) continue;
      if (s.tag === 'XMP packet' && hasXmp) continue;
      if (s.sensitive === 'gps' && hasGps) continue;
      if (s.sensitive === 'serial' && hasSerial) continue;
      items.push(s);
    }
    return dedupe(items);
  }

  /* ------------------------------------------------------------------ TIFF / EXIF */

  var TIFF_TAGS = {
    270: 'ImageDescription', 271: 'Make', 272: 'Model', 274: 'Orientation',
    282: 'XResolution', 283: 'YResolution', 296: 'ResolutionUnit',
    305: 'Software', 306: 'DateTime', 315: 'Artist', 316: 'HostComputer',
    33432: 'Copyright', 33434: 'ExposureTime', 33437: 'FNumber',
    34850: 'ExposureProgram', 34855: 'ISO', 36867: 'DateTimeOriginal',
    36868: 'DateTimeDigitized', 36880: 'OffsetTime', 36881: 'OffsetTimeOriginal',
    36882: 'OffsetTimeDigitized', 37386: 'FocalLength', 37500: 'MakerNote',
    37510: 'UserComment', 37520: 'SubSecTime', 37521: 'SubSecTimeOriginal',
    37522: 'SubSecTimeDigitized', 40962: 'PixelXDimension', 40963: 'PixelYDimension',
    41728: 'FileSource', 41729: 'SceneType', 41986: 'ExposureMode',
    41987: 'WhiteBalance', 41990: 'SceneCaptureType', 42016: 'ImageUniqueID',
    42033: 'BodySerialNumber', 42035: 'LensMake', 42036: 'LensModel',
    42037: 'LensSerialNumber', 50708: 'UniqueCameraModel', 50735: 'CameraSerialNumber'
  };
  var GPS_TAGS = {
    0: 'GPSVersionID', 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef',
    4: 'GPSLongitude', 5: 'GPSAltitudeRef', 6: 'GPSAltitude', 7: 'GPSTimeStamp',
    8: 'GPSSatellites', 9: 'GPSStatus', 10: 'GPSMeasureMode', 11: 'GPSDOP',
    12: 'GPSSpeedRef', 13: 'GPSSpeed', 16: 'GPSImgDirectionRef', 17: 'GPSImgDirection',
    18: 'GPSMapDatum', 29: 'GPSDateStamp', 31: 'GPSHPositioningError'
  };
  var STRUCTURAL_TAGS = {
    256: 1, 257: 1, 258: 1, 259: 1, 262: 1, 273: 1, 277: 1, 278: 1, 279: 1,
    284: 1, 317: 1, 320: 1, 322: 1, 323: 1, 324: 1, 325: 1, 338: 1, 339: 1,
    274: 1, 282: 1, 283: 1, 296: 1, 513: 1, 514: 1, 512: 1, 517: 1, 518: 1,
    519: 1, 520: 1, 521: 1, 529: 1, 530: 1, 531: 1, 532: 1, 33421: 1, 33422: 1,
    36864: 1, 37121: 1, 40960: 1, 40961: 1, 0: 0
  };
  var KEEP_TIFF = {
    256: 1, 257: 1, 258: 1, 259: 1, 262: 1, 273: 1, 277: 1, 278: 1, 279: 1,
    284: 1, 317: 1, 320: 1, 322: 1, 323: 1, 324: 1, 325: 1, 338: 1, 339: 1,
    274: 1, 282: 1, 283: 1, 296: 1, 513: 1, 514: 1, 512: 1, 517: 1, 518: 1,
    519: 1, 520: 1, 521: 1, 529: 1, 530: 1, 531: 1, 532: 1, 33421: 1, 33422: 1
  };

  function typeSize(type) {
    return ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 })[type] || 0;
  }

  function tiffView(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function readTiffHeader(bytes, base) {
    if (base + 8 > bytes.length) return null;
    var endian = ascii(bytes, base, 2);
    if (endian !== 'II' && endian !== 'MM') return null;
    var le = endian === 'II';
    var view = tiffView(bytes);
    if (view.getUint16(base + 2, le) !== 42) return null;
    return { endian: endian, le: le, view: view, first: view.getUint32(base + 4, le) };
  }

  function readInlineOrPointed(bytes, hdr, base, type, count, valueOff) {
    var sz = typeSize(type) * count;
    if (!sz || sz < 0 || sz > 50 * 1024 * 1024) return null;
    if (sz <= 4) return bytes.slice(valueOff, valueOff + sz);
    var off = hdr.view.getUint32(valueOff, hdr.le);
    var start = base + off;
    if (start < 0 || start + sz > bytes.length) return null;
    return bytes.slice(start, start + sz);
  }

  function readNumbers(data, le, type, count) {
    if (!data) return [];
    var view = tiffView(data);
    var out = [];
    var i;
    if (type === 1 || type === 7 || type === 6) {
      for (i = 0; i < count && i < data.length; i++) out.push(data[i]);
    } else if (type === 3 || type === 8) {
      for (i = 0; i < count; i++) out.push(view.getUint16(i * 2, le));
    } else if (type === 4 || type === 9 || type === 13) {
      for (i = 0; i < count; i++) out.push(view.getUint32(i * 4, le));
    } else if (type === 5 || type === 10) {
      for (i = 0; i < count; i++) {
        var n = view.getUint32(i * 8, le);
        var d = view.getUint32(i * 8 + 4, le) || 1;
        out.push(n / d);
      }
    }
    return out;
  }

  function asciiFrom(data) {
    if (!data) return '';
    var s = latin1(data).replace(/\u0000+$/g, '').replace(/\u0000/g, ' ').trim();
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s)) return s;
    var printable = '';
    for (var i = 0; i < data.length && printable.length < 80; i++) {
      var c = data[i];
      if (c === 0) break;
      printable += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
    }
    return printable || ('(' + data.length + ' bytes)');
  }

  function formatNumbers(tag, group, nums) {
    if ((tag === 2 || tag === 4 || tag === 20 || tag === 22) && group === 'GPS' && nums.length >= 3) {
      var dec = nums[0] + nums[1] / 60 + nums[2] / 3600;
      return nums[0] + ' deg ' + nums[1] + "' " + nums[2] + '" (' + dec.toFixed(5) + ' deg)';
    }
    if (nums.length > 8) return nums.slice(0, 8).join(', ') + '… (' + nums.length + ')';
    return nums.map(function (n) {
      if (typeof n === 'number' && !isFinite(n)) return String(n);
      if (typeof n === 'number' && Math.abs(n) >= 1 && Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
      if (typeof n === 'number') return String(Math.round(n * 100000) / 100000);
      return String(n);
    }).join(', ');
  }

  function tagLabel(tag, group) {
    if (group === 'GPS' && GPS_TAGS[tag]) return GPS_TAGS[tag];
    if (TIFF_TAGS[tag]) return TIFF_TAGS[tag];
    return 'Tag' + tag;
  }

  function parseTiffMetadata(bytes, base, source) {
    var items = [];
    var hdr = readTiffHeader(bytes, base || 0);
    if (!hdr) return items;
    base = base || 0;
    var seen = Object.create(null);

    function walk(offset, group, depth) {
      if (depth > 6 || !offset || seen[offset]) return;
      seen[offset] = 1;
      var off = base + offset;
      if (off + 2 > bytes.length) return;
      var count = hdr.view.getUint16(off, hdr.le);
      if (count > 2000 || off + 2 + count * 12 + 4 > bytes.length) return;
      for (var i = 0; i < count; i++) {
        var e = off + 2 + i * 12;
        var tag = hdr.view.getUint16(e, hdr.le);
        var type = hdr.view.getUint16(e + 2, hdr.le);
        var cnt = hdr.view.getUint32(e + 4, hdr.le);
        if (tag === 34665) {
          var ex = readNumbers(readInlineOrPointed(bytes, hdr, base, type, cnt, e + 8), hdr.le, type, cnt);
          if (ex.length) walk(ex[0], 'Exif', depth + 1);
          continue;
        }
        if (tag === 34853) {
          var gp = readNumbers(readInlineOrPointed(bytes, hdr, base, type, cnt, e + 8), hdr.le, type, cnt);
          if (gp.length) walk(gp[0], 'GPS', depth + 1);
          continue;
        }
        if (tag === 700) {
          var xmp = readInlineOrPointed(bytes, hdr, base, type, cnt, e + 8);
          if (xmp) items.push.apply(items, parseXmp(xmp, source || 'TIFF XMP'));
          continue;
        }
        if (STRUCTURAL_TAGS[tag] && group !== 'GPS') continue;
        if (tag === 34665 || tag === 34853 || tag === 330) continue;
        var name = tagLabel(tag, group);
        var data = readInlineOrPointed(bytes, hdr, base, type, cnt, e + 8);
        var display;
        if (tag === 37510 && data && data.length > 8) {
          display = asciiFrom(data.subarray(8));
        } else if (tag === 37500) {
          display = '(' + (data ? data.length : cnt) + ' bytes)';
        } else if (type === 2) {
          display = asciiFrom(data);
        } else if (type === 1 && tag === 0 && group === 'GPS') {
          display = data ? Array.prototype.join.call(data, '.') : '';
        } else if (type === 1 || type === 3 || type === 4 || type === 5 || type === 9 || type === 10) {
          var nums = readNumbers(data, hdr.le, type, cnt);
          display = formatNumbers(tag, group, nums);
        } else if (type === 7) {
          display = data && data.length <= 16 ? asciiFrom(data) : ('(' + (data ? data.length : 0) + ' bytes)');
          if (tag === 1 || tag === 3) display = asciiFrom(data);
        } else {
          display = data ? ('(' + data.length + ' bytes)') : '';
        }
        if (display) items.push(item(name, display, group, source || 'TIFF'));
      }
      var next = hdr.view.getUint32(off + 2 + count * 12, hdr.le);
      if ((group === 'IFD0' || group === 'IFD1') && next) walk(next, group === 'IFD0' ? 'IFD1' : 'IFD2', depth + 1);
    }

    walk(hdr.first, 'IFD0', 0);
    return items;
  }

  function stripJpegBlob(blob) {
    try {
      if (blob && blob.length > 4 && blob[0] === 0xff && blob[1] === 0xd8) return stripJpeg(blob).bytes;
    } catch (e) { /* keep original blob */ }
    return blob;
  }

  function rebuildTiff(bytes) {
    var hdr = readTiffHeader(bytes, 0);
    if (!hdr) {
      var magic = bytes.length >= 4 ? u16be(bytes, 2) : 0;
      if (magic === 43 || (bytes[0] === 0x49 && bytes[2] === 0x2b) || (bytes[0] === 0x4d && bytes[3] === 0x2b)) {
        throw new Error('BigTIFF is not supported. The file was not modified.');
      }
      throw new Error('Not a baseline TIFF. The file was not modified.');
    }
    var pages = [];
    var seen = Object.create(null);
    var off = hdr.first;
    while (off && !seen[off] && pages.length < 32) {
      seen[off] = 1;
      if (off + 2 > bytes.length) break;
      var count = hdr.view.getUint16(off, hdr.le);
      if (count > 4000 || off + 2 + count * 12 + 4 > bytes.length) break;
      var entries = [];
      var compression = 1;
      for (var i = 0; i < count; i++) {
        var e = off + 2 + i * 12;
        var tag = hdr.view.getUint16(e, hdr.le);
        var type = hdr.view.getUint16(e + 2, hdr.le);
        var cnt = hdr.view.getUint32(e + 4, hdr.le);
        var data = readInlineOrPointed(bytes, hdr, 0, type, cnt, e + 8);
        var nums = readNumbers(data, hdr.le, type, Math.min(cnt, 100000));
        if (tag === 259 && nums.length) compression = nums[0];
        entries.push({
          tag: tag, type: type, count: cnt, data: data, nums: nums,
          inline4: bytes.slice(e + 8, e + 12)
        });
      }
      var next = hdr.view.getUint32(off + 2 + count * 12, hdr.le);
      pages.push({ entries: entries, next: next, compression: compression });
      off = next;
    }
    if (!pages.length) throw new Error('TIFF has no image file directory.');

    function entry(page, tag) {
      for (var i = 0; i < page.entries.length; i++) if (page.entries[i].tag === tag) return page.entries[i];
      return null;
    }

    var prepared = [];
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var strips = entry(page, 273) || entry(page, 324);
      var counts = entry(page, 279) || entry(page, 325);
      var jpegOff = entry(page, 513);
      var blobs = [];
      if (strips && strips.nums && strips.nums.length && counts && counts.nums) {
        for (var s = 0; s < strips.nums.length; s++) {
          var start = strips.nums[s];
          var len = counts.nums[s] || 0;
          if (start + len > bytes.length) throw new Error('TIFF strip extends past the end of the file.');
          var blob = bytes.slice(start, start + len);
          blob = stripJpegBlob(blob);
          blobs.push(blob);
        }
      } else if (jpegOff && jpegOff.nums && jpegOff.nums.length) {
        var jlenE = entry(page, 514);
        var jstart = jpegOff.nums[0];
        var jlen = jlenE && jlenE.nums.length ? jlenE.nums[0] : 0;
        if (jstart + jlen > bytes.length) throw new Error('TIFF JPEG blob extends past the end of the file.');
        blobs.push(stripJpegBlob(bytes.slice(jstart, jstart + jlen)));
      }
      if (!blobs.length) continue;
      var kept = [];
      for (var k = 0; k < page.entries.length; k++) {
        var ent = page.entries[k];
        if (!KEEP_TIFF[ent.tag]) continue;
        if (ent.tag === 273 || ent.tag === 324 || ent.tag === 279 || ent.tag === 325 || ent.tag === 513 || ent.tag === 514) continue;
        if (!ent.data) continue;
        kept.push({ tag: ent.tag, type: ent.type, count: ent.count, data: ent.data });
      }
      var role = (strips && strips.tag === 324) ? 324 : (strips ? strips.tag : 513);
      if (role === 273 || role === 324) {
        kept.push({ tag: role, type: 4, count: blobs.length, data: null, kind: 'offsets' });
        kept.push({ tag: role === 273 ? 279 : 325, type: 4, count: blobs.length, data: null, kind: 'counts', blobs: blobs });
      } else {
        kept.push({ tag: 513, type: 4, count: 1, data: null, kind: 'jpegOff' });
        kept.push({ tag: 514, type: 4, count: 1, data: null, kind: 'jpegLen', blobs: blobs });
      }
      kept.sort(function (a, b) { return a.tag - b.tag; });
      prepared.push({ kept: kept, blobs: blobs });
    }
    if (!prepared.length) throw new Error('TIFF image data was not found, so the file was not modified.');

    var le = hdr.le;
    var cursor = 8;
    var layouts = [];
    for (var pi = 0; pi < prepared.length; pi++) {
      var prep = prepared[pi];
      var n = prep.kept.length;
      var ifdPos = cursor;
      cursor += 2 + n * 12 + 4;
      var extras = [];
      for (var ei = 0; ei < prep.kept.length; ei++) {
        var ke = prep.kept[ei];
        var sz = ke.data ? ke.data.length : 0;
        if (ke.kind === 'offsets' && ke.count > 1) sz = ke.count * 4;
        if (ke.kind === 'counts' && ke.count > 1) sz = ke.count * 4;
        if (sz > 4) {
          if (cursor & 1) cursor++;
          extras.push({ index: ei, pos: cursor, size: sz });
          cursor += sz;
        }
      }
      var blobPos = [];
      for (var bi = 0; bi < prep.blobs.length; bi++) {
        if (cursor & 1) cursor++;
        blobPos.push(cursor);
        cursor += prep.blobs[bi].length;
      }
      layouts.push({ ifdPos: ifdPos, extras: extras, blobPos: blobPos, prep: prep });
    }

    var out = new Uint8Array(cursor);
    var view = new DataView(out.buffer);
    out[0] = le ? 0x49 : 0x4d;
    out[1] = le ? 0x49 : 0x4d;
    view.setUint16(2, 42, le);
    view.setUint32(4, layouts[0].ifdPos, le);

    function writeNumbersAt(pos, type, count, nums) {
      var i;
      if (count === 1 && type === 4 && typeSize(4) * count <= 4) {
        view.setUint32(pos, nums[0], le);
        return;
      }
      if (count === 1 && type === 3) {
        view.setUint16(pos, nums[0], le);
        return;
      }
      for (i = 0; i < nums.length; i++) {
        if (type === 3) view.setUint16(pos + i * 2, nums[i], le);
        else view.setUint32(pos + i * 4, nums[i], le);
      }
    }

    for (var li = 0; li < layouts.length; li++) {
      var L = layouts[li];
      var kept = L.prep.kept;
      view.setUint16(L.ifdPos, kept.length, le);
      var next = li + 1 < layouts.length ? layouts[li + 1].ifdPos : 0;
      for (var ti = 0; ti < kept.length; ti++) {
        var ent2 = kept[ti];
        var ep = L.ifdPos + 2 + ti * 12;
        view.setUint16(ep, ent2.tag, le);
        view.setUint16(ep + 2, ent2.type, le);
        view.setUint32(ep + 4, ent2.count, le);
        var extra = null;
        for (var xi = 0; xi < L.extras.length; xi++) if (L.extras[xi].index === ti) extra = L.extras[xi];
        if (ent2.kind === 'offsets' || ent2.kind === 'jpegOff') {
          if (ent2.count === 1) view.setUint32(ep + 8, L.blobPos[0], le);
          else {
            view.setUint32(ep + 8, extra.pos, le);
            for (var oi = 0; oi < L.blobPos.length; oi++) view.setUint32(extra.pos + oi * 4, L.blobPos[oi], le);
          }
        } else if (ent2.kind === 'counts' || ent2.kind === 'jpegLen') {
          var lens = L.prep.blobs.map(function (b) { return b.length; });
          if (ent2.count === 1) view.setUint32(ep + 8, lens[0], le);
          else {
            view.setUint32(ep + 8, extra.pos, le);
            for (var ci = 0; ci < lens.length; ci++) view.setUint32(extra.pos + ci * 4, lens[ci], le);
          }
        } else if (ent2.data.length <= 4) {
          out.set(ent2.data, ep + 8);
        } else {
          view.setUint32(ep + 8, extra.pos, le);
          out.set(ent2.data, extra.pos);
        }
      }
      view.setUint32(L.ifdPos + 2 + kept.length * 12, next, le);
      for (var bbi = 0; bbi < L.prep.blobs.length; bbi++) out.set(L.prep.blobs[bbi], L.blobPos[bbi]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ JPEG */

  function jpegMarkerName(marker, payload) {
    if (marker === 0xfe) return 'JPEG comment';
    if (marker === 0xe0) return 'JFIF APP0';
    if (marker === 0xe1) {
      if (ascii(payload, 0, 6) === 'Exif\x00\x00') return 'EXIF APP1';
      if (ascii(payload, 0, 29) === 'http://ns.adobe.com/xap/1.0/\x00') return 'XMP APP1';
      return 'APP1';
    }
    if (marker === 0xe2) {
      if (ascii(payload, 0, 12) === 'ICC_PROFILE\x00') return 'ICC APP2';
      if (ascii(payload, 0, 4) === 'MPF\x00') return 'MPF APP2';
      return 'APP2';
    }
    if (marker >= 0xe0 && marker <= 0xef) return 'APP' + (marker - 0xe0);
    return 'marker ' + marker.toString(16);
  }

  function dropJpegMarker(marker, payload) {
    if (marker === 0xee && ascii(payload, 0, 5) === 'Adobe') return null;
    if (marker === 0xfe) return 'Removed JPEG comment';
    if (marker >= 0xe0 && marker <= 0xef) return 'Removed ' + jpegMarkerName(marker, payload);
    return null;
  }

  function scanJpeg(bytes) {
    var items = [];
    var notes = [];
    walkJpeg(bytes, function (marker, payload) {
      if (marker === 0xfe) {
        items.push(item('Comment', asciiFrom(payload), 'JPEG', 'JPEG COM'));
      } else if (marker === 0xe1 && ascii(payload, 0, 6) === 'Exif\x00\x00') {
        items.push.apply(items, parseTiffMetadata(payload, 6, 'JPEG APP1 EXIF'));
      } else if (marker === 0xe1 && ascii(payload, 0, 29) === 'http://ns.adobe.com/xap/1.0/\x00') {
        items.push.apply(items, parseXmp(payload.subarray(29), 'JPEG APP1 XMP'));
      } else if (marker === 0xed && ascii(payload, 0, 14) === 'Photoshop 3.0\x00') {
        items.push.apply(items, parseIptcFrom8bim(payload.subarray(14)));
      } else if (marker === 0xe2 && ascii(payload, 0, 4) === 'MPF\x00') {
        items.push(item('MPF', 'Multi-Picture Format segment', 'JPEG', 'JPEG APP2'));
      }
      return true;
    }, notes);
    return items;
  }

  function parseIptcFrom8bim(data) {
    var items = [];
    var i = 0;
    var names = {
      5: 'ObjectName', 25: 'Keywords', 80: 'By-line', 85: 'By-lineTitle', 90: 'City',
      92: 'SubLocation', 95: 'Province', 101: 'Country', 105: 'Headline',
      116: 'Copyright', 120: 'Caption', 122: 'CaptionWriter'
    };
    while (i + 8 <= data.length) {
      if (ascii(data, i, 4) !== '8BIM') break;
      var id = u16be(data, i + 4);
      var nameLen = data[i + 6];
      var nameSize = nameLen + 1;
      if (nameSize % 2) nameSize++;
      var p = i + 6 + nameSize;
      if (p + 4 > data.length) break;
      var size = u32be(data, p);
      var body = data.subarray(p + 4, Math.min(data.length, p + 4 + size));
      if (id === 0x0404) {
        var q = 0;
        while (q + 5 <= body.length) {
          if (body[q] !== 0x1c) { q++; continue; }
          var rec = body[q + 1];
          var ds = body[q + 2];
          var len = u16be(body, q + 3);
          if (len & 0x8000) break;
          var text = latin1(body.subarray(q + 5, q + 5 + len)).replace(/\u0000/g, '').trim();
          if (rec === 2 && text) items.push(item(names[ds] || ('IPTC_' + ds), text, 'IPTC', 'JPEG APP13'));
          q += 5 + len;
        }
      }
      var padded = size + (size % 2);
      i = p + 4 + padded;
    }
    return items;
  }

  function walkJpeg(bytes, onSegment) {
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw new Error('Not a JPEG.');
    var i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) throw new Error('Lost JPEG marker sync.');
      i++;
      while (i < bytes.length && bytes[i] === 0xff) i++;
      if (i >= bytes.length) break;
      var marker = bytes[i++];
      if (marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
        if (marker === 0xd9) break;
        continue;
      }
      if (i + 2 > bytes.length) throw new Error('Truncated JPEG segment.');
      var seglen = (bytes[i] << 8) | bytes[i + 1];
      if (seglen < 2 || i + seglen > bytes.length) throw new Error('Bad JPEG segment length.');
      var payload = bytes.subarray(i + 2, i + seglen);
      var cont = onSegment(marker, payload, i - 2, i + seglen);
      i += seglen;
      if (marker === 0xda) {
        while (i < bytes.length) {
          if (bytes[i] !== 0xff) { i++; continue; }
          var j = i + 1;
          while (j < bytes.length && bytes[j] === 0xff) j++;
          if (j >= bytes.length) { i = bytes.length; break; }
          var m = bytes[j];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { i = j + 1; continue; }
          break;
        }
        if (cont === false) break;
        continue;
      }
    }
  }

  function stripJpeg(bytes) {
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw new Error('Not a JPEG.');
    var parts = [bytes.subarray(0, 2)];
    var notes = [];
    var i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) throw new Error('Lost JPEG marker sync.');
      var markerStart = i;
      i++;
      while (i < bytes.length && bytes[i] === 0xff) i++;
      if (i >= bytes.length) break;
      var marker = bytes[i++];
      if (marker === 0xd9) {
        parts.push(bytes.subarray(markerStart, i));
        break;
      }
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(bytes.subarray(markerStart, i));
        continue;
      }
      if (i + 2 > bytes.length) throw new Error('Truncated JPEG segment.');
      var seglen = (bytes[i] << 8) | bytes[i + 1];
      if (seglen < 2 || i + seglen > bytes.length) throw new Error('Bad JPEG segment length.');
      var segEnd = i + seglen;
      var payload = bytes.subarray(i + 2, segEnd);
      if (marker === 0xda) {
        parts.push(bytes.subarray(markerStart, segEnd));
        var ent = segEnd;
        i = segEnd;
        while (i < bytes.length) {
          if (bytes[i] !== 0xff) { i++; continue; }
          var j = i + 1;
          while (j < bytes.length && bytes[j] === 0xff) j++;
          if (j >= bytes.length) { i = bytes.length; break; }
          var m = bytes[j];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { i = j + 1; continue; }
          break;
        }
        parts.push(bytes.subarray(ent, i));
        continue;
      }
      var why = dropJpegMarker(marker, payload);
      if (why) notes.push(why);
      else parts.push(bytes.subarray(markerStart, segEnd));
      i = segEnd;
    }
    if (!notes.length) notes.push('No JPEG metadata segments were present.');
    else if (notes.some(function (n) { return n.indexOf('ICC') >= 0; })) notes.push('The ICC profile was removed. Colors may shift.');
    return { bytes: concat(parts), notes: notes };
  }

  /* ------------------------------------------------------------------ PNG */

  var PNG_KEEP = { IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, bKGD: 1, sBIT: 1, pHYs: 1, cICP: 1 };
  var PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function walkPng(bytes, fn) {
    if (!startsWith(bytes, PNG_SIG)) throw new Error('Not a PNG.');
    var i = 8;
    while (i + 12 <= bytes.length) {
      var len = u32be(bytes, i);
      var type = ascii(bytes, i + 4, 4);
      if (i + 12 + len > bytes.length) throw new Error('Truncated PNG chunk.');
      var data = bytes.subarray(i + 8, i + 8 + len);
      var whole = bytes.subarray(i, i + 12 + len);
      fn(type, data, whole);
      i += 12 + len;
      if (type === 'IEND') break;
    }
  }

  async function scanPngFull(bytes) {
    var items = [];
    var jobs = [];
    walkPng(bytes, function (type, data) {
      if (type === 'tEXt') {
        var z = indexOfBytes(data, [0]);
        var key = latin1(data.subarray(0, z < 0 ? data.length : z));
        var val = z < 0 ? '' : latin1(data.subarray(z + 1));
        if (/xmp|XML:com\.adobe/i.test(key)) items.push.apply(items, parseXmp(val, 'PNG tEXt'));
        else if (val.trim()) items.push(item(key || 'tEXt', val.trim(), 'PNG', 'PNG tEXt'));
      } else if (type === 'zTXt') {
        jobs.push({ type: type, data: data });
      } else if (type === 'iTXt') {
        jobs.push({ type: type, data: data });
      } else if (type === 'eXIf') {
        items.push.apply(items, parseTiffMetadata(data, 0, 'PNG eXIf'));
      } else if (type === 'tIME' && data.length >= 7) {
        items.push(item('tIME', u16be(data, 0) + '-' + data[2] + '-' + data[3] + ' ' + data[4] + ':' + data[5] + ':' + data[6], 'PNG', 'PNG tIME'));
      } else if (!PNG_KEEP[type]) {
        items.push(item(type, 'Metadata chunk (' + data.length + ' bytes)', 'PNG', 'PNG chunk'));
      }
    });
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      try {
        if (job.type === 'zTXt') {
          var z0 = indexOfBytes(job.data, [0]);
          var keyz = latin1(job.data.subarray(0, z0));
          var inflated = await inflate(job.data.subarray(z0 + 2), 'deflate');
          var text = new TextDecoder().decode(inflated);
          if (/xmp/i.test(keyz)) items.push.apply(items, parseXmp(text, 'PNG zTXt'));
          else items.push(item(keyz || 'zTXt', text.trim(), 'PNG', 'PNG zTXt'));
        } else {
          var p = 0;
          var keyi = readCString(job.data, p); p = keyi.end;
          p += 2;
          var lang = readCString(job.data, p); p = lang.end;
          var trans = readCString(job.data, p); p = trans.end;
          var rest = job.data.subarray(p);
          var body = job.data[keyi.end] ? new TextDecoder().decode(await inflate(rest, 'deflate')) : new TextDecoder().decode(rest);
          if (/xmp|XML/i.test(keyi.s)) items.push.apply(items, parseXmp(body, 'PNG iTXt'));
          else if (body.trim()) items.push(item(keyi.s || 'iTXt', body.trim(), 'PNG', 'PNG iTXt'));
        }
      } catch (e) {
        items.push(item(job.type, 'Unreadable text chunk', 'PNG', 'PNG ' + job.type));
      }
    }
    return items;
  }

  function readCString(data, p) {
    var s = '';
    while (p < data.length && data[p] !== 0) { s += String.fromCharCode(data[p]); p++; }
    return { s: s, end: p + 1 };
  }

  function stripPng(bytes) {
    var parts = [bytes.subarray(0, 8)];
    var notes = [];
    walkPng(bytes, function (type, data, whole) {
      if (PNG_KEEP[type]) parts.push(whole);
      else notes.push('Removed PNG ' + type + ' chunk');
    });
    if (!notes.length) notes.push('No PNG metadata chunks were present.');
    if (notes.some(function (n) { return n.indexOf('iCCP') >= 0; })) notes.push('The ICC profile was removed. Colors may shift.');
    return { bytes: concat(parts), notes: notes };
  }

  /* ------------------------------------------------------------------ WebP */

  function walkWebp(bytes, fn) {
    if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') throw new Error('Not a WebP.');
    var i = 12;
    while (i + 8 <= bytes.length) {
      var type = ascii(bytes, i, 4);
      var size = u32le(bytes, i + 4);
      if (i + 8 + size > bytes.length) break;
      fn(type, bytes.subarray(i + 8, i + 8 + size));
      i += 8 + size + (size & 1);
    }
  }

  function scanWebp(bytes) {
    var items = [];
    walkWebp(bytes, function (type, data) {
      if (type === 'EXIF') items.push.apply(items, parseTiffMetadata(data, 0, 'WebP EXIF'));
      else if (type === 'XMP ' || type === 'XMP\0') items.push.apply(items, parseXmp(data, 'WebP XMP'));
    });
    return items;
  }

  function stripWebp(bytes) {
    var chunks = [];
    var notes = [];
    walkWebp(bytes, function (type, data) {
      if (type === 'EXIF') { notes.push('Removed WebP EXIF chunk'); return; }
      if (type === 'XMP ' || type === 'XMP\0') { notes.push('Removed WebP XMP chunk'); return; }
      if (type === 'ICCP') { notes.push('Removed WebP ICC profile. Colors may shift.'); return; }
      var copy = data.slice();
      if (type === 'VP8X' && copy.length) {
        copy[0] = copy[0] & ~0x2c;
      }
      chunks.push({ type: type, data: copy });
    });
    var parts = [new Uint8Array(12)];
    for (var i = 0; i < chunks.length; i++) {
      var h = new Uint8Array(8);
      var t = chunks[i].type;
      h[0] = t.charCodeAt(0); h[1] = t.charCodeAt(1); h[2] = t.charCodeAt(2); h[3] = t.charCodeAt(3);
      setU32le(h, 4, chunks[i].data.length);
      parts.push(h, chunks[i].data);
      if (chunks[i].data.length & 1) parts.push(new Uint8Array(1));
    }
    var out = concat(parts);
    out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;
    setU32le(out, 4, out.length - 8);
    out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50;
    if (!notes.length) notes.push('No WebP metadata chunks were present.');
    return { bytes: out, notes: notes };
  }

  /* ------------------------------------------------------------------ GIF */

  function scanGif(bytes) {
    var items = [];
    walkGif(bytes, function (kind, data, app) {
      if (kind === 'comment') items.push(item('Comment', asciiFrom(data), 'GIF', 'GIF comment'));
      else if (kind === 'app' && ascii(app, 0, 11) === 'XMP DataXMP') items.push.apply(items, parseXmp(data, 'GIF XMP'));
      else if (kind === 'app' && ascii(app, 0, 11) !== 'NETSCAPE2.0' && ascii(app, 0, 8) !== 'ANIMEXTS') {
        items.push(item('Application', latin1(app.subarray(0, 11)), 'GIF', 'GIF application'));
      }
    });
    return items;
  }

  function walkGif(bytes, fn) {
    if (!(ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) throw new Error('Not a GIF.');
    var packed = bytes[10];
    var gct = (packed & 0x80) ? (3 * (1 << ((packed & 7) + 1))) : 0;
    var i = 13 + gct;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b === 0x3b) break;
      if (b === 0x2c) {
        var ip = bytes[i + 9];
        var lct = (ip & 0x80) ? (3 * (1 << ((ip & 7) + 1))) : 0;
        i = i + 10 + lct;
        i++;
        while (i < bytes.length) {
          var n = bytes[i++];
          if (!n) break;
          i += n;
        }
        continue;
      }
      if (b === 0x21) {
        var ext = bytes[i + 1];
        var start = i;
        i += 2;
        var app = null;
        if (ext === 0xff && bytes[i] === 11) {
          app = bytes.subarray(i + 1, i + 12);
        }
        var payload = [];
        while (i < bytes.length) {
          var sz = bytes[i++];
          if (!sz) break;
          payload.push(bytes.subarray(i, i + sz));
          i += sz;
        }
        var joined = concat(payload.length ? payload : [new Uint8Array(0)]);
        if (ext === 0xfe) fn('comment', joined, null, start, i);
        else if (ext === 0xff) fn('app', joined, app || new Uint8Array(0), start, i);
        else fn('other', joined, null, start, i);
        continue;
      }
      throw new Error('Unexpected GIF block.');
    }
  }

  function stripGif(bytes) {
    if (!(ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) throw new Error('Not a GIF.');
    var packed = bytes[10];
    var gct = (packed & 0x80) ? (3 * (1 << ((packed & 7) + 1))) : 0;
    var headerEnd = 13 + gct;
    var parts = [bytes.subarray(0, headerEnd)];
    var notes = [];
    var i = headerEnd;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b === 0x3b) { parts.push(bytes.subarray(i, i + 1)); break; }
      if (b === 0x2c) {
        var start = i;
        var ip = bytes[i + 9];
        var lct = (ip & 0x80) ? (3 * (1 << ((ip & 7) + 1))) : 0;
        i = i + 10 + lct;
        i++;
        while (i < bytes.length) {
          var n = bytes[i++];
          if (!n) break;
          i += n;
        }
        parts.push(bytes.subarray(start, i));
        continue;
      }
      if (b === 0x21) {
        var ext = bytes[i + 1];
        var startE = i;
        i += 2;
        var app = null;
        if (ext === 0xff && i < bytes.length && bytes[i] === 11) app = ascii(bytes, i + 1, 11);
        while (i < bytes.length) {
          var sz = bytes[i++];
          if (!sz) break;
          i += sz;
        }
        var drop = false;
        if (ext === 0xfe) { drop = true; notes.push('Removed GIF comment'); }
        else if (ext === 0xff && app === 'NETSCAPE2.0') drop = false;
        else if (ext === 0xff && app && app.indexOf('ANIMEXTS') === 0) drop = false;
        else if (ext === 0xff) { drop = true; notes.push('Removed GIF application extension' + (app ? ' (' + app.trim() + ')' : '')); }
        else drop = false;
        if (!drop) parts.push(bytes.subarray(startE, i));
        continue;
      }
      throw new Error('Unexpected GIF block.');
    }
    if (!notes.length) notes.push('No GIF comment or XMP extensions were present.');
    return { bytes: concat(parts), notes: notes };
  }

  root.__exifExorcistParts = {
    concat: concat, ascii: ascii, latin1: latin1, fromLatin1: fromLatin1,
    u16be: u16be, u16le: u16le, u32be: u32be, u32le: u32le,
    setU32be: setU32be, setU32le: setU32le, setU64be: setU64be, u64be: u64be,
    indexOfBytes: indexOfBytes, lastIndexOfAscii: lastIndexOfAscii,
    inflate: inflate, crc32: crc32, item: item, dedupe: dedupe,
    sensitivity: sensitivity, parseXmp: parseXmp, parseTiffMetadata: parseTiffMetadata,
    mergeSafety: mergeSafety, safetyScan: safetyScan, findIso6709: findIso6709,
    stripJpeg: stripJpeg, scanJpeg: scanJpeg, rebuildTiff: rebuildTiff,
    scanPngFull: scanPngFull, stripPng: stripPng, scanWebp: scanWebp, stripWebp: stripWebp,
    scanGif: scanGif, stripGif: stripGif, VERSION: VERSION, startsWith: startsWith,
    bytesEq: bytesEq, fourcc: fourcc
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
