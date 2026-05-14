# Windows Forensic Artifacts

## Event Logs (.evtx)

```bash
# Parse with evtx_dump
evtx_dump.py Security.evtx | grep -i "logon\|4624\|4625"

# Python evtx library
python3 -c "
import Evtx.Evtx as evtx
with evtx.Evtx('Security.evtx') as log:
    for record in log.records():
        print(record.xml())
" | head -200
```

### Key Event IDs

| Event ID | Log | Meaning |
|---|---|---|
| 4624 | Security | Successful logon |
| 4625 | Security | Failed logon |
| 4648 | Security | Explicit credential logon |
| 4672 | Security | Special privileges assigned |
| 4688 | Security | Process creation (if auditing enabled) |
| 4720 | Security | User account created |
| 4732 | Security | Member added to group |
| 7045 | System | Service installed |
| 1 | Sysmon | Process creation (with command line) |
| 3 | Sysmon | Network connection |
| 11 | Sysmon | File creation |
| 1102 | Security | Audit log cleared |

## Registry

```bash
# Parse registry hives
regipy <hive_file>                      # Python registry parser
regripper -r <hive_file> -a            # run all plugins

# Key hive locations:
# SAM:     C:\Windows\System32\config\SAM
# SYSTEM:  C:\Windows\System32\config\SYSTEM
# SOFTWARE: C:\Windows\System32\config\SOFTWARE
# NTUSER.DAT: C:\Users\<user>\NTUSER.DAT
# UsrClass.dat: C:\Users\<user>\AppData\Local\Microsoft\Windows\UsrClass.dat
```

### Important Registry Keys

| Key | Contents |
|---|---|
| `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` | Auto-start programs |
| `HKLM\SYSTEM\CurrentControlSet\Services` | Service configurations |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\RecentDocs` | Recent documents |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU` | Run dialog history |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\TypedPaths` | Explorer address bar history |
| `HKLM\SAM\SAM\Domains\Account\Users` | User accounts |
| `HKLM\SYSTEM\CurrentControlSet\Control\ComputerName` | Computer name |
| `HKLM\SYSTEM\CurrentControlSet\Control\TimeZoneInformation` | Time zone |
| `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` | User profiles |

## SAM Database

```bash
# Extract password hashes (needs SAM + SYSTEM hives)
samdump2 SYSTEM SAM
secretsdump.py -sam SAM -system SYSTEM LOCAL

# Crack hashes
hashcat -m 1000 hashes.txt wordlist.txt  # NTLM
john --format=nt hashes.txt
```

## Recycle Bin

```
# Location: C:\$Recycle.Bin\<SID>\
# $I files: metadata (original path, deletion time)
# $R files: actual file content

# Parse with rifiuti2
rifiuti-vista.exe $Recycle.Bin/<SID>/
```

## Prefetch

```
# Location: C:\Windows\Prefetch\*.pf
# Shows: last 8 run times, run count, files accessed

# Parse with PECmd
PECmd.exe -f <prefetch_file>
```

## NTFS Artifacts

### MFT (Master File Table)

```bash
# Extract and parse MFT
analyzeMFT.py -f MFT -o output.csv

# Key columns: filename, creation time, modification time,
# MFT modification time, access time, file size, flags
```

### USN Journal

```bash
# Change journal — records all file system changes
# Extract from $UsnJrnl:$J
# Parse with usnjrnl2csv
```

### LNK Files (Shortcuts)

```bash
# Location: C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Recent\
# Contains: target path, MAC times, volume info, sometimes network paths
LECmd.exe -f <lnk_file>
```

## Browser Artifacts

```
# Chrome: C:\Users\<user>\AppData\Local\Google\Chrome\User Data\Default\
#   History, Cookies, Login Data, Bookmarks (SQLite)
# Firefox: C:\Users\<user>\AppData\Roaming\Mozilla\Firefox\Profiles\
#   places.sqlite, cookies.sqlite, logins.json
# Edge: C:\Users\<user>\AppData\Local\Microsoft\Edge\User Data\Default\

sqlite3 History "SELECT url, title, visit_count FROM urls ORDER BY last_visit_time DESC LIMIT 20"
```

## Amcache
```
# Location: C:\Windows\AppCompat\Programs\Amcache.hve (registry hive)
# Contains: SHA-1 hashes, full paths, timestamps for executed programs
# Parse:
AmcacheParser.exe -f Amcache.hve --csv output/
# Or: regipy Amcache.hve
# Key evidence: proves a program EXISTED and was catalogued (not necessarily executed)
# Compare with Prefetch/Shimcache for stronger execution evidence
```

## Shimcache (AppCompatCache)
```
# Location: SYSTEM registry hive → ControlSet001\Control\Session Manager\AppCompatCache
# Contains: file path, last modified time, execution flag (unreliable on Win10+)
# Parse:
AppCompatCacheParser.exe -f SYSTEM --csv output/
# Or: ShimCacheParser.py -i SYSTEM -o output.csv
# Key evidence: proves a file WAS ON DISK at or before last shutdown
# Trap: on Windows 10+, presence in Shimcache does NOT prove execution — only file existence
```

## Shellbags
```
# Location: NTUSER.DAT (HKCU) and UsrClass.dat
# Contains: folder access history — every folder ever opened in Explorer, including deleted/USB/network
# Parse:
SBECmd.exe -d output/ --hive NTUSER.DAT
ShellBagsExplorer (GUI)
# Key evidence: proves user BROWSED to a directory, even if contents are deleted
# Persists across reboots and file deletion
```

## Jump Lists
```
# Location: C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Recent\AutomaticDestinations\
# and: C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Recent\CustomDestinations\
# Contains: recently opened files PER APPLICATION (MRU lists)
# Parse:
JLECmd.exe -d AutomaticDestinations/ --csv output/
# Each .automaticDestinations-ms file corresponds to an application (AppID)
```

## SRUM (System Resource Usage Monitor)
```
# Location: C:\Windows\System32\sru\SRUDB.dat (ESE database)
# Contains: per-application CPU/network/energy usage with timestamps
# Parse:
srum_dump.py -i SRUDB.dat -t SOFTWARE -o output.xlsx
# Or: SrumECmd.exe -f SRUDB.dat -r SOFTWARE --csv output/
# Key evidence: proves application ran during specific time windows, shows network bytes sent/received
```

## PowerShell History

```
# Location: C:\Users\<user>\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt
# Plain text file — just cat it
```

## Windows Defender Logs

```
# MPLog: C:\ProgramData\Microsoft\Windows Defender\Support\MPLog-*.log
# Contains: detected threats, scan results, quarantine actions
```
