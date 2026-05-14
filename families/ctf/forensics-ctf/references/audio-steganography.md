# Audio Steganography

## Spectrogram Analysis

**First check for every audio challenge.**

```bash
sox <audio> -n spectrogram -o spec.png  # generate spectrogram image
# Or open in Audacity: Analyze → Plot Spectrum, or View → Spectrogram
```

Hidden images or text are often visible in the frequency domain
as patterns drawn in the spectrogram.

**Audacity spectrogram settings**: right-click on track label →
Spectrogram Settings → increase window size (4096-8192) for
better frequency resolution.

## DTMF Tone Decoding

**When**: Audio contains phone dialing tones.

```bash
multimon-ng -t wav -a DTMF <audio>     # decode DTMF tones
# Output: DTMF: X (where X is the digit/symbol)
```

| Tone | Frequencies (Hz) |
|---|---|
| 1 | 697 + 1209 |
| 2 | 697 + 1336 |
| 3 | 697 + 1477 |
| * | 941 + 1209 |
| 0 | 941 + 1336 |
| # | 941 + 1477 |

## SSTV (Slow-Scan Television)

**When**: Audio contains a characteristic SSTV sync tone
(sounds like a warbling/buzzing pattern).

```bash
qsstv                                  # GUI SSTV decoder
# Or use direwolf, mmsstv (Windows)
```

SSTV encodes images in audio — common in ham radio and CTF
forensics challenges.

## Morse Code

**When**: Audio contains short and long beeps (dits and dahs).

1. Open in Audacity
2. Identify the pattern visually in the waveform
3. Decode: `.` = short, `-` = long
4. Or use an online Morse decoder with audio input

```
# Morse reference (common letters)
E .     T -     A .-    N -.    I ..    M --
S ...   O ---   H ....  R .-.   L .-..
```

## LSB Audio Steganography

**When**: Data hidden in the least significant bits of audio samples.

```python
import wave
import struct

wav = wave.open('audio.wav', 'rb')
frames = wav.readframes(wav.getnframes())
samples = struct.unpack(f'<{len(frames)//2}h', frames)  # 16-bit signed

# Extract LSB from each sample
bits = ''.join(str(s & 1) for s in samples)
data = bytes(int(bits[i:i+8], 2) for i in range(0, len(bits) - 7, 8))
print(data[:100])
```

For 8-bit audio: samples are unsigned bytes, LSB extraction simpler.

## Frequency-Based Hiding

**When**: Data hidden in specific frequency bands not audible or
not obvious in normal playback.

1. Apply band-pass filter in Audacity to isolate frequency range
2. Check for data modulated onto a carrier frequency
3. Use FFT to identify unusual frequency components

```python
import numpy as np
from scipy.io import wavfile
from scipy.fft import fft

rate, data = wavfile.read('audio.wav')
if data.ndim > 1:
    data = data[:, 0]  # mono

spectrum = np.abs(fft(data))
freqs = np.fft.fftfreq(len(data), 1/rate)

# Look for unusual peaks
top_freqs = freqs[np.argsort(spectrum)[-20:]]
print("Dominant frequencies:", sorted(abs(top_freqs)))
```

## Multi-Track Differential

**When**: Two audio tracks that sound identical but differ in hidden data.

```python
# Subtract one track from another to reveal differences
import numpy as np
from scipy.io import wavfile

_, track1 = wavfile.read('track1.wav')
_, track2 = wavfile.read('track2.wav')

diff = track1.astype(np.int32) - track2.astype(np.int32)
# Non-zero values in diff contain hidden data
```

## Musical Note Encoding

**When**: Specific musical notes encode data (note names → letters,
MIDI note numbers → ASCII).

Identify notes using: pitch detection, FFT, or Audacity's
spectrogram with note labels enabled.

## Metadata in Audio

```bash
exiftool <audio>                        # metadata
ffprobe <audio>                         # format details
mediainfo <audio>                       # comprehensive info
strings <audio> | head -50              # embedded strings
```

Check for: ID3 tags (MP3), Vorbis comments (OGG), RIFF INFO (WAV),
cover art (may contain stego), custom metadata fields.
