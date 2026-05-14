# OSINT

## Username Search
```bash
sherlock <username>      # check across platforms
```
**Manual**: Twitter/X, Instagram, Reddit, GitHub, LinkedIn, Discord, Steam, Keybase.
**Tools**: `sherlock`, `namechk.com`, `whatsmyname.app`.

## Email
Hunter.io (find by domain), Have I Been Pwned (breach lookup), GitHub commit search by email.

## Image Geolocation
1. `exiftool -GPSLatitude -GPSLongitude <image>` — EXIF GPS.
2. Landmarks, signage, language/script on signs.
3. License plates (format identifies country/state).
4. Road markings (yellow center = Americas), vegetation, architecture.
5. Sun position → latitude estimate (with time).
6. Google Street View comparison for candidate locations.

## Reverse Image Search
Google Images, TinEye, Yandex Images (strongest for faces/locations).

## Web / DNS
```bash
dig any <domain>                       # all DNS records
dig txt <domain>                       # TXT (often has clues)
dig axfr <domain> @<ns>                # zone transfer
whois <domain>                         # registration info
```

## Historical Data
Wayback Machine: `web.archive.org/web/*/<url>`. SecurityTrails (DNS history). `crt.sh` (certificate transparency → subdomains).

## Google Dorking
```
site:example.com    filetype:pdf    intitle:"index of"    inurl:admin
"password" filetype:env    site:github.com "API_KEY"    site:pastebin.com "target"
```

## GitHub / GitLab
Search: code, commits, issues, gists for API keys, passwords, internal URLs.
```bash
trufflehog git https://github.com/org/repo    # find secrets in history
```

## Social Media
Twitter advanced search: `from:user since:2025-01-01 until:2025-12-31`.
Check: media tab (images may have EXIF), cached/archived for deleted content.

## Tools
`sherlock`, `theHarvester`, `recon-ng`, `spiderfoot`, `Maltego`, `ExifTool`, Google Earth.
