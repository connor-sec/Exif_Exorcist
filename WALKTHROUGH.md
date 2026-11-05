# Exif Exorcist — Walkthrough

A step-by-step walkthrough of a common workflow in **[Exif Exorcist](https://github.com/connor-sec/Exif_Exorcist)**: drop a photo, read the GPS and serial-number rows, strip the metadata containers, read the re-scan, and download the result. A second pass shows the canvas re-encode and why a best-effort file is not certified.

Exif Exorcist is a single, offline HTML file — open `Exif-Exorcist-v1.0.html` in any modern browser. No install, no server, nothing leaves the page. Opening it from a `file://` URL is the normal way to use it.

> **⚠️ Authorized use only.** Use it on files you are allowed to modify. It does not upload them, and it does not redact what a person can see in the picture or on the page. “No metadata detected” means a second scan of a fully supported format found nothing. Check the file with another tool before you rely on it.

---

## Workflow at a Glance

1. Drop the files. The type is taken from the bytes, not the name.
2. Read the metadata table. GPS rows and serial-number rows are marked.
3. Strip in lossless mode and read the re-scan.
4. Download one file, or every stripped file as a zip.
5. If you choose canvas re-encode, read the quality warning first.
6. Treat a best-effort result as not certified.

---

## Step 1 — Drop the files

Open `Exif-Exorcist-v1.0.html`. The drop area is a button: click it, or press Enter or Space while it is focused, and choose files. You can also drag several files onto it.

A PNG named `photo.jpg` is still a PNG. The badge on the card is the type from the magic bytes.

The page scans immediately and does not modify the file yet.

## Step 2 — Read what it found

Each card lists the fields it could read: Make, Model, Artist, dates, comments, and the rest. Two kinds of rows are marked in the table, not by color alone:

* **GPS** — latitude, longitude, and other GPS tags, plus an ISO 6709 coordinate when one is sitting in a QuickTime atom.
* **Serial** — body, lens, and camera serial numbers, and tags whose names say serial.

That list is the “before” half of the report.

## Step 3 — Strip and read the re-scan

Leave **Lossless** selected. That mode removes the container that holds the metadata: a JPEG APP segment, a PNG chunk, a TIFF tag, a PDF Info dictionary, an Office `docProps` part, an ID3 tag, a QuickTime `udta` box. The compressed image or audio stays encoded as it was.

Click **Strip and re-scan**. Each card then shows:

* **No metadata detected** — the new scan found nothing, and the format is fully supported.
* **Metadata remains** — the new scan still found fields. The file is not clean. Do not download it and treat it as stripped.
* **Not certified** — the new scan found nothing this tool knows how to name, and the format is best effort (HEIC, MP4, MOV, M4A).
* **Not stripped** — the file was not modified. BigTIFF, encrypted PDF, and a canvas decode the browser cannot do all end here.

The notes under the banner say what was removed. ICC profiles are removed on purpose, so colors may shift. The Adobe JPEG color marker is kept.

## Step 4 — Download

**Download** on a card saves that one output. The name is the original stem plus `-stripped` and an extension for the type that was actually written.

**Download zip** packs every output the page is willing to hand you. The zip is written in the page. Files that were not stripped are left out of the archive.

## Step 5 — Canvas re-encode, if you mean it

The canvas option is a different operation. The warning next to the control is there before you select it: the browser decodes the image and writes a new PNG. Metadata does not come along, because the file is new. Quality can drop, color can shift, bit depth is flattened, and an animation keeps only the first frame.

Select it only when that trade is acceptable. Images that the browser cannot decode stay unmodified and are marked **Not stripped**. Documents and audio keep using the lossless path.

## Step 6 — A best-effort file

A HEIC, MP4, MOV, or M4A card can come back with an empty re-scan and still say **Not certified**. The page will not upgrade that to “no metadata detected.” Timed metadata stored as media samples, and HEIF item layouts this version does not parse, can still be in the file. Open it in ExifTool before you decide it is done.

---

## Quick Reference

| Goal | Control | What you should see |
| --- | --- | --- |
| See GPS and serials | Drop the file | Marked rows, file not yet changed |
| Keep the original encoding | Lossless, then Strip and re-scan | A verdict from the second scan |
| Rebuild an image from pixels | Canvas re-encode | The quality warning, then a PNG |
| Take the files with you | Download, or Download zip | Only outputs the page actually produced |

---

*Exif Exorcist is released under the GNU Affero General Public License v3.0 (AGPL-3.0). Not affiliated with or endorsed by Phil Harvey, Adobe, Apple, Google, or Microsoft.*
