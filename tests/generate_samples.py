#!/usr/bin/env python3
"""Build metadata-bearing sample files for the Exif Exorcist tests."""
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

from PIL import Image
import piexif


def exiftool(path, *args):
    subprocess.check_call(['exiftool', '-overwrite_original', *args, str(path)], stdout=subprocess.DEVNULL)


def base_image(path, kind):
    im = Image.new('RGB', (32, 24), (18, 64, 96))
    im.save(path, kind)


def tag_image(path):
    exiftool(
        path,
        '-Make=Acme',
        '-Model=SecretCam',
        '-Artist=Jane Doe',
        '-ImageDescription=hidden desc',
        '-UserComment=secret comment',
        '-BodySerialNumber=SN-BODY-123456',
        '-LensSerialNumber=SN-LENS-654321',
        '-GPSLatitude=37.7749',
        '-GPSLatitudeRef=N',
        '-GPSLongitude=122.4194',
        '-GPSLongitudeRef=W',
        '-Copyright=Jane Doe',
    )


def build_heic(path, exif_blob):
    tiff = exif_blob[6:]
    payload = b'\x00\x00\x00\x00' + tiff
    image = b'\x00' * 32

    def box(typ, data):
        return struct.pack('>I', 8 + len(data)) + typ + data

    def fullbox(typ, ver, flags, data):
        return box(typ, bytes([ver]) + flags.to_bytes(3, 'big') + data)

    ftyp = box(b'ftyp', b'heic' + b'\x00\x00\x00\x00' + b'mif1' + b'heic')
    hdlr = box(b'hdlr', b'\x00\x00\x00\x00' + b'\x00\x00\x00\x00' + b'pict' + b'\x00' * 12 + b'\x00')
    pitm = fullbox(b'pitm', 0, 0, struct.pack('>H', 1))

    def infe(item_id, item_type, name):
        body = struct.pack('>HH', item_id, 0) + item_type + name + b'\x00'
        return fullbox(b'infe', 2, 0, body)

    iinf = fullbox(b'iinf', 0, 0, struct.pack('>H', 2) + infe(1, b'hvc1', b'Image') + infe(2, b'Exif', b'Exif'))
    iloc_head = bytes([1, 0, 0, 0, 0x44, 0x00, 0x00, 0x02])
    iloc = box(b'iloc', iloc_head + b'\x00' * 32)
    meta = box(b'meta', bytes(4) + hdlr + pitm + iloc + iinf)
    mdat = box(b'mdat', image + payload)
    file = bytearray(ftyp + meta + mdat)
    data_off = len(ftyp) + len(meta) + 8
    idx = file.find(b'iloc')
    base = idx + 4 + 8

    def put(n, item_id, offset, length):
        p = base + n * 16
        struct.pack_into('>HHHHI', file, p, item_id, 0, 0, 1, offset)
        struct.pack_into('>I', file, p + 12, length)

    put(0, 1, data_off, len(image))
    put(1, 2, data_off + len(image), len(payload))
    path.write_bytes(file)


def build_pdf(path, jpeg):
    xmp = b'''<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Jane Doe</dc:creator></rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'''
    contents = b'BT /F1 12 Tf 40 100 Td (Hello) Tj ET\n'
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>',
        b'<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im1 7 0 R >> >> >>',
        b'<< /Length %d >>\nstream\n' % len(contents) + contents + b'endstream',
        b'<< /Author (Jane Doe) /Title (Secret Title) /Creator (SecretApp) /Producer (SecretProd) /Keywords (hidden) >>',
        b'<< /Type /Metadata /Subtype /XML /Length %d >>\nstream\n' % len(xmp) + xmp + b'\nendstream',
        b'<< /Type /XObject /Subtype /Image /Width 32 /Height 24 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n' % len(jpeg) + jpeg + b'\nendstream',
    ]
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f'{i} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(objects)+1}\n'.encode()
    out += b'0000000000 65535 f \n'
    for i in range(1, len(objects) + 1):
        out += f'{offsets[i]:010d} 00000 n \n'.encode()
    out += f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    path.write_bytes(out)


def build_office(out, jpeg):
    core = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Secret Title</dc:title><dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy></cp:coreProperties>'''
    app = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SecretApp</Application><Company>Acme</Company></Properties>'''
    ct = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'''
    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'''
    doc = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p w:author="Jane Doe"><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'''
    drels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.jpg"/></Relationships>'''
    with zipfile.ZipFile(out / 'sample.docx', 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in {
            '[Content_Types].xml': ct,
            '_rels/.rels': rels,
            'word/document.xml': doc,
            'word/_rels/document.xml.rels': drels,
            'docProps/core.xml': core,
            'docProps/app.xml': app,
            'word/media/image1.jpg': jpeg,
        }.items():
            z.writestr(name, data)
    leak = doc.replace('Hello', 'GPSLatitude 37.7749 N is written in the paragraph itself')
    with zipfile.ZipFile(out / 'residual.docx', 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', leak)
        z.writestr('docProps/core.xml', core)
    ct_x = ct.replace('wordprocessingml.document.main+xml', 'spreadsheetml.sheet.main+xml').replace('/word/document.xml', '/xl/workbook.xml')
    with zipfile.ZipFile(out / 'sample.xlsx', 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct_x)
        z.writestr('_rels/.rels', rels.replace('word/document.xml', 'xl/workbook.xml'))
        z.writestr('docProps/core.xml', core)
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    ct_p = ct.replace('wordprocessingml.document.main+xml', 'presentationml.presentation.main+xml').replace('/word/document.xml', '/ppt/presentation.xml')
    with zipfile.ZipFile(out / 'sample.pptx', 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct_p)
        z.writestr('_rels/.rels', rels.replace('word/document.xml', 'ppt/presentation.xml'))
        z.writestr('docProps/core.xml', core)
        z.writestr('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')


def build_odf(out, kind, mime):
    meta = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
<office:meta><dc:creator>Jane Doe</dc:creator><dc:title>Secret Title</dc:title><meta:creation-date>2020-01-02T03:04:05</meta:creation-date></office:meta>
</office:document-meta>'''
    content = '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text/></office:body></office:document-content>'
    manifest = f'<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/></manifest:manifest>'
    with zipfile.ZipFile(out / f'sample.{kind}', 'w') as z:
        z.writestr('mimetype', mime, compress_type=zipfile.ZIP_STORED)
        z.writestr('meta.xml', meta)
        z.writestr('content.xml', content)
        z.writestr('META-INF/manifest.xml', manifest)


def build_mp3(out):
    subprocess.check_call([
        'ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.25',
        '-c:a', 'libmp3lame', str(out / 'base.mp3')
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    audio = (out / 'base.mp3').read_bytes()
    if audio.startswith(b'ID3'):
        size = ((audio[6] & 127) << 21) | ((audio[7] & 127) << 14) | ((audio[8] & 127) << 7) | (audio[9] & 127)
        audio = audio[10 + size:]

    def frame(fid, body):
        return fid + struct.pack('>I', len(body)) + b'\x00\x00' + body

    frames = b''.join([
        frame(b'TIT2', b'\x00Secret Song'),
        frame(b'TPE1', b'\x00Jane Doe'),
        frame(b'TALB', b'\x00Secret Album'),
        frame(b'TXXX', b'\x00Serial\x00SN-BODY-123456'),
        frame(b'COMM', b'\x00eng\x00secret comment'),
    ])
    size = len(frames)
    tag = b'ID3\x03\x00\x00' + bytes([(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]) + frames
    v1 = b'TAG' + b'Secret Song'.ljust(30) + b'Jane Doe'.ljust(30) + b'Secret Album'.ljust(30) + b'2020' + b'secret comment'.ljust(28) + b'\x00\x00' + bytes([1])
    (out / 'sample.mp3').write_bytes(tag + audio + v1)
    (out / 'base.mp3').unlink()


def build_media(out):
    subprocess.check_call(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(out / 'sample.mp4')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.check_call(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.3', '-c:a', 'aac', str(out / 'sample.m4a')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.check_call(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mov', str(out / 'sample.mov')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for name in ('sample.mp4', 'sample.m4a', 'sample.mov'):
        exiftool(
            out / name,
            '-Title=Secret Title',
            '-Artist=Jane Doe',
            '-Comment=secret comment',
            '-GPSCoordinates=37.7749, -122.4194',
            '-Make=Acme',
            '-Model=SecretCam',
            '-SerialNumber=SN-CAM-999',
        )


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    base_image(out / 'sample.jpg', 'JPEG')
    base_image(out / 'sample.png', 'PNG')
    base_image(out / 'sample.webp', 'WEBP')
    base_image(out / 'sample.gif', 'GIF')
    base_image(out / 'sample.tif', 'TIFF')
    for name in ('sample.jpg', 'sample.png', 'sample.webp', 'sample.gif', 'sample.tif'):
        tag_image(out / name)
    (out / 'photo.jpg').write_bytes((out / 'sample.png').read_bytes())
    zeroth = {piexif.ImageIFD.Make: b'Acme', piexif.ImageIFD.Artist: b'Jane Doe', piexif.ImageIFD.Model: b'SecretCam'}
    exif_ifd = {piexif.ExifIFD.BodySerialNumber: b'SN-BODY-123456'}
    gps = {
        piexif.GPSIFD.GPSVersionID: (2, 3, 0, 0),
        piexif.GPSIFD.GPSLatitudeRef: b'N',
        piexif.GPSIFD.GPSLatitude: ((37, 1), (46, 1), (2964, 100)),
        piexif.GPSIFD.GPSLongitudeRef: b'W',
        piexif.GPSIFD.GPSLongitude: ((122, 1), (25, 1), (984, 100)),
    }
    build_heic(out / 'sample.heic', piexif.dump({'0th': zeroth, 'Exif': exif_ifd, 'GPS': gps}))
    build_pdf(out / 'sample.pdf', (out / 'sample.jpg').read_bytes())
    subprocess.check_call(['qpdf', '--object-streams=generate', '--stream-data=compress', str(out / 'sample.pdf'), str(out / 'objectstreams.pdf')])
    (out / 'incremental.pdf').write_bytes((out / 'sample.pdf').read_bytes())
    exiftool(out / 'incremental.pdf', '-Author=Incr Author', '-Title=Incr Title', '-Creator=IncrApp')
    build_office(out, (out / 'sample.jpg').read_bytes())
    build_odf(out, 'odt', 'application/vnd.oasis.opendocument.text')
    build_odf(out, 'ods', 'application/vnd.oasis.opendocument.spreadsheet')
    build_odf(out, 'odp', 'application/vnd.oasis.opendocument.presentation')
    build_mp3(out)
    build_media(out)
    (out / 'sample.bigtiff').write_bytes(b'II' + struct.pack('<H', 43) + struct.pack('<HH', 8, 0) + b'\x00' * 8 + b'GPSLatitude')
    print('samples in', out)


if __name__ == '__main__':
    main()
