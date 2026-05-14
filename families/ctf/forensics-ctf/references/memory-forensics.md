# Memory Forensics

## Volatility 2

```bash
# Identify OS profile
vol.py -f <dump> imageinfo
vol.py -f <dump> kdbgscan                # more reliable profile detection

# Process analysis
vol.py -f <dump> --profile=<P> pslist    # running processes
vol.py -f <dump> --profile=<P> pstree    # process tree
vol.py -f <dump> --profile=<P> psscan    # scan for hidden processes
vol.py -f <dump> --profile=<P> cmdline   # command lines
vol.py -f <dump> --profile=<P> envars    # environment variables

# File analysis
vol.py -f <dump> --profile=<P> filescan  # all file handles
vol.py -f <dump> --profile=<P> dumpfiles -Q <offset> -D out/

# Network
vol.py -f <dump> --profile=<P> netscan   # network connections
vol.py -f <dump> --profile=<P> connscan  # (XP/2003)

# Credentials
vol.py -f <dump> --profile=<P> hashdump  # SAM password hashes
vol.py -f <dump> --profile=<P> lsadump   # LSA secrets
vol.py -f <dump> --profile=<P> mimikatz  # (with plugin)

# Registry
vol.py -f <dump> --profile=<P> hivelist  # registry hives
vol.py -f <dump> --profile=<P> printkey -K "Software\\Microsoft\\Windows\\CurrentVersion\\Run"

# Misc
vol.py -f <dump> --profile=<P> clipboard # clipboard contents
vol.py -f <dump> --profile=<P> screenshot -D out/  # screen captures
vol.py -f <dump> --profile=<P> cmdscan   # command history
vol.py -f <dump> --profile=<P> consoles  # console output
vol.py -f <dump> --profile=<P> malfind   # injected/suspicious code
vol.py -f <dump> --profile=<P> dlllist   # loaded DLLs
```

## Volatility 3

```bash
vol -f <dump> windows.info              # system info (no profile needed)
vol -f <dump> windows.pslist            # process list
vol -f <dump> windows.pstree            # process tree
vol -f <dump> windows.cmdline           # command lines
vol -f <dump> windows.filescan          # file handles
vol -f <dump> windows.dumpfiles --pid <pid>  # dump process files
vol -f <dump> windows.netscan           # network connections
vol -f <dump> windows.hashdump          # SAM hashes
vol -f <dump> windows.registry.printkey --key "Software\\Microsoft"
vol -f <dump> windows.malfind           # suspicious memory
vol -f <dump> windows.handles --pid <pid>  # handles

# Linux
vol -f <dump> linux.pslist
vol -f <dump> linux.bash                # bash history from memory
vol -f <dump> linux.check_syscall       # syscall table hooks
vol -f <dump> linux.proc.maps --pid <pid>  # memory maps
```

## Common Analysis Workflow

1. **Identify profile/OS** → `imageinfo` or `windows.info`
2. **Process list** → look for suspicious processes (unusual names, high PID, unknown parent)
3. **Command history** → `cmdscan`, `consoles`, `bash`
4. **Network connections** → suspicious outbound connections (C2)
5. **File handles** → what files were open
6. **Dump suspicious processes** → `procdump`, then analyze with RE tools
7. **Check for injected code** → `malfind` (RWX memory regions)
8. **Credentials** → `hashdump`, `lsadump`
9. **Registry** → persistence mechanisms, recent activity

## Key Targets

| Target | Why |
|---|---|
| Unusual processes | Malware, lateral movement tools |
| cmd.exe / PowerShell | Attacker commands |
| Network connections | C2 servers, exfiltration destinations |
| Injected code (malfind) | Process injection, shellcode |
| SAM hashes | Credential theft |
| Browser processes | Visited URLs, credentials |
| Open files | Recently accessed sensitive data |
| Clipboard | Copied passwords, commands |

## Process Dump and Analysis

```bash
# Dump process executable
vol.py -f <dump> --profile=<P> procdump -p <pid> -D out/

# Dump process memory
vol.py -f <dump> --profile=<P> memdump -p <pid> -D out/

# Search for strings in dumped memory
strings out/<pid>.dmp | grep -i "flag\|password\|key"
```

## Linux Memory Analysis

```bash
# Extract from /proc
vol -f <dump> linux.proc.maps --pid <pid>
vol -f <dump> linux.bash
vol -f <dump> linux.elfs                # ELF binaries in memory

# Strings search
strings <dump> | grep -i "flag{"
strings -el <dump> | grep -i "flag{"    # wide strings
```
