# Document Forensics

## PDF
```bash
pdftotext <pdf>                        # extract all text
pdfimages <pdf> prefix                 # extract images
pdfdetach -list <pdf>                  # list attachments
pdfdetach -saveall <pdf>               # extract attachments
pdfinfo <pdf>                          # metadata
strings <pdf> | grep -i flag           # quick search
mutool clean -d <pdf> decompressed.pdf # decompress streams → searchable
```
**Hidden content**: invisible text (select all → paste), hidden layers (toggle in viewer), JavaScript, URI annotations, embedded files, incremental updates (old revisions), form fields.

## Office (OOXML: .docx/.xlsx/.pptx)
```bash
unzip document.docx -d extracted/       # they're ZIP archives
cat extracted/word/document.xml         # main content
cat extracted/docProps/core.xml         # metadata
# Check: track changes, hidden slides/sheets, VBA macros, embedded OLE objects
```

## Office (OLE: .doc/.xls/.ppt)
```bash
olevba document.doc                     # extract VBA macros
oledump.py document.doc                 # list streams
```

## Image Metadata
```bash
exiftool <image>                        # all metadata (EXIF, GPS, comments)
exiftool -b -ThumbnailImage <img> > thumb.jpg  # thumbnail may show uncropped original
# GPS: exiftool -GPSLatitude -GPSLongitude <image>
```

## Email
```bash
# Key headers: From, To, Date, Received (bottom=origin), X-Mailer, DKIM-Signature
munpack email.eml                       # extract MIME parts
ripmime -i email.eml -d output/         # extract attachments
```

## Archives
```bash
7z l archive.7z                         # list contents
# Crack password:
zip2john archive.zip > hash.txt && john hash.txt --wordlist=wordlist.txt
fcrackzip -v -D -p wordlist.txt archive.zip
```
