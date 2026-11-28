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
- `font_variation` animates variable-font axes (`{AXIS: [{t, value}]}`, a four-character tag). The first family of the layer's `font_family` must be shipped in the request's `fonts`: the axes are read from that file. When the family has several files, the axes are read from the face the layer uses, as CSS picks it: a normal face, else an italic one, and of those the weight nearest `font_weight`. An axis the font does not have is refused with its real axes listed (for example `wght 100..900 (default 400), wdth 50..200 (default 100)`), and so is a value outside an axis.
- In a scene with `segments`, a track must hold one value through the loop segment.

## Typesetting (text layers)

- `lang` on the layer (BCP 47, default the scene's `lang`; extension and private-use subtags such as `de-DE-u-co-phonebk` or `en-US-x-twain` are accepted). The direction follows it: `ar`, `he`, `fa`, `ur` and the other right-to-left languages run right to left. `style.direction` (`auto`, `ltr`, `rtl`) states it. `style.align` also takes `start` and `end`, which follow the direction.
- `style.line_break`: `normal` (the browser's Unicode line breaking, UAX #14, with its rules for the language), `strict` (strict kinsoku: no small kana or prolonged sound mark at the start of a line) or `loose`.
- `style.phrases: true` breaks Japanese, Chinese (`zh`, `zh-Hant` / `zh-TW` / `zh-HK`) and Thai only between phrases found by BudouX, which runs locally. A phrase longer than the line is kept whole and runs past the box, so give such a layer a box that holds its longest phrase, or use `fit`. Other languages are refused. It cannot be combined with a unit transition.
- Regional profiles (opt-in, never the default):
  - `style.writing_mode: "vertical"` writes top to bottom, columns from the right. A layer whose direction resolves to right to left (stated, or from an `ar` / `he` / ... `lang`) is refused; set `style.direction: "ltr"`. `align` then places the text along the column (`left` is the top), and `valign` places the columns (`top` is the right).
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

## Shape layers

```json
{"type": "shape", "id": "badge", "start": 0, "duration": 3, "box": {"x": 80, "y": 80, "width": 240, "height": 120},
 "shape": "rounded_rect", "radius": 24,
 "fill": {"type": "linear", "angle": 90, "stops": [{"offset": 0, "color": "#ff0066"}, {"offset": 1, "color": "#3300ff"}]},
 "stroke": {"color": "#ffffff", "width": 4}, "rotation": 0,
 "keyframes": {"position": [{"t": 0, "value": [-200, 0]}, {"t": 0.6, "value": [0, 0]}], "opacity": [{"t": 0, "value": 0}, {"t": 0.3, "value": 1}]}}
```

- `shape`: `rect`, `rounded_rect` (needs `radius`, px), `circle` (the ellipse of the box), `line` (`points: [[x1, y1], [x2, y2]]`, needs `stroke`), `polygon` (`points: [[x, y], ...]`, 3..64, or `sides` for a regular polygon in the box). Points are pixels from the box's top left.
- `fill`: a colour, or `{"type": "linear", "angle": deg, "stops": [...]}` (0 is left to right, 90 is top to bottom) or `{"type": "radial", "stops": [...]}`; stops are `{offset 0..1, color}`. `stroke`: `{color, width}`. The stroke stays inside the box. `rotation`: degrees, clockwise.
- `keyframes`: `position` (`[dx, dy]` px from the box's place), `scale`, `rotation` (degrees), `opacity` (0..1); `t` from the layer's start, linear, held outside the stops. They compose with the layer's transitions and loop animation.

## Pattern layers

```json
{"type": "pattern", "id": "bg", "start": 0, "duration": 4, "pattern": "rings", "seed": 7, "speed": 0.5,
 "palette": ["#ffffff", "#ff3366"], "params": {"count": 8, "line_width": 3}}
```

- `pattern` and its `params` (all optional, with defaults):
  - `grid`: `count`, `line_width`. Lines shift diagonally.
  - `lines`: `count`, `line_width`, `angle`. Stripes shift across.
  - `dots`: `count`, `size`. Each dot pulses in opacity.
  - `rings`: `count`, `line_width`. Concentric rings grow outward.
  - `polygons`: `count`, `size`, `sides`. Each polygon morphs.
- `seed` (integer) decides the colours, the phases and, for polygons, the places and shapes. The same seed draws the same picture; another seed changes nothing else.
- `speed` is cycles per second (0 is still). A cycle ends on the picture it started with, so inside a seamless loop segment the cycle (1 / speed) must divide the loop.
- `palette`: 1..8 colours. There is no raw CSS.

## Generative layers

```json
{"type": "generative", "id": "fx", "start": 0, "duration": 4, "program": "particles", "seed": 11,
 "palette": ["#ffffff", "#ff66cc"], "params": {"count": 600, "size": 3, "speed": 1, "depth": 1}, "time_start": 0}
```

- `program` and its `params` (all optional, with defaults):
  - `particles`: `count` (1..20000), `size` (px), `speed`, `depth` (0 flat .. 1).
  - `noise_field`: `scale`, `speed`, `octaves` (1..8). Needs 2+ palette colours, mapped low to high.
  - `shader_gradient`: `speed`, `softness`. Needs 2+ colours, one moving blob each.
  - `type3d`: `depth` (em), `spin` (turns per second), `tilt` (radians). It also needs `text` (up to 100 characters) and `font` (a family shipped in `fonts`); the text's outlines are extruded.
  - `shader`: `src` is a local `.frag` / `.glsl` / `.fs` file, up to 64 KB, with `void main()`, writing `gl_FragColor`. It gets the uniforms `u_time` (s), `u_resolution` (px) and `u_seed`. It must be one self-contained file: no `#include` or `#extension`, and no word for script, network or DOM access (`fetch`, `document`, `window`, ...).
- `seed` is an integer, `palette` up to 8 colours, and `time_start` is the program's time at the layer's first frame (s).
- The program's time is the frame's own time, so frame N is the same whether or not frames 0..N-1 were rendered. three.js is copied into the scene, and rendering is on SwiftShader. `doctor`'s `webgl` names the backend.
- A generative layer cannot run through a seamless loop segment.

## Audio layers

`{"type": "audio", "id": "music", "start": 0, "duration": 15, "src": "music.wav", "media_start": 0, "volume": 1, "fade_in": 0.5, "fade_out": 1}`

- `src`: a local `.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus` or `.flac`. `volume` is a gain, 0..3.98 (1 is 0 dB). The fades are in seconds. There is no `box`.
- The output carries the sound: AAC in .mp4 and .mov, Opus in .webm. `render` verifies an `audio` step (a stream as long as the scene, within one frame). A PNG sequence cannot carry sound and is refused. An audio layer cannot play through a seamless loop segment.

## Beat lock

`"beat": {"bpm": 120, "offset": 0, "division": 1, "snap": "starts_and_staggers"}` or `"beat": {"grid": "beats.json"}`

- Every visual layer's `start` moves to the nearest beat, rounded to a frame, and its end stays where it was (its duration changes). A unit transition's `stagger` becomes a whole number of beats (at least one) when the beats are evenly spaced. `snap: "starts"` leaves staggers alone. Audio layers never move.
- `division` subdivides the beat (2: eighths at a quarter-note BPM). `offset` is the first beat with `bpm`.
- `grid` reads ffmpeg-skill `scenes --beats --json` (its `beat_grid.supported_beats`, the beats a measured onset supports), sound-design-skill's `<name>.beats.json` or `tempo_map`, or a JSON array of seconds.
- `scene` reports `beat_lock` with every `given` and `snapped` start, the beat it went to, and the staggers. A layer whose start would reach its end is refused.

## Style presets (templates)

`template --list` shows them. Each one is a template whose values are typed:

- `title` and `subtitle`;
- the colours `background`, `primary`, `secondary`, `accent` and `text_color` (each preset uses the ones it lists), which `--kit` fills from the same kit roles;
- `bpm` (beat lock; the words step one beat apart);
- `aspect`: `landscape` 1920x1080, `portrait` 1080x1920 or `square` 1080x1080.

`style-corporate` also takes an optional `logo`. `style-wafu` is Japanese (`lang: ja`, vertical title); pass `--font` with a Japanese font for Japanese glyph forms.

`template --gallery -o DIR [--set ...] [--kit KIT] [--font FILE]` renders `DIR/<preset>.png` for every preset, at the preset's own still time, through the same scene and render path as a full render. Choose one, then `template style-NAME ... -o REQUEST.json` as usual.
