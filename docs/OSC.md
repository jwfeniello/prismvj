# OSC input compatibility

The address reference is the supplied Resolume 4 manual, PDF pages 43–48, extracted in [manual-layout.txt](manual-layout.txt). `src/controls.js` dispatches decoded OSC messages; the desktop host owns UDP input. This is an implemented subset of the reference, not full Resolume protocol compatibility.

Addresses and indices are case sensitive. Layers and clip slots are numbered from **1**; layer 1 is the bottom layer. Clip slots and tracks refer to the currently selected deck. Selecting a different deck does not stop clips already playing.

## Implemented addresses

`N` is a layer number, `M` a clip or track number, and `K` an effect number. All event payloads below are integers. Normalized parameter values are floats; integer numeric values are also accepted. Toggle values must be exactly 0 or 1.

| Address | Payload and behavior |
| --- | --- |
| `/composition/bypassed` | 0/1; bypasses composition audio and video without stopping transport or changing individual layer bypass settings. |
| `/composition/disconnectall` | 1; clears all layers and queued transport triggers. |
| `/trackM/connect` | 1; triggers occupied slots in column M. Empty columns are ignored. |
| `/layerN/name` | String, up to 256 characters. |
| `/layerN/select` | 1; selects the layer through the host callback. |
| `/layerN/clear` | 1; clears this layer. A release value of 0 has no effect. |
| `/layerN/bypassed`, `/layerN/solo` | 0/1; sets the corresponding state. |
| `/layerN/group` | 0 = unassigned, 1 = A, 2 = B. |
| `/layerN/moveup`, `/layerN/movedown` | 1; moves the layer one position in the stack. A move beyond an end has no effect. |
| `/layerN/clipM/name` | String, up to 256 characters. |
| `/layerN/clipM/preview` | 1; asks the host to select and preview this clip independently of program playback. |
| `/layerN/clipM/connect` | 1 presses the clip trigger; 0 releases it. Release stops piano clips and preserves normal clip playback. |
| `S/video/effectK/bypassed` | 0 enables and 1 bypasses the existing video effect at position K. `S` is `/composition`, `/layerN`, or `/layerN/clipM`. |

The manual lists clip connect values 0 and 1 but does not further describe release behavior in its OSC table. The press/release implementation follows the clip's normal/piano trigger setting; comparison against an original Resolume 4 instance remains unverified.

## Parameter values and units

Append `/values` to the parameter paths below and send one normalized value in 0..1. Finite values outside that interval are clamped. The tables in the manual define different volume units at different scopes; this is reflected in the conversions.

| Parameter path | Normalized 0..1 mapping |
| --- | --- |
| `/composition/audio/volume` | -40..+12 dB, converted to linear amplitude `10 ** (dB / 20)`. 0 is gain 0.01; `40/52` is unity; 1 is gain about 3.981. |
| `/layerN/audio/volume` | Linear gain 0..1, as listed on manual page 45. |
| `/layerN/clipM/audio/volume` | -40..+12 dB, like composition volume. |
| `S/audio/pan` | -1 left .. +1 right; 0.5 is center. Available at all three scopes. |
| `/composition/video/fadeout` | Composition video opacity 0..1. |
| `/layerN/video/opacity`, `/layerN/clipM/video/opacity` | Opacity 0..1. |
| `S/video/scale` | 0..1000 percent, stored as 0..10 times original size. Normalized 0.1 is original size. |
| `S/video/rotatex`, `S/video/rotatey`, `S/video/rotatez` | -180..180 degrees. Normalized 0.5 is no rotation. Available at all three scopes. |
| `/layerN/video/anchorx`, `/layerN/video/anchory`, `/layerN/video/anchorz` and the corresponding `/layerN/clipM/video/...` paths | -2048..2048 pixels. Normalized 0.5 is the default center anchor. Composition anchor addresses are not implemented. |
| `/layerN/clipM/video/width`, `/layerN/clipM/video/height` | 0..4096 pixels. Sets an explicit clip dimension; zero collapses that dimension. |
| `/layerN/video/positionx`, `/layerN/clipM/video/positionx` | -4096..4096 horizontal pixels, converted to the composition's normalized coordinates. |
| `/layerN/video/positiony`, `/layerN/clipM/video/positiony` | -4096..4096 vertical pixels, converted to the composition's normalized coordinates. |
| `/layerN/clipM/audio/position`, `/layerN/clipM/video/position` | Normalized playback position. Both seek every active voice of the addressed source clip, including copies routed to other layers. Queued or inactive clips cannot be sought. |

For the two clip position paths, `/values` also accepts **three floats**: in point, current position, out point. They must be ordered, with in point strictly less than out point. Malformed triples make no changes. Other parameter triples are unsupported until parameter animation ranges are implemented.

`/textvalue` accepts a plain numeric string for each implemented parameter. Prism interprets it in the internal units above: decibels for composition/clip volume, gain for layer volume, signed pan, percent for scale, degrees for rotation, pixels for position X/Y, anchors and dimensions, and **milliseconds** for the playback position. This is Prism's text parsing convention; the manual specifies a string property but does not provide numeric parsing examples. Unit suffixes such as `"0 dB"` are not accepted.

## Clip transport parameter properties

Use either `/layerN/clipM/video/position` or `/layerN/clipM/audio/position` as the prefix.

| Suffix | Payload |
| --- | --- |
| `/direction` | Integer 0 reverse, 1 forward, 2 pause, 3 random. Random direction is retained independently of the selected loop mode. |
| `/speed` | Float 0..1. Prism currently uses this directly as the timeline speed multiplier. The reference specifies the normalized range but not its physical speed curve; matching that curve requires an original application fixture. BPM clips continue to derive speed from tempo and beat count. |
| `/playmode` | Integer 0 once and hold, 1 loop, 2 ping-pong. The supplied OSC table does not assign a value to once-and-clear, so none is invented. |
| `/playmodeaway` | Integer 0 restart from in point, 1 continue from remembered position. |

Example decoded messages:

```js
{ address: '/track3/connect', args: [1] }
{ address: '/composition/audio/volume/values', args: [40 / 52] }
{ address: '/layer1/video/opacity/values', args: [0.75] }
{ address: '/layer1/clip2/video/position/values', args: [0.2, 0.4, 0.8] }
{ address: '/layer1/clip2/video/position/direction', args: [0] }
```

## Unsupported or unverified functionality

- Parameter animation direction, speed, play modes and range triples on parameters other than clip playback position.
- Audio effect namespaces, effect dry/wet, effect opacity, and effect `paramN`. Current built-ins do not expose the original plugin parameter layouts; mapping arbitrary `param1` to their amount would claim compatibility that has not been established.
- Playback position changes to inactive clips. Such an address is rejected rather than seeking a different active clip on the same layer. Other supported clip properties can be configured while inactive.
- OSC output, parameter feedback, address overrides, wildcard matching, and modern Resolume address trees. These are separate requirements.
- Exact physical speed curve, zero-edge behavior against an original application, and text parsing compatibility described above remain unverified.

Aliases such as `/composition/opacity`, `/composition/crossfader`, or a parameter path without `/values` are not in the supplied table and are not accepted by this dispatcher.

## Host integration and validation

`applyOSC(context, message)` returns `true` when it accepts a message and `false` for unsupported addresses, missing targets, invalid types, or invalid argument counts. It accepts primitive `args`, typed arguments such as `{type:'f', value:0.5}`, or a single `value` field. It never guesses a numeric value from a string except at `/textvalue`.

The context supplies `project`, `transport`, `triggerClip(layer, clip)`, `triggerColumn(index)` with a zero-based index, `selectLayer(layerId)`, and `selectClip(clipId)`. The last callback must perform independent preview for the OSC preview event. Optional `stopLayer(layerId)` and `releaseClip(layer, clip)` hooks let the host cancel pending asynchronous media loads as well as transport events. If callbacks load media asynchronously, their rejection handling belongs to the host.

Run `node --test tests/controls.test.mjs tests/model.test.mjs` for dispatcher normalization, trigger routing, malformed input, persistence, and transport fixtures. These state tests do not prove physical OSC device behavior or full application compatibility.
