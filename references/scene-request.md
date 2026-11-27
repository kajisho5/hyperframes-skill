# Scene request: the optional motion keys

`SKILL.md` has the core of a `scene_version: 1` request. This file has the optional keys added since, with the rules `scene` enforces. Every value comes from the request; nothing here is chosen for you. A key that is not described is refused.

## Kinetic type (text layers)

A text layer's `transition_in` / `transition_out` may reveal the text unit by unit:

```json
{"type": "chars", "duration": 0.12, "stagger": 0.04, "easing": "ease_out", "effect": "slide", "direction": "down", "distance": 24}
```

- `type`: `chars` (extended grapheme clusters, Unicode UAX #29: é, 👨‍👩‍👧, 🇯🇵, क्षि, ก้ each move whole), `words` (the segmenter for the scene's `lang`, dictionary words for Japanese, Chinese and Thai; punctuation goes with its word) or `lines` (the text's own `\n` lines; where the browser wraps is not known in advance).
- `duration`: each unit's own animation (s). `stagger`: from one unit's start to the next one's (s, 0 allowed). `easing` as for the other transitions.
- `effect`: `fade` (default), `slide` with `direction` (`left|right|up|down`, the side each unit enters from / leaves towards) and `distance` (px), `zoom` with `scale` (the scale each unit starts from / ends at).
- The span is `duration + stagger x (units - 1)`. It must fit the layer, the in and out spans together too. `scene` reports every unit transition in `text_units` (`layer`, `edge`, `type`, `units`, `duration`, `stagger`, `span`).
- Whitespace is never a unit. In and out of one layer use the same unit type.
- `chars` on Arabic or another joined script draws each letter in its isolated form. Use `words` there.

## Wipe (any layer)

`{"type": "wipe", "duration": 0.5, "direction": "right", "easing": "ease_in_out"}`: a mask whose edge travels towards `direction`. In, the layer is uncovered from the opposite side; out, it is covered towards `direction`.

## Keyframes (text layers)

```json
"keyframes": {
  "tracking": [{"t": 0, "value": 0}, {"t": 2, "value": 12}],
  "scale": [{"t": 0, "value": 1}, {"t": 2, "value": 1.2}],
  "font_variation": {"wght": [{"t": 0, "value": 300}, {"t": 2, "value": 800}]}
}
```

- `t` is seconds from the layer's start, strictly increasing, within the layer. Values are linear between stops and held before the first and after the last.
- `tracking` is letter-spacing in px (-1000..1000). `scale` is > 0 and <= 100. It cannot be combined with a `pulse` loop animation.
- `font_variation` animates variable-font axes (`{AXIS: [{t, value}]}`, a four-character tag). The first family of the layer's `font_family` must be shipped in the request's `fonts`: the axes are read from that file. An axis the font does not have is refused with its real axes listed (for example `wght 100..900 (default 400), wdth 50..200 (default 100)`), and so is a value outside an axis.
- In a scene with `segments`, a track must hold one value through the loop segment.

## Typesetting (text layers)

- `lang` on the layer (BCP 47, default the scene's `lang`). The direction follows it: `ar`, `he`, `fa`, `ur` and the other right-to-left languages run right to left. `style.direction` (`auto`, `ltr`, `rtl`) states it. `style.align` also takes `start` and `end`, which follow the direction.
- `style.line_break`: `normal` (the browser's Unicode line breaking, UAX #14, with its rules for the language), `strict` (strict kinsoku: no small kana or prolonged sound mark at the start of a line) or `loose`.
- `style.phrases: true` breaks Japanese, Chinese (`zh`, `zh-Hant` / `zh-TW` / `zh-HK`) and Thai only between phrases found by BudouX, which runs locally. Other languages are refused. It cannot be combined with a unit transition.
- Regional profiles (opt-in, never the default):
  - `style.writing_mode: "vertical"` writes top to bottom, columns from the right. `align` then places the text along the column (`left` is the top), and `valign` places the columns (`top` is the right).
  - `style.ruby: true` reads `{base|reading}` in the text as ruby: `{東京|とうきょう}`. A `{`, `}` or `|` outside a complete group is refused. `title.json` text leaves the readings out.

## Fit

```json
"fit": {"mode": "shrink", "min_font_size": 24}
```

- `scene` lays the text out in headless Chromium (the one the render uses) and takes the largest whole font size, from `style.font_size` down to `min_font_size`, at which the text fits its box. The size is written into the HTML, and the result's `text_fit` gives `font_size`, `given_font_size`, `shrunk`, `lines` (the measured line breaks) and `overflow_px` (0).
- A text that does not fit at `min_font_size` is an input error that gives the overflow in pixels and the lines (`details.text_fit`), and no scene is written. Text is never cut or ellipsised: in a fitted layer a word longer than the line is not broken anywhere, and it counts as overflow.
- The first family of `font_family` must be shipped in `fonts` (or with `--font`), so the size measured is the size rendered. Tracking and `font_variation` keyframes cannot be combined with fit.
- `template --fit` / `batch --fit` (with `--font` or a kit's `font_file`) fit every caller text of a title template and of the logo reveal, down to the template's own minimum.
- Title material: `title.json` `text[]` carries each layer's `lang`, the `font_size` used and, for a fitted layer, the text with its measured breaks (`\n`).
