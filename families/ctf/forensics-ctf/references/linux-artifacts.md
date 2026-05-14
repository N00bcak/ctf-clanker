# Linux Forensic Artifacts

## User Activity
```bash
cat /home/*/.bash_history /home/*/.zsh_history /root/.bash_history 2>/dev/null
cat /home/*/.ssh/id_rsa /home/*/.ssh/authorized_keys 2>/dev/null
```

## System Logs
```bash
grep "Failed password" /var/log/auth.log         # failed SSH
grep "Accepted" /var/log/auth.log                # successful SSH
grep "sudo:" /var/log/auth.log                   # sudo commands
grep -E '(\.\./|%2e|union.*select|<script)' /var/log/apache2/access.log  # web attacks
```

## Docker Forensics
```bash
docker history <image>                            # build commands (may leak secrets)
docker export <container> -o container.tar        # filesystem export
docker save <image> -o image.tar                  # image layers
# Extract layers: tar xf image.tar; inspect each */layer.tar
# Tool: dive <image> (visual layer inspector)
```
**Trap**: `ENV` and `COPY` in build history can leak .env files and secrets.

## Git Forensics
```bash
git log --all --oneline                           # full history
git log --all --diff-filter=D --name-only          # deleted files
git reflog                                         # pre-rebase/reset history
git show <commit>:<path>                           # view deleted file
git log -p --all -S "password"                     # search diffs for secrets
git fsck --unreachable                             # dangling objects
```

## Browser Artifacts
```bash
# Firefox: ~/.mozilla/firefox/*/places.sqlite
sqlite3 places.sqlite "SELECT url,title FROM moz_places ORDER BY last_visit_date DESC LIMIT 20"
# Chrome: ~/.config/google-chrome/Default/History
sqlite3 History "SELECT url,title FROM urls ORDER BY last_visit_time DESC LIMIT 20"
# Cookies, Login Data: also SQLite (encrypted values need DPAPI/gnome-keyring)
```

## KeePass
```bash
keepass2john database.kdbx > hash.txt && john hash.txt --wordlist=wordlist.txt
```

## Persistence Locations
| Path | Type |
|---|---|
| `/etc/crontab`, `/var/spool/cron/` | Cron |
| `/etc/systemd/system/`, `/etc/init.d/` | Services |
| `~/.bashrc`, `~/.profile` | Shell startup |
| `/etc/ld.so.preload` | LD_PRELOAD |
| `~/.ssh/authorized_keys` | SSH backdoor |

## Timestamps
```bash
stat <file>     # access, modify, change, birth
# Tampering tells: modify < create, clusters of identical times
```
