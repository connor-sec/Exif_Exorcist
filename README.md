<p align="center"><img src="assets/logo.png" alt="Exif Exorcist logo" width="300"></p>

# Exif Exorcist

An offline, single-file HTML tool that strips metadata from files in your browser. Drag files in, read what it found, strip the containers that hold it, and re-scan before you download. No network, no install, nothing leaves the page.

Maintained by [@connor-sec](https://github.com/connor-sec).

> **Download:** the single-file build is [Exif-Exorcist-v1.0.html](Exif-Exorcist-v1.0.html) in this repository, and the same file is attached to [Releases](https://github.com/connor-sec/Exif_Exorcist/releases) when a version tag is pushed.

## Usage

Open `Exif-Exorcist-v1.0.html` in any modern browser. That's it — no install, no server. It also works from a `file://` URL.

To prepare a folder of photos for a report, choose the folder, strip, then download a clean pack. The pack is a zip of the stripped files and a manifest. [Clean pack](#clean-pack) describes what that zip contains and what it leaves out.

## ⚠️ Authorized use only — and what this tool will not promise

**Authorized use.** Exif Exorcist rewrites files you choose and keeps the work in your browser. It does not upload them. Use it only on files you are allowed to modify. Stripping metadata from a file you do not have rights to, or removing metadata you are required to keep, may violate law, contract, or policy.

**What a result means.** Lossless mode deletes metadata containers (segments, chunks, atoms, tags, document properties) and then reads the file again. “No metadata detected” is that second read, and only for a format the lossless stripper covers fully. Best-effort formats are never given that result, even when the re-scan is empty. If the re-scan still finds metadata, the file is reported as still carrying it. Do not treat an output as clean until you have checked it with an independent tool such as [ExifTool](https://exiftool.org/).

**Not a visual redaction tool.** Pixels, page text, and filenames stay. A photo with the GPS tags removed can still show a street sign, a face, or a screen.

**Warranty and trademarks.** Provided "as is", without warranty of any kind. This is not legal advice. Not affiliated with or endorsed by Phil Harvey, Adobe, Apple, Google, Microsoft, or any other vendor. Product names belong to their owners.

## Why this exists

*This section is intentionally left for the maintainer to write.*

## Features

* **Drag and drop, several files at once.** The type is detected from magic bytes, not the filename.
* **A metadata report before anything is changed.** GPS fields and serial numbers are marked in the table.
* **Lossless stripping by removing the container,** not by re-encoding the picture. JPEG segments, PNG chunks, WebP chunks, GIF extensions, TIFF tags, PDF Info/XMP, Office properties, ODF `meta.xml`, ID3/APE, and QuickTime user-data atoms.
* **An optional canvas re-encode for images,** with the quality loss stated next to the control: a new PNG, first frame only, color and bit depth can change.
* **A before/after report from a fresh scan of the output.** The page does not call a file clean when that scan still finds metadata.
* **Download one file, or all of them as a zip.** The zip writer is in the page. Nothing is fetched to build it. Those names keep the original file name plus `-stripped`.
* **Choose a folder.** The file list already takes several files at once. **Choose a folder** adds every file the browser lists, including files in subfolders.
* **Clean pack.** After a strip, download a zip of the outputs plus a JSON, CSV, and plain-text manifest. Output names can be a prefix and a sequence number. The manifest records field names that were removed, not the values.

## Clean pack

A clean pack is the zip you attach to a report: the stripped files, plus a manifest of what was removed.

1. Drop the files, or use **Choose a folder**. The page reads them locally. A dropped folder is read in the browser, including subfolders when the browser allows it.
2. Strip and re-scan. The pack is built from that result. Files you add after the strip are left out until you strip again.
3. Leave **Neutral filenames** on unless the zip should keep the original file names. Outputs are then `photo-001.jpg`, `photo-002.jpg`, and so on. The prefix is whatever you type, reduced to letters, digits, hyphens, and underscores, up to 40 characters. An empty prefix becomes `photo`. The sequence counts outputs, so a file that could not be stripped does not take a number.
4. **Download clean pack.** The zip contains the outputs and three copies of the same manifest: `manifest.json`, `manifest.csv`, and `manifest.txt`. The text file is written so it can sit in an appendix. The CSV is UTF-8 with a byte-order mark so a spreadsheet reads the field names as Unicode.

For each file the manifest lists the output filename, the SHA-256 of the cleaned bytes, the format, the re-scan result, and the metadata categories and field names that were removed or are still present. A removed GPS field is recorded as `GPSLatitude removed`, not as the coordinate that was stored there. Values are not written into the manifest.

Two boxes are off unless you turn them on:

* **Original filenames.** Adds the file's own name. The folder it came from is not included, and it is not included unless this box is on.
* **SHA-256 of the original file.** Adds a hash of the bytes you dropped. The original bytes are not put in the zip.

If neutral filenames are off, the output filename itself still carries the original name. The checkbox only controls the extra manifest column.

The hash is SHA-256. The page uses Web Crypto (`crypto.subtle`) when the browser provides it. Opening the file from a `file://` URL is not a secure context in every browser, and those browsers hide Web Crypto; the page then uses a SHA-256 implementation that ships in the file. Both are checked against the same test vectors. Nothing is fetched to compute a hash.

Files that could not be stripped are listed in the manifest and left out of the outputs. Best-effort formats are still not certified. **Download** and **Download zip** are unchanged: those names still use the original file name plus `-stripped`.

The page still shows metadata values on screen while you review a file. That list stays in the browser. It is not copied into the pack.

## Supported formats

| Format | How it is recognized | What lossless mode does | Level |
| --- | --- | --- | --- |
| JPEG | `FF D8 FF` | Removes APP segments (keeps the Adobe APP14 color marker) and COM comments. Embedded EXIF, XMP, IPTC, ICC, and MPF go with the segment. | Full |
| PNG | PNG signature | Removes text, time, EXIF, ICC, and other chunks that are not needed to draw the image. `tRNS` and the color-rendering chunks that are not profiles stay. | Full |
| WebP | `RIFF` / `WEBP` | Removes EXIF, XMP, and ICCP chunks and clears those flags in `VP8X`. | Full |
| GIF | `GIF87a` / `GIF89a` | Removes comment and application extensions. Netscape and animation extensions stay, so a multi-frame GIF still animates. | Full |
| TIFF | `II*` or `MM*` | Rebuilds a baseline TIFF with image tags only (strips or tiles, photometric interpretation, orientation, resolution). EXIF, GPS, XMP, IPTC, and ICC are not copied. BigTIFF is refused and left untouched. | Full for baseline TIFF |
| HEIC / HEIF | `ftyp` brand `heic`, `heix`, `hevc`, `hevx`, `mif1`, `msf1`, and the related HEIF brands | Zeros known Exif and XMP item extents in place so `iloc` offsets do not move. | Best effort |
| PDF | `%PDF` | Rewrites unencrypted files it can parse, including cross-reference streams and object streams. Clears the Info dictionary, drops XMP metadata streams, and strips EXIF from embedded JPEG images. Encrypted PDFs are refused. | Full when the parser accepts the file |
| DOCX, XLSX, PPTX | ZIP package plus `[Content_Types].xml` | Removes `docProps`, clears `author` attributes, and runs the image stripper on embedded media. | Full |
| ODT, ODS, ODP | ZIP package plus the ODF `mimetype` entry | Replaces `meta.xml` with an empty `office:meta`. The mimetype entry stays first and uncompressed. | Full |
| MP3 | `ID3` or a valid MPEG frame sync | Removes ID3v2, ID3v1, and an APEv2 tag at the end. | Full |
| MP4, MOV, M4A | `ftyp`, or a QuickTime `moov` / `mdat` / `wide` atom | Removes `udta`, iTunes `meta`, and XMP (`uuid` and `XMP_`). Zeros creation and modification times in `mvhd`, `tkhd`, and `mdhd`. Rewrites `stco` / `co64` after the file shrinks. | Best effort |

AVIF, BigTIFF, encrypted PDF, ZIP64, and ZIP files that are not Office or ODF packages are recognized only so they can be refused. They are not modified, and they are not reported as clear.

## Limitations

* Best-effort output is not a certification. Timed GPS and other sample data inside an MP4 or MOV can remain even after user-data atoms are gone. HEIC extents this tool does not understand are left in place.
* Codec and handler strings inside an MP4 sample description are part of the media structure and are not scrubbed.
* ICC profiles are removed. Colors can shift. The Adobe JPEG APP14 marker is kept so CMYK files still decode.
* A Word document that talks about GPS in its own paragraph still contains that sentence. If the text contains a marker such as `GPSLatitude`, the re-scan says metadata remains.
* Canvas re-encode is a different file. It is the right tool when you accept quality loss. It is the wrong tool when you need the original encoding.
* This page does not remove faces, plates, or screens. The files on disk keep their names. A clean pack can give the downloaded copies neutral filenames. Text that is visible in the picture stays.
* The manifest is not a certification. It records the field names this tool's scan could read. Check the outputs with ExifTool before you rely on them.
* Verify with ExifTool before you rely on a result.

## Development

The page is one file. `src/engine.js` and `src/engine2.js` are the same script, split so the tests can read it. `node tests/build_html.mjs` writes `Exif-Exorcist-v1.0.html`. The test fails if the HTML and `src/` drift.

```
node tests/build_html.mjs
node tests/run_tests.mjs
```

The tests generate sample files, strip them with the script inside the HTML file, and check the outputs with ExifTool. They expect `exiftool`, `ffmpeg`, `qpdf`, Python 3, Pillow, and piexif on the machine running them.

## Acknowledgments & Credits

This project stands on work other people published.

### Phil Harvey

ExifTool is the tool the test suite checks against, and it is still the reference for where metadata actually lives in these formats. Thank you, Phil Harvey, for making that knowledge usable.

### The format authors

JPEG, PNG, TIFF, GIF, WebP, ISO BMFF, PDF, ID3, ECMA-376, and ODF are documented well enough that a browser can remove the containers without a server. The stripper follows those public layouts.

### mat2

The [mat2](https://0xacab.org/jvoisin/mat2) project wrote down, in public, which chunks and atoms carry metadata and which ones have to stay if the file is still supposed to open. That writeup was a useful map.

## License

Released under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

This is a strong copyleft license: anyone who distributes this code or runs a modified version as a network/hosted service must make their complete source available under the same AGPL-3.0 terms. Copyright and license notices must be preserved.
