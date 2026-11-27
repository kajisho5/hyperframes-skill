#!/usr/bin/env python3
"""Build tests/fixtures/fonts/hfs-test-blocks.ttf: a variable test font of plain blocks.

Every glyph is a rectangle, so a test can count what was drawn without depending on the shapes of a
machine's fonts: a base character is one block (its own column of ink), a combining mark (Unicode
category Mn or Me) has no advance and sits above the base, so a grapheme cluster is one run of ink
columns. CJK, kana and full-width punctuation get a full-width block. The `wght` axis (100-900,
default 400) widens the block inside an unchanged advance; `wdth` (50-200, default 100) is declared
so the axis list has more than one entry. Run with fontTools: python3 build-test-font.py
"""
import os
import sys
import unicodedata

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.TupleVariation import TupleVariation

UPM = 1000


def rect(x0, y0, x1, y1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, y0))
    pen.lineTo((x0, y1))
    pen.lineTo((x1, y1))
    pen.lineTo((x1, y0))
    pen.closePath()
    return pen.glyph()


def empty():
    return TTGlyphPen(None).glyph()


# name: (advance, rect at wght 400, rect at wght 900, rect at wght 100)
GLYPHS = {
    ".notdef": (600, (100, 0, 500, 700), (100, 0, 500, 700), (100, 0, 500, 700)),
    "space": (300, None, None, None),
    "base": (600, (150, 0, 450, 700), (50, 0, 550, 700), (250, 0, 350, 700)),
    "cjk": (1000, (150, -100, 850, 800), (50, -100, 950, 800), (300, -100, 700, 800)),
    "mark": (0, (-450, 780, -150, 880), (-550, 780, -50, 880), (-350, 780, -250, 880)),
}


def ranges():
    cps = {}
    for cp in list(range(0x21, 0x7F)) + list(range(0xA1, 0x250)) + list(range(0x300, 0x370)) + list(range(0x590, 0x600)) + list(range(0x600, 0x700)) + list(range(0x900, 0x980)) + list(range(0xE00, 0xE80)) + list(range(0x2010, 0x2028)):
        try:
            cat = unicodedata.category(chr(cp))
        except ValueError:
            continue
        if cat in ("Cn", "Cc", "Cf", "Zs", "Zl", "Zp", "Co", "Cs"):
            continue
        cps[cp] = "mark" if cat in ("Mn", "Me") else "base"
    for cp in list(range(0x3000, 0x3100)) + list(range(0x4E00, 0xA000)) + list(range(0xFF01, 0xFF61)):
        cat = unicodedata.category(chr(cp))
        if cat in ("Cn", "Zs"):
            continue
        cps[cp] = "mark" if cat in ("Mn", "Me") else "cjk"
    cps[0x20] = "space"
    cps[0xA0] = "space"
    cps[0x3000] = "space"
    return cps


def main(out):
    order = list(GLYPHS)
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(ranges())
    glyphs = {n: (rect(*g[1]) if g[1] else empty()) for n, g in GLYPHS.items()}
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (g[0], g[1][0] if g[1] else 0) for n, g in GLYPHS.items()})
    fb.setupHorizontalHeader(ascent=900, descent=-200)
    fb.setupNameTable({"familyName": "HFS Test Blocks", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-200, sTypoLineGap=0, usWinAscent=900, usWinDescent=200, sxHeight=500, sCapHeight=700)
    fb.setupFvar(
        axes=[("wght", 100, 400, 900, "Weight"), ("wdth", 50, 100, 200, "Width")],
        instances=[{"location": {"wght": 400, "wdth": 100}, "stylename": "Regular"}],
    )
    variations = {}
    for n, g in GLYPHS.items():
        if not g[1]:
            continue
        x0, y0, x1, y1 = g[1]

        def deltas(r):
            a0, b0, a1, b1 = r
            pts = [(a0, b0), (a0, b1), (a1, b1), (a1, b0)]
            base = [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]
            return [(p[0] - q[0], p[1] - q[1]) for p, q in zip(pts, base)] + [(0, 0)] * 4

        variations[n] = [
            TupleVariation({"wght": (0, 1.0, 1.0)}, deltas(g[2])),
            TupleVariation({"wght": (-1.0, -1.0, 0)}, deltas(g[3])),
        ]
    fb.setupGvar(variations)
    fb.setupPost()
    fb.save(out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "hfs-test-blocks.ttf"))
