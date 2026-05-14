# Signals and Hardware Forensics

## VGA Signal Decoding

**When**: Raw capture of VGA video signal (analog RGB + sync).

```python
# VGA uses separate H-sync and V-sync signals
# Pixel clock determines resolution
# Common: 640x480@60Hz, 800x600@60Hz, 1024x768@60Hz

# Parse raw RGB samples
# Scale 6-bit values to 8-bit: val * 255 // 63
import numpy as np
from PIL import Image

data = np.fromfile('vga_capture.raw', dtype=np.uint8)
# Reshape based on resolution
width, height = 640, 480
pixels = data[:width*height*3].reshape(height, width, 3)
Image.fromarray(pixels).save('output.png')
```

## HDMI TMDS Decoding

**When**: Raw HDMI data capture (TMDS encoded).

TMDS (Transition-Minimized Differential Signaling) uses 10-bit
symbols for 8-bit data. Decode by:
1. Identify clock from the blue channel (carries sync)
2. Decode 10-bit TMDS symbols to 8-bit pixel values
3. Reconstruct frame from pixel stream

```python
# TMDS 10b→8b decode table
def tmds_decode(symbol_10bit):
    # Bit 9: XOR vs XNOR indicator
    # Bit 8: inversion indicator
    # Bits 7-0: data after transition minimization
    # Standard decode algorithm (DVI/HDMI spec)
    pass
```

## DisplayPort 8b/10b + LFSR

**When**: DisplayPort capture.

DisplayPort uses 8b/10b encoding (similar to TMDS but different
mapping) and LFSR scrambling for EMI reduction.

1. Decode 8b/10b symbols
2. Descramble with DisplayPort LFSR polynomial
3. Extract pixel data from lane data

## UART Serial Decode

```bash
# If you have a logic analyzer capture (.sal, .csv):
# Use Saleae Logic 2 or PulseView to decode

# Manual from sample data:
# Identify baud rate (measure bit period)
# Common: 9600, 19200, 38400, 57600, 115200
# Start bit (0), 8 data bits (LSB first), stop bit (1)
```

## SPI / I2C Decode

```bash
# Logic analyzer captures
# SPI: Clock (SCK), MOSI, MISO, CS
# I2C: SDA, SCL

# PulseView (open-source logic analyzer software)
pulseview                               # open capture, add protocol decoder
```

## SDR / RF Signal Processing

```python
# Read IQ data (complex samples)
import numpy as np

# Common formats: complex64 (float32 I + float32 Q)
iq = np.fromfile('capture.iq', dtype=np.complex64)

# Determine sample rate from challenge description
sample_rate = 2e6  # 2 MHz

# FM demodulation
phase = np.angle(iq)
demod = np.diff(np.unwrap(phase))

# AM demodulation
amplitude = np.abs(iq)
```

### Common Modulation Types

| Type | Demodulation |
|---|---|
| AM | Envelope detection (`np.abs(iq)`) |
| FM | Phase differentiation (`np.diff(np.angle(iq))`) |
| OOK | Amplitude threshold (binary) |
| FSK | Frequency discrimination |
| PSK | Phase detection + constellation |
| QAM | Demod I and Q separately |

## Flipper Zero .sub Files

```
# Text format describing RF signal
# Contains: frequency, modulation, data
# Parse the file to extract transmitted data
```

## Power Analysis (Side Channel)

**When**: Power consumption traces during cryptographic operations.

```python
# Simple Power Analysis (SPA)
# Inspect power trace visually for key-dependent patterns

# Differential Power Analysis (DPA)
# Collect many traces with known plaintexts
# Hypothesize key byte, compute intermediate value
# Correlate intermediate value with power consumption
# Correct key byte shows highest correlation

import numpy as np
traces = np.load('traces.npy')  # shape: (num_traces, num_samples)
plaintexts = np.load('plaintexts.npy')

# For each key byte hypothesis (0-255):
for key_guess in range(256):
    # Compute hypothetical intermediate value
    intermediate = sbox[plaintexts[:, target_byte] ^ key_guess]
    # Compute bit value (e.g., bit 0)
    bit = (intermediate >> 0) & 1
    # Split traces into two groups
    group0 = traces[bit == 0].mean(axis=0)
    group1 = traces[bit == 1].mean(axis=0)
    diff = group1 - group0
    # Highest peak in diff → correct key guess
```

## Acoustic Side Channel

**When**: Audio recording of keyboard typing.

```python
# Identify keystroke boundaries from audio peaks
# Classify keystrokes by their acoustic signature
# Frequency analysis of key press/release sounds
# ML-based approaches: train classifier on known keys
```

## Electromagnetic Emanation

Screen content can be reconstructed from electromagnetic emissions
(TEMPEST). Challenge may provide raw EM capture:
1. Identify pixel clock frequency
2. Demodulate video signal
3. Reconstruct image frame-by-frame
