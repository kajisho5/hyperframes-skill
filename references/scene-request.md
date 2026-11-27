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
