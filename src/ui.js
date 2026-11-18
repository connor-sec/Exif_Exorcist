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
  var cleanPackBtn = document.getElementById('clean-pack');
  var folderBtn = document.getElementById('pick-folder');
  var folderInput = document.getElementById('folder-input');
  var neutralBox = document.getElementById('neutral-names');
  var prefixInput = document.getElementById('name-prefix');
  var namesBox = document.getElementById('manifest-names');
  var originalHashBox = document.getElementById('manifest-original-hash');
  var packNote = document.getElementById('pack-note');
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

  function syncPackNote() {
    var neutral = neutralBox.checked;
    prefixInput.disabled = !neutral;
    if (neutral) {
      var prefix = EE.sanitizePrefix(prefixInput.value);
      packNote.textContent = 'Outputs are named ' + prefix + '-001, ' + prefix + '-002, and so on. Original filenames are left out of the manifest unless you opt in. Folder paths are never written.';
    } else {
      packNote.textContent = 'Neutral names are off. Each output keeps its original file name plus -stripped, so that name is in the zip. The manifest lists it in its own column only if you opt in.';
    }
  }
  neutralBox.addEventListener('change', syncPackNote);
  prefixInput.addEventListener('input', syncPackNote);
  syncPackNote();

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
    if (canWalkItems(ev.dataTransfer && ev.dataTransfer.items)) readDropItems(ev.dataTransfer.items);
    else takeFiles(ev.dataTransfer.files);
  });
  folderBtn.addEventListener('click', function () { folderInput.click(); });
  folderInput.addEventListener('change', function () {
    takeFiles(folderInput.files);
    folderInput.value = '';
  });
  picker.addEventListener('change', function () {
    takeFiles(picker.files);
    picker.value = '';
  });

  function canWalkItems(items) {
    if (!items || !items.length) return false;
    for (var i = 0; i < items.length; i++) if (items[i].webkitGetAsEntry) return true;
    return false;
  }

  /* A dropped folder is a directory entry. dataTransfer.files does not list
     the files inside it. Read the tree locally. Names stored later are the
     file's own name, never the relative folder path. */
  function readDropItems(itemList) {
    var collected = [];
    var tasks = [];
    function readAll(reader) {
      var all = [];
      function read() {
        return new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); }).then(function (batch) {
          if (!batch.length) return all;
          for (var i = 0; i < batch.length; i++) all.push(batch[i]);
          return read();
        });
      }
      return read();
    }
    function walk(entry) {
      if (!entry) return Promise.resolve();
      if (entry.isFile) {
        return new Promise(function (resolve) {
          entry.file(function (file) { collected.push(file); resolve(); }, function () { resolve(); });
        });
      }
      if (entry.isDirectory && entry.createReader) {
        return readAll(entry.createReader()).then(function (entries) {
          return Promise.all(entries.map(walk));
        });
      }
      return Promise.resolve();
    }
    setStatus('Reading dropped files.');
    for (var i = 0; i < itemList.length; i++) {
      var entry = itemList[i].webkitGetAsEntry && itemList[i].webkitGetAsEntry();
      if (entry) tasks.push(walk(entry));
      else if (itemList[i].getAsFile) {
        var file = itemList[i].getAsFile();
        if (file) collected.push(file);
      }
    }
    Promise.all(tasks).then(function () {
      if (!collected.length) { setStatus('No files found.'); return; }
      takeFiles(collected);
    }, function () {
      setStatus('Could not read that folder.');
      if (collected.length) takeFiles(collected);
    });
  }

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

  /* What to show for a file whose scan threw. It is never an empty result:
     an empty result reads as "nothing found". */
  function scanFailure(err) {
    var reason = err && err.message ? err.message : String(err);
    return {
      detected: { format: 'unknown', label: 'Unreadable', support: 'unsupported', mime: '' },
      items: [{ tag: 'Scan failed', value: 'This file could not be scanned (' + reason + ').', group: 'Scan', source: 'scanner', sensitive: null, structural: false }],
      notes: ['Scan failed: ' + reason]
    };
  }

  var busy = false;

  async function scanNew() {
    /* Work from a snapshot. The list can change while a scan is awaited
       (another drop, or "Remove from list"), and indexing the live array
       then skips files or lands on an empty slot. */
    var batch = files.slice();
    for (var i = 0; i < batch.length; i++) {
      if (batch[i].before || batch[i].scanning) continue;
      batch[i].scanning = true;
      try {
        batch[i].before = await EE.scan(batch[i].bytes);
      } catch (err) {
        batch[i].before = scanFailure(err);
      }
      batch[i].scanning = false;
      batch[i].detected = batch[i].before.detected;
    }
    render();
    var gps = 0;
    var serial = 0;
    files.forEach(function (f) {
      if (!f.before) return;
      (f.before.items || []).forEach(function (it) {
        if (it.sensitive === 'gps') gps++;
        if (it.sensitive === 'serial') serial++;
      });
    });
    setStatus(files.length + ' file' + (files.length === 1 ? '' : 's') + ' scanned. ' + gps + ' GPS field' + (gps === 1 ? '' : 's') + ', ' + serial + ' serial field' + (serial === 1 ? '' : 's') + '.');
    refreshActions();
    if (!busy) stripBtn.focus();
  }

  function refreshActions() {
    stripBtn.disabled = busy || files.length === 0;
    zipBtn.disabled = busy || !files.some(function (f) { return f.result && f.result.bytes; });
    cleanPackBtn.disabled = busy || !files.some(function (f) { return f.result; });
  }

  stripBtn.addEventListener('click', async function () {
    if (busy) return;
    busy = true;
    refreshActions();
    var useCanvas = mode() === 'canvas';
    /* A snapshot again, and every exit re-enables the button. Before, a file
       dropped in mid-run had no result yet, the summary loop threw on it, and
       the Strip button stayed disabled until the page was reloaded. */
    var batch = files.filter(function (f) { return f.before; });
    try {
      for (var i = 0; i < batch.length; i++) {
        setStatus('Stripping ' + (i + 1) + ' of ' + batch.length + '.');
        try {
          batch[i].result = await exorcise(batch[i], useCanvas);
        } catch (err) {
          var reason = 'Stripping stopped with an error (' + (err && err.message ? err.message : String(err)) + '). The original file was not modified.';
          var failed = { ok: false, format: 'unknown', support: 'unsupported', bytes: null, notes: [], blocksClear: true, reason: reason };
          batch[i].result = { stripped: failed, after: batch[i].before, verdict: EE.judge(failed, batch[i].before), downloadName: null, bytes: null, method: useCanvas ? 'canvas' : 'lossless' };
        }
      }
      render();
      var counts = { clear: 0, residual: 0, unverified: 0, failed: 0 };
      files.forEach(function (f) {
        if (!f.result) return;
        counts[f.result.verdict.level] = (counts[f.result.verdict.level] || 0) + 1;
      });
      var line = 'Finished. ' +
        counts.clear + ' with no metadata detected, ' +
        counts.unverified + ' not certified, ' +
        counts.residual + ' still carrying metadata, ' +
        counts.failed + ' not modified.';
      setStatus(line);
      summary.textContent = line;
    } finally {
      busy = false;
      refreshActions();
    }
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
        return { stripped: stripped, after: after, verdict: EE.judge(stripped, after), downloadName: downloadName(file.name, 'png'), bytes: png, method: 'canvas' };
      } catch (err) {
        var failed = { ok: false, format: detected.format, support: detected.support, bytes: null, notes: [], blocksClear: true, reason: 'The browser could not decode this image for canvas re-encode (' + err.message + '). The original file was not modified.' };
        return { stripped: failed, after: file.before, verdict: EE.judge(failed, file.before), downloadName: null, bytes: null, method: 'canvas' };
      }
    }
    var strippedLossless = await EE.stripLossless(file.bytes);
    var afterScan = strippedLossless.ok ? await EE.scan(strippedLossless.bytes) : file.before;
    return {
      stripped: strippedLossless,
      after: afterScan,
      verdict: EE.judge(strippedLossless, afterScan),
      downloadName: strippedLossless.ok ? downloadName(file.name, strippedLossless.format) : null,
      bytes: strippedLossless.ok ? strippedLossless.bytes : null,
      method: 'lossless'
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
    /* Large files are still being written to disk after 1.5 seconds. Revoking
       the URL that early cancels the save in some browsers. */
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  cleanPackBtn.addEventListener('click', async function () {
    if (busy) return;
    var ready = files.filter(function (f) { return f.result; });
    if (!ready.length) return;
    busy = true;
    refreshActions();
    setStatus('Building the clean pack.');
    try {
      var includeHash = originalHashBox.checked;
      var records = ready.map(function (f) {
        var stripped = f.result.stripped || {};
        var ok = !!(f.result.bytes && stripped.ok);
        var detected = f.detected || {};
        return {
          originalName: f.name,
          originalBytes: includeHash ? f.bytes : null,
          outputBytes: ok ? f.result.bytes : null,
          format: ok ? stripped.format : detected.format,
          label: detected.label || '',
          support: ok ? stripped.support : detected.support,
          verdict: f.result.verdict,
          beforeItems: f.before && f.before.items ? f.before.items : [],
          afterItems: f.result.after && f.result.after.items ? f.result.after.items : [],
          ok: ok,
          method: f.result.method === 'canvas' ? 'canvas' : 'lossless'
        };
      });
      var pack = await EE.cleanPack(records, {
        neutralNames: neutralBox.checked,
        prefix: prefixInput.value,
        includeOriginalNames: namesBox.checked,
        includeOriginalHashes: includeHash
      });
      downloadBytes('exif-exorcist-clean-pack.zip', pack.zip, 'application/zip');
      var pending = files.length - ready.length;
      var line = 'Clean pack downloaded. ' + pack.files.length + ' output file' + (pack.files.length === 1 ? '' : 's') + ', with a JSON, CSV, and text manifest.';
      if (pending) line += ' ' + pending + ' file' + (pending === 1 ? ' has' : 's have') + ' not been stripped yet and ' + (pending === 1 ? 'was' : 'were') + ' left out.';
      setStatus(line);
    } catch (err) {
      setStatus('Could not build the clean pack (' + (err && err.message ? err.message : String(err)) + ').');
    } finally {
      busy = false;
      refreshActions();
    }
  });

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
    try {
      downloadBytes('exif-exorcist.zip', EE.writeZip(entries), 'application/zip');
    } catch (err) {
      setStatus('Could not build the zip (' + (err && err.message ? err.message : String(err)) + '). Download the files one at a time.');
    }
  });

  function render() {
    list.textContent = '';
    empty.hidden = files.length !== 0;
    files.forEach(function (file) { list.appendChild(card(file)); });
    refreshActions();
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
