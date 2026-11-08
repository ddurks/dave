"""Trace a hand-drawn 8-column glyph grid PNG into a TrueType font.

usage: python3 gen_font.py <grid.png> [out.ttf]
"""
import sys
import cv2
import numpy as np
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "../assets/AngularDaveHand.ttf"
FAMILY = "AngularDaveHand"

# Grid order, left-to-right, top-to-bottom.
ORDER = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789"
    ".,'\"-?!:()"
)
COLS = 8
# Glyphs that hang below or float above the baseline; they don't vote on it.
OFF_BASELINE = set("gjpqy,()Q'\"-")

UPM = 1000
SCALE = 7  # font units per source pixel
SIDE = 50  # side bearing, font units
SPACE = 320

img = cv2.imread(SRC, cv2.IMREAD_UNCHANGED)
if img.ndim == 3 and img.shape[2] == 4:
    # Transparent background: ink is whatever is both opaque and dark.
    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)
    ink = ((img[:, :, 3] > 128) & (gray < 128)).astype(np.uint8)
else:
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ink = (gray < 128).astype(np.uint8)
rows = -(-len(ORDER) // COLS)
cell_w, cell_h = img.shape[1] / COLS, img.shape[0] / rows


def cell(i):
    r, c = divmod(i, COLS)
    y0, x0 = round(r * cell_h), round(c * cell_w)
    return ink[y0:round(y0 + cell_h), x0:round(x0 + cell_w)].copy(), y0


cells = [cell(i) for i in range(len(ORDER))]

# Baseline per grid row: median ink bottom of the non-descending glyphs.
baselines = {}
for r in range(rows):
    bottoms = []
    for i in range(r * COLS, min((r + 1) * COLS, len(ORDER))):
        if ORDER[i] in OFF_BASELINE:
            continue
        ys = np.nonzero(cells[i][0].any(axis=1))[0]
        bottoms.append(ys.max())
    baselines[r] = float(np.median(bottoms))


def signed_area(pts):
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)


glyphs, metrics, cmap = {}, {}, {}
for i, ch in enumerate(ORDER):
    mask, _ = cells[i]
    xs = np.nonzero(mask.any(axis=0))[0]
    # Sit each glyph on its own bottom edge; descenders and floating marks use the row's baseline.
    if ch in OFF_BASELINE:
        base = baselines[i // COLS]
    else:
        base = np.nonzero(mask.any(axis=1))[0].max() + 1
    left, right = xs.min(), xs.max() + 1
    contours, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    pen = TTGlyphPen(None)
    for k, cnt in enumerate(contours):
        if cv2.contourArea(cnt) < 12:
            continue
        cnt = cv2.approxPolyDP(cnt, 1.2, True)[:, 0, :].astype(float)
        if len(cnt) < 3:
            continue
        pts = np.column_stack([
            (cnt[:, 0] - left) * SCALE + SIDE,
            (base - cnt[:, 1]) * SCALE,
        ]).round().astype(int)
        hole = hier[0][k][3] != -1
        # TrueType: outer contours clockwise (negative area), holes counter-clockwise.
        if (signed_area(pts.astype(float)) < 0) == hole:
            pts = pts[::-1]
        pen.moveTo(tuple(pts[0]))
        for p in pts[1:]:
            pen.lineTo(tuple(p))
        pen.closePath()
    name = f"uni{ord(ch):04X}"
    glyphs[name] = pen.glyph()
    metrics[name] = ((right - left) * SCALE + 2 * SIDE, SIDE)
    cmap[ord(ch)] = name

glyphs[".notdef"] = TTGlyphPen(None).glyph()
metrics[".notdef"] = (SPACE, 0)
glyphs["space"] = TTGlyphPen(None).glyph()
metrics["space"] = (SPACE, 0)
cmap[32] = "space"

order = [".notdef", "space"] + [cmap[ord(c)] for c in ORDER]
fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=850, descent=-250)
fb.setupOS2(sTypoAscender=850, sTypoDescender=-250, sTypoLineGap=100,
            usWinAscent=950, usWinDescent=300, sxHeight=520, sCapHeight=700)
fb.setupNameTable({"familyName": FAMILY, "styleName": "Regular"})
fb.setupPost()
fb.save(OUT)
print(f"wrote {OUT}: {len(ORDER)} glyphs, baselines {[round(b) for b in baselines.values()]}")
