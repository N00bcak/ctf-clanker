# Firmware and Embedded Systems Reversing

## Firmware Extraction

```bash
binwalk <firmware.bin>                  # identify embedded files and offsets
binwalk -e <firmware.bin>               # extract all identified components
```

### Common Firmware Formats

| Format | Identification | Extraction |
|---|---|---|
| Plain binary (raw flash dump) | No headers, starts with ISR table (ARM) or bootloader | Manual at known offsets |
| U-Boot | `U-Boot` string, `uImage` header (0x27051956) | binwalk, `dumpimage` |
| SquashFS | `sqsh`/`hsqs` magic | `unsquashfs` |
| JFFS2 | `0x1985` magic | `jefferson` or `jffs2dump` |
| CramFS | `0x28CD3D45` magic | `cramfsck` |
| UBIFS | `UBI#` magic | `ubireader` |
| Intel HEX | Lines starting with `:` | `objcopy -I ihex -O binary` |
| ELF | `\x7fELF` | Standard tools |

### Filesystem Mounting

```bash
# SquashFS
unsquashfs -d output/ filesystem.squashfs

# JFFS2
modprobe mtdblock
modprobe jffs2
dd if=filesystem.jffs2 of=/dev/mtdblock0
mount -t jffs2 /dev/mtdblock0 /mnt

# Or use QEMU user-mode to explore
```

## Architecture Identification

```bash
file <binary>                           # architecture and endianness
readelf -h <binary>                     # detailed ELF header
binwalk -A <firmware.bin>               # architecture scan
```

| Architecture | Common In | Key Differences |
|---|---|---|
| ARM (32-bit) | IoT, routers, phones | Thumb mode, conditional execution |
| ARM64/AArch64 | Modern SoCs, phones | 31 GP registers, no Thumb |
| MIPS | Routers, embedded Linux | Branch delay slots, 32 registers |
| MIPS64 | Higher-end networking | Same quirks as MIPS |
| PowerPC | Legacy networking, game consoles | Big-endian default, CR register |
| AVR | Arduino, microcontrollers | 8-bit, Harvard architecture |
| Xtensa | ESP8266/ESP32 | Configurable ISA |
| RISC-V | Emerging IoT/embedded | Open ISA, variable extensions |

## Emulation

```bash
# QEMU system emulation (full system)
qemu-system-arm -M versatilepb -kernel zImage -initrd rootfs.cpio.gz -append "console=ttyAMA0" -nographic

# QEMU user-mode (single binary)
qemu-arm ./arm_binary
qemu-mipsel ./mips_binary
qemu-arm -g 1234 ./arm_binary          # GDB server for debugging

# With custom rootfs
qemu-arm -L ./extracted_rootfs/ ./extracted_rootfs/usr/bin/target
```

## Key Analysis Targets in Firmware

| Target | Why |
|---|---|
| `/etc/shadow`, `/etc/passwd` | Hardcoded credentials |
| `*.conf` files | Service configurations, keys |
| Web server files (`/www/`, `/var/www/`) | Web interface source (command injection, auth bypass) |
| Init scripts (`/etc/init.d/`, `/etc/rc.d/`) | Startup services, debug interfaces |
| SSL certificates and keys | Decrypt traffic |
| Busybox configuration | Available commands |
| Kernel modules (`.ko`) | Custom drivers, vulnerabilities |
| `nvram` data | Configuration storage |

## Hardware Interface Analysis

### UART

```bash
# Identify UART pins: TX, RX, GND, VCC
# Common baud rates: 9600, 19200, 38400, 57600, 115200
screen /dev/ttyUSB0 115200
minicom -D /dev/ttyUSB0 -b 115200
```

### JTAG/SWD

```bash
# OpenOCD for JTAG debugging
openocd -f interface/jlink.cfg -f target/stm32f1x.cfg
# Then connect GDB: target remote :3333

# SWD (Serial Wire Debug) — 2-pin alternative to JTAG
# Common on ARM Cortex-M
```

### SPI Flash Reading

```bash
# Read SPI flash chip directly
flashrom -p ch341a_spi -r firmware_dump.bin
# Or use a Bus Pirate, logic analyzer
```

## Bootloader Analysis

```bash
# U-Boot shell (if accessible via UART)
# Common commands:
printenv                                # environment variables
md 0x80000000 100                      # memory dump
loadb                                   # load binary via serial
bootm                                   # boot from memory
```

Look for: debug UART shells, network boot (TFTP), writable environment
variables that affect boot process.
