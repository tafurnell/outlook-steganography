#!/usr/bin/env python3
"""Regenerate the trimmed Allura font embedded in stego-core (D-037).

  pip install fonttools
  python scripts/subset-font.py <path/to/Allura-Regular.ttf (full, from Google Fonts)>

Keeps Basic Latin, Latin-1 Supplement, Latin Extended-A (all Western/Central European
letters), common typographic punctuation, € and ™. Keeps only the 'kern' layout feature
(the renderer does no other shaping) and drops hinting (the renderer doesn't use it).
The signature text is the only thing drawn with this font – secrets are never rendered,
so this does not limit what a secret can contain.
SIL OFL 1.1: no Reserved Font Name is declared, so the subset may keep its name; OFL.txt
must ship alongside it.
"""
import sys
from fontTools import subset

UNICODES = "U+0020-007E,U+00A0-017F,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+20AC,U+2122"

src = sys.argv[1] if len(sys.argv) > 1 else "Allura-Regular.full.ttf"
out = "crates/stego-core/assets/fonts/Allura-Regular.ttf"
subset.main([
    src,
    f"--unicodes={UNICODES}",
    "--layout-features=kern",
    "--no-hinting",
    "--name-IDs=*",
    "--notdef-outline",
    f"--output-file={out}",
])
print(f"wrote {out}")
