# PCAP Analysis

## Overview
```bash
capinfos <pcap>                                  # file stats
tshark -r <pcap> -q -z conv,tcp                  # TCP conversations
tshark -r <pcap> -q -z io,phs                    # protocol hierarchy
tshark -r <pcap> -q -z endpoints,ip              # IP endpoints
```

## Filtering
```bash
tshark -r <pcap> -Y "http"                       # HTTP only
tshark -r <pcap> -Y "dns"                        # DNS only
tshark -r <pcap> -Y "tcp.port==4444"             # specific port
tshark -r <pcap> -Y "ip.addr==10.0.0.1"          # specific IP
tshark -r <pcap> -Y "tcp.flags.syn==1 && tcp.flags.ack==0"  # SYN scan
```

## Extraction
```bash
tshark -r <pcap> --export-objects http,out/       # HTTP files
tshark -r <pcap> --export-objects smb,out/        # SMB files
tshark -r <pcap> -Y "tcp.stream eq 0" -T fields -e data | xxd -r -p  # raw stream
```

## HTTP
```bash
tshark -r <pcap> -Y "http.request" -T fields -e http.request.method -e http.request.full_uri
tshark -r <pcap> -Y "http.request.method==POST" -T fields -e http.file_data
tshark -r <pcap> -Y "http.cookie" -T fields -e http.cookie
tshark -r <pcap> -Y "http.user_agent" -T fields -e http.user_agent | sort -u
```

## DNS
```bash
tshark -r <pcap> -Y "dns.qry.name" -T fields -e dns.qry.name -e dns.a
# Long/hex subdomains → likely DNS exfiltration (see network-steganography.md)
```

## TLS Decryption
```bash
tshark -r <pcap> -o "tls.keylog_file:sslkeys.log" -Y "http"     # with SSLKEYLOGFILE
tshark -r <pcap> -o "tls.keys_list:IP,PORT,http,key.pem"        # with RSA private key
# If RSA key is weak: factor from certificate, reconstruct, then decrypt
```

## Credentials
```bash
tshark -r <pcap> -Y "ftp.request.command==USER||ftp.request.command==PASS" -T fields -e ftp.request.arg
tshark -r <pcap> -Y "http.authorization" -T fields -e http.authorization  # Base64 decode
```

## USB HID
```bash
tshark -r <pcap> -Y "usb.transfer_type==1 && usb.data_len==8" -T fields -e usb.capdata
# Parse scancodes → keystrokes via USB HID scancode lookup table
```

## Wireshark GUI
Statistics → Conversations | Protocol Hierarchy. Follow → TCP Stream. File → Export Objects → HTTP. Edit → Find Packet → String.
