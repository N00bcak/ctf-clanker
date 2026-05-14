# Image Steganography

## Systematic Check Order

1. **Metadata** → 2. **Appended data** → 3. **File structure** →
4. **LSB analysis** → 5. **Visual inspection** → 6. **Tool-specific stego** →
7. **Palette/channel** → 8. **Advanced techniques**

## Step 1: Metadata

```bash
exiftool <image>                        # all metadata fields
identify -verbose <image>               # ImageMagick details
```

Check: EXIF comments, GPS coordinates, author fields, thumbnail
images, custom metadata chunks (PNG tEXt, zTXt, iTXt).

## Step 2: Appended Data

```bash
binwalk <image>                         # embedded files
binwalk -e <image>                      # extract embedded files
# Compare file size to expected: a JPEG that's 5MB for a small image is suspicious
```

## Step 3: File Structure

```bash
pngcheck -v <image>                     # PNG chunk validation
jpeginfo -c <image>                     # JPEG structure check
```

Look for: extra chunks, corrupted headers, unusual chunk ordering.

## Step 4: LSB Analysis

### PNG (lossless — LSB preserves exactly)

```bash
zsteg <image>                           # comprehensive LSB analysis
zsteg -a <image>                        # try all combinations
zsteg <image> -e "b1,rgb,lsb,xy"       # extract specific pattern

# Common zsteg findings:
# b1,r,lsb,xy — bit 1 of red channel, left-to-right top-to-bottom
# b1,rgb,lsb,xy — bit 1 of all RGB channels
# b1,bgr,lsb,xy — bit 1 of BGR order
```

### Custom LSB Extraction

```python
from PIL import Image

img = Image.open('image.png')
pixels = img.load()
bits = ''
for y in range(img.height):
    for x in range(img.width):
        r, g, b = pixels[x, y][:3]
        bits += str(r & 1)  # LSB of red
        bits += str(g & 1)  # LSB of green
        bits += str(b & 1)  # LSB of blue

# Convert bits to bytes
data = bytes(int(bits[i:i+8], 2) for i in range(0, len(bits), 8))
print(data[:100])
```

## Step 5: Visual Inspection (stegsolve)

**stegsolve** (Java GUI): cycle through bit planes visually.
- Red/Green/Blue plane 0-7
- XOR, AND, OR combinations
- Random color map
- Frame browser (animated images)

Look for: QR codes, text, patterns in individual bit planes.

## Step 6: Tool-Specific Stego

### steghide (JPEG/BMP)

```bash
steghide extract -sf <image>            # extract (prompts for password)
steghide extract -sf <image> -p ""      # try empty password
steghide extract -sf <image> -p "password"
steghide info <image>                   # check if steghide was used

# Brute-force password
stegseek <image> wordlist.txt           # fast steghide cracker
```

### OpenStego

```bash
openstego extract -sf <image> -xd output/
```

## Step 7: Palette and Channel

### PNG Palette Manipulation

```python
from PIL import Image
img = Image.open('image.png')
if img.mode == 'P':  # palette mode
    palette = img.getpalette()
    # Check palette entries for hidden data
    # Data might be in palette order or specific entries
```

### Channel Separation

```bash
convert <image> -channel R -separate red.png
convert <image> -channel G -separate green.png
convert <image> -channel B -separate blue.png
convert <image> -channel A -separate alpha.png
```

### Cross-Channel LSB

Data encoded using different bit positions per channel:
```python
# Example: R[0], G[1], B[2]
r_bit = (r >> 0) & 1  # bit 0 of red
g_bit = (g >> 1) & 1  # bit 1 of green
b_bit = (b >> 2) & 1  # bit 2 of blue
```

## Step 8: Advanced

### Pixel Permutation

Pixels scrambled with a seed-based permutation:
```python
import random
random.seed(known_seed)
indices = list(range(width * height))
random.shuffle(indices)
# Unshuffle pixels using inverse permutation
```

### DCT Domain (JPEG)

JPEG LSB doesn't work the same as PNG — use DCT coefficient analysis:
- **F5**: modifies DCT coefficients
- **JSteg**: embeds in LSB of non-zero DCT coefficients
- Detection: `stegdetect <jpeg>`, histogram analysis

### Wiener Deconvolution

For blurred images hiding data:
```python
from scipy.signal import wiener
import cv2
img = cv2.imread('blurred.png', 0)
recovered = wiener(img, (5,5), 0.01)
```
