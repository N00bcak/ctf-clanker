# Anti-Debug and Obfuscation

## Anti-Debug Techniques

| Technique | Detection | Bypass |
|---|---|---|
| `ptrace(PTRACE_TRACEME)` | Returns -1 if already traced | `LD_PRELOAD` stub, patch `je`→`jmp`, `catch syscall ptrace` in GDB |
| `getppid()` parent check | Checks if parent is expected | Run under expected parent, patch check |
| `/proc/self/status` TracerPid | Reads TracerPid field | `LD_PRELOAD` to fake file read |
| `/proc/self/maps` | Looks for debugger mappings | Fake the file read |
| `SIGTRAP` handler | Installs handler, executes `int3` — debugger catches it | Forward signal in GDB: `handle SIGTRAP pass` |
| `rdtsc` / `clock_gettime` | Timing check (debugger is slow) | Hardware breakpoints (no int3 patch), patch timing check |
| `IsDebuggerPresent` (Windows) | PEB flag | Patch PEB, use ScyllaHide plugin |
| `NtQueryInformationProcess` | Checks DebugPort | Hook or patch |
| Self-hashing | Computes hash of own code section | Set breakpoints via hardware, not software |
| Nanomites | `int3` used as part of program logic | Emulate `int3` handler in debugger |
| Fork/ptrace child | Parent debugs child (blocks external debugger) | Kill parent, attach to child |

### GDB Anti-Anti-Debug

```
# Forward signals
handle SIGTRAP noprint pass
handle SIGALRM noprint pass

# Catch and modify ptrace
catch syscall ptrace
commands
  set $rax = 0    # pretend success
  continue
end

# Hardware breakpoints (avoid code modification)
hb *0xADDR        # hardware breakpoint (no int3 patch)
```

### LD_PRELOAD Bypass

```c
// preload.c — fake ptrace
long ptrace(int request, ...) { return 0; }
// Compile: gcc -shared -o preload.so preload.c
// Use: LD_PRELOAD=./preload.so ./binary
```

## Obfuscation Patterns

### Control Flow Flattening

**What**: All basic blocks placed at same nesting level, connected
through a dispatcher variable. Switch statement selects next block.

**How to reverse**: Identify the dispatcher variable and trace its
values. Symbolic execution (angr, Triton) can recover the real CFG.
Alternative: binary lifting tools like `D810` IDA plugin.

### Opaque Predicates

**What**: Conditions that always evaluate to true or false but
are hard to determine statically (e.g., `x^2 + x` is always even).

**How to reverse**: Dynamic analysis reveals which branch is taken.
Or simplify expressions symbolically.

### String Encryption

**What**: Strings decrypted at runtime (XOR, RC4, AES, custom).

**How to reverse**:
1. Find the decryption function (cross-ref from string usage sites)
2. Set breakpoint after decryption, read decrypted string
3. Or: extract encrypted strings + key, decrypt offline

```bash
# GDB: break after decryption, examine result
b *0xAFTER_DECRYPT
r
x/s $rax   # or wherever the result is stored
```

### Mixed Binary Arithmetic (MBA)

**What**: Simple operations expressed as complex arithmetic
(e.g., `x + y` → `(x ^ y) + 2*(x & y)`).

**How to reverse**: Use `SSPAM` or `MBA-Flatten` tools, or
simplify with Z3/sympy.

### Self-Modifying Code

**What**: Code modifies its own instructions at runtime.

**How to reverse**:
1. Set breakpoint at the modification site
2. Continue until code is fully decrypted
3. Dump the decrypted code region
4. Or use Unicorn to emulate the decryption

### Packing / UPX

**What**: Binary is compressed or encrypted, unpacks at runtime.

```bash
upx -d packed_binary                   # UPX unpack
# For custom packers: find OEP (Original Entry Point)
# Set breakpoint at OEP after unpacking, dump memory
```

### Multi-Thread Anti-Debug with Decoy

**What**: Multiple threads run, some are decoys performing fake
computations. Only one thread does real work.

**How to reverse**: Compare computation results between threads.
Decoy threads produce garbage; the real thread produces consistent
intermediate values. Or trace `pthread_create` to identify threads.

## Deobfuscation Tools

| Tool | Purpose |
|---|---|
| D810 (IDA plugin) | Deobfuscate control flow flattening, MBA |
| Triton | Symbolic execution, taint analysis |
| Miasm | Binary analysis framework, IR lifting |
| SSPAM | MBA simplification |
| Binary Ninja | Built-in IL simplification |
| dogbolt.org | Compare decompiler outputs |
