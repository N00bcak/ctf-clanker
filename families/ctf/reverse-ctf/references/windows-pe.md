# Windows PE Analysis

## Initial Inspection
```bash
file binary.exe                         # confirm PE format
strings binary.exe | head -50           # quick string scan
# GUI: PE-bear, CFF Explorer, pestudio
```

## PE Structure
```
DOS Header → DOS Stub → PE Signature → COFF Header → Optional Header → Section Table → Sections
```
```bash
# Key fields
objdump -p binary.exe                   # PE headers
objdump -x binary.exe                   # all headers + sections
rabin2 -I binary.exe                    # radare2: general info
rabin2 -i binary.exe                    # imports
rabin2 -E binary.exe                    # exports
rabin2 -S binary.exe                    # sections
```

## Import Analysis
```python
# Python pefile — IN: binary path  OUT: imported DLLs and functions
import pefile
pe = pefile.PE('binary.exe')
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    print(f"\n{entry.dll.decode()}")
    for imp in entry.imports:
        print(f"  {hex(imp.address)}: {imp.name.decode() if imp.name else imp.ordinal}")
```
**Key DLLs**: `kernel32` (process/memory), `user32` (GUI), `ws2_32` (networking), `advapi32` (crypto/registry), `ntdll` (low-level).

## Resources Section
```python
# Extract embedded resources (icons, dialogs, embedded files)
import pefile
pe = pefile.PE('binary.exe')
for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
    for sub in entry.directory.entries:
        data = pe.get_data(sub.directory.entries[0].data.struct.OffsetToData,
                           sub.directory.entries[0].data.struct.Size)
        # data now contains the raw resource
```
```bash
# Or use: wrestool -x -t 14 binary.exe   (extract icons/cursors)
# Or: ResourceHacker (GUI)
```
**CTF use**: Flags or encrypted data often hidden in resources.

## Dynamic Analysis with x64dbg
```
# Set breakpoint at entry point
bp EntryPoint
# Set breakpoint at API call
bp kernel32.CreateFileW
bp ws2_32.send
# Memory breakpoint on a region
bpm <addr>, r|w|x
# Trace over function
ticnd <addr>, 0
# Conditional breakpoint (break only when arg matches)
bp kernel32.CreateFileW, [esp+4]=="flag.txt"
# Dump memory region
savedata <file>, <addr>, <size>
```

## Common Windows API Patterns

### File Operations
```
CreateFileW → ReadFile / WriteFile → CloseHandle
```

### Registry
```
RegOpenKeyExW → RegQueryValueExW → RegCloseKey
```

### Networking
```
WSAStartup → socket → connect → send / recv → closesocket
```

### Crypto
```
CryptAcquireContext → CryptCreateHash → CryptHashData → CryptDeriveKey → CryptEncrypt
# Or bcrypt: BCryptOpenAlgorithmProvider → BCryptGenerateSymmetricKey → BCryptEncrypt
```

### Anti-Debug (Windows)
```c
IsDebuggerPresent()                     // PEB.BeingDebugged flag
CheckRemoteDebuggerPresent()            // NtQueryInformationProcess
NtQueryInformationProcess(ProcessDebugPort)
NtQueryInformationProcess(ProcessDebugFlags)
NtQueryInformationProcess(ProcessDebugObjectHandle)
OutputDebugStringW() + GetLastError()   // error differs under debugger
NtSetInformationThread(ThreadHideFromDebugger)
```
**Bypass**: ScyllaHide (x64dbg plugin), TitanHide, or manual PEB patch.

## .NET vs Native
```bash
# Check for .NET metadata
strings binary.exe | grep -i "mscoree\|v4.0.30319\|mscorlib"
# If .NET → use dnSpy/ILSpy (see language-specific.md)
# If native → use x64dbg, IDA, Ghidra
```

## Packed PE
```bash
# Detect packing
die binary.exe                          # Detect It Easy
# Common packers: UPX, Themida, VMProtect, ASPack, PECompact
upx -d binary.exe                       # UPX unpack
# For custom packers: run until OEP, dump with Scylla (x64dbg plugin)
```

## DLL Analysis
```bash
# List exports
dumpbin /exports target.dll             # MSVC tool
rabin2 -E target.dll                    # radare2
# Load in IDA/Ghidra and analyze exported functions
# For DLL injection challenges: focus on DllMain and exported entry points
```
