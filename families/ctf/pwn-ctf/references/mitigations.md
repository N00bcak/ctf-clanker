# Binary Mitigations Reference

## checksec Output

```
checksec --file=./binary
```

| Mitigation | Check | When Enabled | Bypass Strategy |
|---|---|---|---|
| **NX** (No Execute) | Stack/heap non-executable | Default on modern compilers | ROP, ret2libc, ret2csu, one-gadget |
| **Stack Canary** | Guard value before saved RBP/RIP | `-fstack-protector` | Leak canary (format string, info leak), brute-force (forking server), overwrite specific variables without touching canary |
| **PIE** (Position Independent Executable) | Binary base randomized | `-pie` | Leak binary address (format string, info leak), partial overwrite (low 12 bits are fixed) |
| **Full RELRO** | GOT read-only after init | `-Wl,-z,relro,-z,now` | Cannot overwrite GOT; target `__malloc_hook`, `__free_hook` (pre-2.34), exit handlers, return addresses, FILE structs |
| **Partial RELRO** | GOT writable, some sections read-only | `-Wl,-z,relro` | GOT overwrite viable |
| **ASLR** | Stack, heap, library addresses randomized | System-wide (`/proc/sys/kernel/randomize_va_space`) | Leak addresses, partial overwrite, brute-force (32-bit) |
| **Fortify Source** | Some format string functions replaced with checked versions | `-D_FORTIFY_SOURCE=2` | Use non-fortified variants, indirect calls |
| **Seccomp** | Restricted syscall set | `prctl(PR_SET_SECCOMP, ...)` or `seccomp()` | `seccomp-tools dump ./binary` to see allowed syscalls; use allowed syscalls creatively (e.g., `openat` + `sendfile`, `openat2` + `read` + `write`) |

## Seccomp Analysis

```bash
seccomp-tools dump ./binary           # dump seccomp filter
seccomp-tools disasm filter.bpf       # disassemble filter
```

Common allowed-syscall strategies when `execve` is blocked:
- `open` / `openat` + `read` + `write` (ORW)
- `openat2` (may bypass `open`/`openat` filter)
- `sendfile` (avoids needing a buffer)
- `mmap` + `read` to map flag into memory, then leak via side-channel

## Post-glibc-2.34 Changes

As of glibc 2.34 (2021), `__malloc_hook`, `__free_hook`, and
`__realloc_hook` are removed. Exploitation targets shift to:

- **`_IO_FILE` vtable abuse** (House of Apple / House of Apple 2)
- **`_IO_wfile_overflow` via wide data vtable** (glibc 2.35+)
- **Exit handlers** (`__exit_funcs`, `__run_exit_handlers`)
- **TLS destructor list** (`__call_tls_dtors`)
- **`atexit` handlers**
- **Stack return addresses** (still work, harder with ASLR/canary)

## ASLR Entropy

| Platform | Stack Entropy | mmap Entropy | Brute-Force Feasibility |
|---|---|---|---|
| 32-bit Linux | 8 bits | 8 bits | ~256 attempts (seconds) |
| 64-bit Linux | 30 bits | 28 bits | Infeasible without leak |
| Forking server | Same layout per connection | Same layout per connection | Leak once, use forever until restart |
