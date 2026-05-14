# Disk Forensics

## Partition Analysis

```bash
fdisk -l <image>                        # partition table (MBR/GPT)
mmls <image>                            # Sleuth Kit partition layout
gdisk -l <image>                        # GPT partition table
parted <image> print                    # GNU Parted

# Note the offset (start sector × sector size) for mounting
# Sector size is usually 512 bytes
```

## Filesystem Analysis (Sleuth Kit)

```bash
fsstat -o <offset> <image>              # filesystem details (type, size, dates)
fls -r -o <offset> <image>             # recursive file listing
fls -rd -o <offset> <image>            # deleted files only
fls -m "/" -r -o <offset> <image>      # mactime bodyfile format
icat -o <offset> <image> <inode>       # extract file by inode number
blkls -o <offset> <image>              # unallocated space (slack + unalloc)
```

## Mounting

```bash
# Mount read-only (always use -o ro for forensics)
mount -o loop,ro,offset=$((START_SECTOR * 512)) <image> /mnt/evidence

# For NTFS
mount -o loop,ro,offset=$((START * 512)),show_sys_files <image> /mnt

# For encrypted LUKS
cryptsetup luksOpen <image> evidence    # requires passphrase
mount /dev/mapper/evidence /mnt

# VMDK (convert first)
qemu-img convert -O raw disk.vmdk disk.raw
```

## File Carving

```bash
foremost -i <image> -o output/          # carve by file headers
scalpel -c scalpel.conf <image>         # configurable carving
binwalk -e <image>                      # extract embedded files
photorec <image>                        # interactive file recovery
bulk_extractor <image> -o output/       # extract artifacts (emails, URLs, etc.)
```

## Key Targets

| Artifact | Location | Tool |
|---|---|---|
| Deleted files | `fls -d`, then `icat` | Sleuth Kit |
| File slack | Between EOF and cluster boundary | `blkls` or custom script |
| Hidden partitions | Gaps in partition table | `mmls`, check for unaccounted sectors |
| Alternate data streams (NTFS) | `fls` shows `:stream_name` | `icat image inode:stream` |
| MFT entries (NTFS) | `$MFT` file | `analyzeMFT.py`, `icat` inode 0 |
| Journal (ext4) | `.journal` inode 8 | `icat image 8`, `jls` |
| Browser history | SQLite files in profiles | `sqlite3`, see `linux-artifacts.md` |
| Git repos | `.git/` directories | `git log --all`, `git reflog` |
| Recently accessed | `.bash_history`, LNK files | Direct extraction |
| Encrypted volumes | LUKS/BitLocker/VeraCrypt headers | `cryptsetup`, known passwords |

## Filesystem-Specific

### ext4

```bash
debugfs <image>                         # interactive ext2/3/4 explorer
debugfs -R "ls -l /" <image>
debugfs -R "stat <inode>" <image>       # inode details
debugfs -R "cat <path>" <image>         # read file
```

### NTFS

```bash
ntfsinfo -m <image>                     # NTFS metadata
ntfsls -a <image>                       # list all files
# MFT analysis
icat -o <offset> <image> 0 > MFT       # extract $MFT
analyzeMFT.py -f MFT -o mft_output.csv
```

### FAT

```bash
# Simple structure — fls/icat work well
# Check for deleted directory entries in root directory
# FAT has no journaling — deleted files easier to recover
```

## RAID Recovery

```bash
# RAID 5 with missing disk: XOR remaining disks
python3 -c "
import sys
disks = [open(f'disk{i}.img', 'rb').read() for i in range(3)]
# XOR the available disks to recover the missing one
recovered = bytes(a ^ b for a, b in zip(disks[0], disks[1]))
open('recovered.img', 'wb').write(recovered)
"
```

## Timeline Creation

```bash
# Create bodyfile from filesystem
fls -m "/" -r -o <offset> <image> > bodyfile

# Create timeline
mactime -b bodyfile > timeline.csv
mactime -b bodyfile -d > timeline_detailed.csv

# Sort by date and filter relevant timeframe
mactime -b bodyfile 2025-01-01..2025-12-31 > filtered_timeline.csv
```
