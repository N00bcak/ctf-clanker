---
name: forensics-ctf
description: Recover evidence or hidden data from CTF network, disk, memory, steganographic, or log artifacts.
---

# Forensics CTF

## Purpose

Analyze digital forensic artifacts to recover hidden data, reconstruct
events, or extract flags. Covers network forensics, disk and memory
analysis, steganography, and log correlation.

## Use When

- The challenge provides PCAP files, network captures, or traffic logs.
- Disk images, filesystem dumps, or partition data are the primary artifact.
- Memory dumps require analysis (process listing, credential extraction).
- Images, audio, or documents contain steganographic data.
- Log files or system artifacts need correlation or timeline reconstruction.

## Do Not Use

- The primary artifact is a binary to reverse — use `reverse-ctf`.
- The challenge is a live web application — use `web-ctf`.
- The challenge is a cryptosystem with parameters — use `crypto-ctf`.
- The category is unknown — use `ctf-triage` first.
- Do not spawn, request, or rely on subagents.

## Needs

- Forensic artifact: PCAP, disk image, memory dump, image, audio, log file.
- Challenge context: what event or data to recover.
- Flag format or success condition.
- Any provided keys, passwords, or supplementary files.

## Returns

- Artifact analysis with identified evidence.
- Recovered data, files, credentials, or hidden content.
- Flag or explicit blocker with documented investigation path.
- Timeline or event reconstruction when applicable.

## Done Conditions

- Hidden data or flag is recovered from the artifact.
- If blocked, the investigation path is fully documented: tools used,
  layers examined, what was and was not found.
- All artifact layers have been checked (no unchecked obvious analysis).

## Persistence And Yield

Useful progress means new data recovered, artifact layer decoded, hidden
channel identified, timeline event correlated, or steganographic method
determined.

Before yielding:

- Complete initial artifact identification and format analysis.
- Try the primary analysis path for the identified artifact type.
- Try one distinct bounded alternative (different tool, different layer,
  different extraction method).
- Check whether missing information is discoverable (embedded files,
  metadata, alternate data channels).
- Confirm the next action would repeat prior work, require unsafe guessing,
  or leave this skill's boundary.

Do not yield merely because the first steganography tool found nothing.
Systematically check all plausible hiding methods.

When yielding, return the investigation performed, data recovered so far,
specific blocker, why more work would repeat, and the next recovery step.

## Methodology

### Evidence-First Workflow

Start from the real artifact. Identify what you have before choosing
analysis tools.

```
file <artifact>                         # type identification
xxd <artifact> | head -30               # header inspection
binwalk <artifact>                      # embedded files
exiftool <artifact>                     # metadata extraction
ls -la <artifact>                       # file size (compare to expected)
```

### Step 1: Identify Artifact Type and Analysis Path

| Artifact Type | Primary Analysis Path |
|---------------|----------------------|
| PCAP / network capture | Protocol analysis, stream extraction |
| Disk image (.img, .E01, .dd) | Filesystem analysis, file carving |
| Memory dump (.vmem, .raw, .dmp) | Volatility process/file extraction |
| Image (PNG, JPEG, BMP, GIF) | Steganography analysis |
| Audio (WAV, MP3, FLAC) | Spectrogram, LSB, DTMF, SSTV |
| PDF | Hidden layers, JavaScript, metadata |
| Log files | Pattern analysis, timeline correlation |
| Archive with extra data | Binwalk, appended data check |

### Step 2: Network Forensics

```
tshark -r <pcap> -q -z conv,tcp        # TCP conversation summary
tshark -r <pcap> -q -z io,phs          # protocol hierarchy
tshark -r <pcap> -Y "http" -T fields -e http.request.uri -e http.file_data
tshark -r <pcap> -Y "dns" -T fields -e dns.qry.name -e dns.a
```

Check for:
- HTTP requests and responses: file transfers, form submissions, API calls.
- DNS: exfiltration via subdomain encoding or TXT records.
- TLS: look for SSLKEYLOGFILE or key material in challenge files.
- FTP/SMB: plaintext credentials, transferred files.
- USB HID: keyboard input reconstruction from interrupt transfers.
- ICMP: data hidden in payload bytes.
- Unusual protocols or custom TCP/UDP streams.

### Step 3: Disk and Memory Forensics

**Disk images:**
```
fdisk -l <image>                        # partition table
mmls <image>                            # partition layout (Sleuth Kit)
fls -r <image>                          # file listing with deleted files
fls -rd <image>                         # deleted files only
icat <image> <inode>                    # recover file by inode
```

**Memory dumps:**
```
vol.py -f <dump> imageinfo              # identify OS profile (vol2)
vol.py -f <dump> --profile=<P> pslist   # running processes
vol.py -f <dump> --profile=<P> filescan # open file handles
vol.py -f <dump> --profile=<P> dumpfiles -Q <offset> -D out/
vol.py -f <dump> --profile=<P> hashdump # password hashes
vol.py -f <dump> --profile=<P> cmdscan  # command history
```

Key targets: deleted files, browser history (SQLite), registry hives,
`.git/` objects, cached credentials, environment variables.

### Step 4: Steganography

Systematic check order — do not skip steps:

1. **Metadata**: `exiftool`, EXIF comments, PNG text chunks, JPEG comments.
2. **Appended data**: `binwalk`, compare file size to expected format size.
3. **LSB encoding**: `zsteg` (PNG), `stegsolve` (visual bit planes).
4. **Tool-specific stego**: `steghide extract -sf <jpg>` (try empty password
   first, then common passwords, then passwords from other challenge data).
5. **Color/palette manipulation**: unusual palette entries, specific channel data.
6. **File format anomalies**: extra chunks, corrupted headers (repair and check).

**Audio steganography:**
1. **Spectrogram**: `sox <audio> -n spectrogram` or Audacity — visual message.
2. **DTMF tones**: `multimon-ng -t wav -a DTMF <audio>`.
3. **SSTV**: slow-scan TV signal, decode with `qsstv`.
4. **LSB in samples**: extract least significant bits from audio samples.

### Step 5: Log and Timeline Analysis

- Identify log format and time zone.
- Search for: failed logins, unusual user agents, IP anomalies, timing gaps.
- Correlate events across multiple log sources.
- Check for log tampering: gaps in sequence numbers, missing time ranges.
- Decode URL-encoded or base64-encoded parameters in web logs.

## Pivot Rules

- If the recovered artifact is a binary that needs reversing, hand off
  to `reverse-ctf`.
- If the recovered data is ciphertext with crypto parameters, hand off
  to `crypto-ctf`.
- If the forensic artifact contains a web application to exploit, hand
  off to `web-ctf`.
- If the investigation reveals an encoding puzzle or jail escape, hand
  off to `misc-ctf`.

## Reference

- `references/pcap-analysis.md` — tshark, protocol filtering, stream extraction
- `references/network-steganography.md` — DNS exfil, ICMP tunnel, timing channels
- `references/disk-forensics.md` — Sleuth Kit, mounting, file carving, timeline
- `references/memory-forensics.md` — Volatility 2/3, process analysis, credentials
- `references/image-steganography.md` — LSB, zsteg, steghide, palette, channels
- `references/audio-steganography.md` — spectrogram, DTMF, SSTV, Morse
- `references/document-forensics.md` — PDF, Office, email, metadata
- `references/windows-artifacts.md` — Event Logs, registry, SAM, NTFS MFT
- `references/linux-artifacts.md` — logs, Docker, browser, Git, persistence
- `references/signals-hardware.md` — VGA, HDMI, DisplayPort, SDR, power analysis
