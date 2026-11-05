(function () {
  'use strict';
  var EE = globalThis.ExifExorcist;
  var files = [];
  var nextId = 1;

  var drop = document.getElementById('drop');
  var picker = document.getElementById('file-input');
  var list = document.getElementById('file-list');
  var empty = document.getElementById('empty');
  var stripBtn = document.getElementById('strip');
  var zipBtn = document.getElementById('zip');
  var status = document.getElementById('status');
  var summary = document.getElementById('summary');
  var modeNote = document.getElementById('mode-note');

  function mode() {
    var picked = document.querySelector('input[name="mode"]:checked');
    return picked ? picked.value : 'lossless';
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function describeMode() {
    if (mode() === 'canvas') {
      modeNote.textContent = 'Canvas re-encode is on. Images are decoded and written as new PNGs. Quality, color, animation, and bit depth can change. Other file types still use lossless container stripping.';
    } else {
      modeNote.textContent = 'Lossless mode is on. Metadata containers are removed and the compressed picture, page, or audio data stays as it was.';
    }
  }

  document.querySelectorAll('input[name="mode"]').forEach(function (el) {
    el.addEventListener('change', describeMode);
  });
  describeMode();

  drop.addEventListener('click', function () { picker.click(); });
  drop.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      picker.click();
    }
  });
  ['dragenter', 'dragover'].forEach(function (name) {
    drop.addEventListener(name, function (ev) {
      ev.preventDefault();
      drop.classList.add('hot');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    drop.addEventListener(name, function (ev) {
      ev.preventDefault();
      drop.classList.remove('hot');
    });
  });
  drop.addEventListener('drop', function (ev) {
    takeFiles(ev.dataTransfer.files);
  });
  picker.addEventListener('change', function () {
    takeFiles(picker.files);
    picker.value = '';
  });

  function takeFiles(listLike) {
    var incoming = Array.prototype.slice.call(listLike || []);
    if (!incoming.length) return;
    setStatus('Reading ' + incoming.length + ' file' + (incoming.length === 1 ? '' : 's') + '.');
    var pending = incoming.length;
    incoming.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        files.push({
          id: nextId++,
          name: file.name || 'untitled',
          bytes: new Uint8Array(reader.result),
          detected: null,
          before: null,
          result: null
        });
        pending--;
        if (!pending) scanNew();
      };
      reader.onerror = function () {
        pending--;
        setStatus('Could not read ' + (file.name || 'a file') + '.');
        if (!pending) scanNew();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function scanNew() {
    for (var i = 0; i < files.length; i++) {
      if (files[i].before) continue;
      files[i].before = await EE.scan(files[i].bytes);
      files[i].detected = files[i].before.detected;
    }
    render();
    var gps = 0;
    var serial = 0;
    files.forEach(function (f) {
      (f.before.items || []).forEach(function (it) {
        if (it.sensitive === 'gps') gps++;
        if (it.sensitive === 'serial') serial++;
      });
    });
    setStatus(files.length + ' file' + (files.length === 1 ? '' : 's') + ' scanned. ' + gps + ' GPS field' + (gps === 1 ? '' : 's') + ', ' + serial + ' serial field' + (serial === 1 ? '' : 's') + '.');
    stripBtn.disabled = files.length === 0;
    stripBtn.focus();
  }

  stripBtn.addEventListener('click', async function () {
    stripBtn.disabled = true;
    zipBtn.disabled = true;
    var useCanvas = mode() === 'canvas';
    for (var i = 0; i < files.length; i++) {
      setStatus('Stripping ' + (i + 1) + ' of ' + files.length + '.');
      files[i].result = await exorcise(files[i], useCanvas);
    }
    render();
    var counts = { clear: 0, residual: 0, unverified: 0, failed: 0 };
    files.forEach(function (f) { counts[f.result.verdict.level] = (counts[f.result.verdict.level] || 0) + 1; });
    var line = 'Finished. ' +
      counts.clear + ' with no metadata detected, ' +
      counts.unverified + ' not certified, ' +
      counts.residual + ' still carrying metadata, ' +
      counts.failed + ' not modified.';
    setStatus(line);
    summary.textContent = line;
    stripBtn.disabled = false;
    zipBtn.disabled = !files.some(function (f) { return f.result && f.result.bytes; });
    var first = document.querySelector('.verdict');
    if (first) first.focus();
  });

  async function exorcise(file, useCanvas) {
    var detected = file.detected || await EE.detect(file.bytes);
    var image = /^(jpeg|png|webp|gif|tiff|heic)$/.test(detected.format);
    if (useCanvas && image) {
      try {
        var png = await canvasPng(file.bytes, detected.mime);
        var after = await EE.scan(png);
        var stripped = {
          ok: true,
          format: 'png',
          support: 'full',
          bytes: png,
          notes: [
            'Re-encoded through the canvas to a new PNG.',
            'Only the first frame is kept for animated GIF and WebP.',
            'Color profile, bit depth, and fine detail can change. This is the lossy path.'
          ],
          blocksClear: false,
          changed: true
        };
        return { stripped: stripped, after: after, verdict: EE.judge(stripped, after), downloadName: downloadName(file.name, 'png'), bytes: png };
      } catch (err) {
        var failed = { ok: false, format: detected.format, support: detected.support, bytes: null, notes: [], blocksClear: true, reason: 'The browser could not decode this image for canvas re-encode (' + err.message + '). The original file was not modified.' };
        return { stripped: failed, after: file.before, verdict: EE.judge(failed, file.before), downloadName: null, bytes: null };
      }
    }
    var strippedLossless = await EE.stripLossless(file.bytes);
    var afterScan = strippedLossless.ok ? await EE.scan(strippedLossless.bytes) : file.before;
    return {
      stripped: strippedLossless,
      after: afterScan,
      verdict: EE.judge(strippedLossless, afterScan),
      downloadName: strippedLossless.ok ? downloadName(file.name, strippedLossless.format) : null,
      bytes: strippedLossless.ok ? strippedLossless.bytes : null
    };
  }

  function canvasPng(bytes, mime) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
      createImageBitmap(blob).then(function (bitmap) {
        var canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        canvas.toBlob(function (out) {
          if (!out) { reject(new Error('canvas returned nothing')); return; }
          out.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
        }, 'image/png');
      }, reject);
    });
  }

  function downloadName(original, format) {
    var base = String(original || 'file').replace(/\.[^.]+$/, '');
    if (!base) base = 'file';
    return base + '-stripped' + EE.extensionFor(format);
  }

  function downloadBytes(name, bytes, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  zipBtn.addEventListener('click', function () {
    var entries = [];
    var used = {};
    files.forEach(function (f) {
      if (!f.result || !f.result.bytes || !f.result.downloadName) return;
      var name = f.result.downloadName;
      if (used[name]) {
        var n = 2;
        var ext = name.replace(/^.*(\.[^.]+)$/, '$1');
        var stem = name.slice(0, name.length - ext.length);
        while (used[stem + '-' + n + ext]) n++;
        name = stem + '-' + n + ext;
      }
      used[name] = 1;
      entries.push({ name: name, data: f.result.bytes });
    });
    if (!entries.length) return;
    downloadBytes('exif-exorcist.zip', EE.writeZip(entries), 'application/zip');
  });

  function render() {
    list.textContent = '';
    empty.hidden = files.length !== 0;
    stripBtn.disabled = files.length === 0;
    files.forEach(function (file) { list.appendChild(card(file)); });
  }

  function card(file) {
    var art = document.createElement('article');
    art.className = 'card';
    art.tabIndex = -1;
    var head = document.createElement('header');
    head.className = 'card-head';
    var h = document.createElement('h3');
    h.textContent = file.name;
    head.appendChild(h);
    var det = file.detected;
    if (det) {
      head.appendChild(pill(det.label, 'format'));
      head.appendChild(pill(det.support === 'full' ? 'Full support' : (det.support === 'best-effort' ? 'Best effort' : 'Unsupported'), det.support === 'full' ? 'ok' : 'warn'));
    }
    art.appendChild(head);

    if (file.before) {
      art.appendChild(sectionTitle('Metadata found'));
      art.appendChild(metaTable(file.before.items));
    }
    if (file.result) {
      var v = file.result.verdict;
      var banner = document.createElement('p');
      banner.className = 'verdict ' + v.level;
      banner.tabIndex = -1;
      banner.textContent = v.title + '. ' + v.detail;
      art.appendChild(banner);
      if (file.result.stripped && file.result.stripped.ok) {
        art.appendChild(sectionTitle('After re-scan'));
        art.appendChild(metaTable(file.result.after ? file.result.after.items : []));
      }
      if (file.result.stripped && file.result.stripped.notes && file.result.stripped.notes.length) {
        var notes = document.createElement('ul');
        notes.className = 'notes';
        file.result.stripped.notes.forEach(function (n) {
          var li = document.createElement('li');
          li.textContent = n;
          notes.appendChild(li);
        });
        art.appendChild(notes);
      }
      if (file.result.bytes && file.result.downloadName) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Download ' + file.result.downloadName;
        btn.addEventListener('click', function () {
          downloadBytes(file.result.downloadName, file.result.bytes, 'application/octet-stream');
        });
        art.appendChild(btn);
      }
    }
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.textContent = 'Remove from list';
    remove.addEventListener('click', function () {
      files = files.filter(function (f) { return f.id !== file.id; });
      render();
      zipBtn.disabled = !files.some(function (f) { return f.result && f.result.bytes; });
      if (!files.length) summary.textContent = '';
    });
    art.appendChild(remove);
    return art;
  }

  function sectionTitle(text) {
    var p = document.createElement('h4');
    p.textContent = text;
    return p;
  }

  function pill(text, kind) {
    var s = document.createElement('span');
    s.className = 'pill ' + kind;
    s.textContent = text;
    return s;
  }

  function metaTable(items) {
    if (!items || !items.length) {
      var none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'No metadata found.';
      return none;
    }
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    var table = document.createElement('table');
    var cap = document.createElement('caption');
    cap.className = 'sr';
    cap.textContent = 'Metadata fields';
    table.appendChild(cap);
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['Field', 'Value', 'Where'].forEach(function (label) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tb = document.createElement('tbody');
    items.forEach(function (it) {
      var tr = document.createElement('tr');
      if (it.sensitive === 'gps') tr.className = 'gps';
      if (it.sensitive === 'serial') tr.className = 'serial';
      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = it.tag;
      if (it.sensitive === 'gps') th.appendChild(flag('GPS'));
      if (it.sensitive === 'serial') th.appendChild(flag('Serial'));
      var val = document.createElement('td');
      var shown = it.value.length > 400 ? it.value.slice(0, 400) + '…' : it.value;
      val.textContent = shown;
      var src = document.createElement('td');
      src.textContent = it.source || it.group || '';
      tr.appendChild(th);
      tr.appendChild(val);
      tr.appendChild(src);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    return wrap;
  }

  function flag(text) {
    var s = document.createElement('span');
    s.className = 'flag';
    s.textContent = text;
    return s;
  }
})();
