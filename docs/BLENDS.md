# Blend modes and clip transitions

The catalog follows the supplied Resolume 4 manual, pages 9–11, in [manual-layout.txt](manual-layout.txt). `normal` remains the saved identifier for **Alpha**. The 38 modes described in the manual and the preexisting **Overlay** identifier are supported. Names entered with spaces, punctuation, or the manual's capitalization normalize to their saved identifiers.

Layer blending uses the accumulated lower layers as its input. Clip transitions use the outgoing and incoming clips before the layer's effects, mask, transform, and composition blend. Their progress runs from 0 to 1; every supported clip transition returns the outgoing image exactly at 0 and the incoming image exactly at 1. Existing per-clip opacity and premultiplied transparency remain part of those images.

The manual explicitly describes a combined result at 50% for Add, Darken, Difference, Lighten, and Subtract; Difference I follows Difference. These layer modes interpolate input → combined result → incoming layer as opacity runs from 0 → 0.5 → 1. In contrast, 50 Add and 50 Lighten retain the combined result at full opacity. Selecting `add` therefore has the manual's behavior; select `50-add` for the earlier build's additive-at-full-opacity behavior.

The manual gives no exact transfer curve for Burn, Dodge, HardLight, Multiply, Screen, or SoftLight. For these modes and legacy Overlay, layer opacity controls the strength of a conventional color blend. Clip transitions apply the full color operator at the midpoint, then finish on the incoming clip. Color Burn, Color Dodge, Hard Light, Soft Light, Multiply, Screen, and Overlay use the channel formulas in [W3C Compositing and Blending, separable blend modes](https://www.w3.org/TR/compositing-1/#blendingseparable). Calculations use normalized image RGB without an additional linear-light conversion.

## Catalog

| Name | Identifier | Implemented behavior |
| --- | --- | --- |
| 50 Add | `50-add` | Add channels with saturation at white; full opacity retains both images. |
| 50 Lighten | `50-lighten` | Channel-wise maximum; full opacity retains the brighter components of both images. |
| Add | `add` | Channel addition at the midpoint, then the incoming layer at full opacity. |
| Alpha | `normal` | Ordinary source-over layer opacity; linear premultiplied crossfade between clips. |
| Burn | `burn` | Color Burn with defined black/white division endpoints. |
| Cube | `cube` | Ray-intersect a cube rotating through 90 degrees; outgoing video occupies its front face and incoming video occupies the next face. |
| Darken | `darken` | Channel-wise minimum at the midpoint. |
| Difference | `difference` | Absolute channel difference at the midpoint. |
| Difference I | `difference-invert` | Inverted absolute channel difference at the midpoint. |
| Displace | `displace` | Incoming luminance shifts the sampled input horizontally and vertically, producing glass-like distortion. Layer opacity controls displacement strength; a clip transition also resolves into the incoming clip. |
| Dodge | `dodge` | Color Dodge with defined black/white division endpoints. |
| HardLight | `hard-light` | Multiply/screen combination selected by the incoming channel's brightness. |
| Lighten | `lighten` | Channel-wise maximum at the midpoint. |
| LoRez | `lorez` | Increase sampling blocks toward the midpoint, swap images while pixelated, then restore resolution. |
| Luma is Alpha | `luma-alpha` | Multiply incoming alpha by its luminance; black is transparent and white retains the incoming alpha. |
| Luma Key | `luma-key` | Reveal full-opacity pixels from brightest to darkest as opacity increases. The threshold is `1 − opacity`. |
| Luma Key I | `luma-key-invert` | Reveal full-opacity pixels from darkest to brightest; the threshold is `opacity`. |
| MetaMix | `metamix` | Repeated copies shrink continuously while separate cells collapse into the full-size incoming image. |
| MultiTask | `multitask` | Two perspective panels move past each other with opposing rotations and depth recession. |
| Multiply | `multiply` | Multiply channels; bright high-contrast input can act as a mask. |
| Parts | `parts` | Replace deterministic rectangular chunks in a scattered order. |
| RGB | `rgb` | Replace blue, then green, then red, each during one third of the progress range. |
| Rotate X | `rotate-x` | Flip a perspective panel 180 degrees about its horizontal axis; change images while the panel is edge-on. |
| Rotate Y | `rotate-y` | The corresponding flip about the vertical axis. |
| Screen | `screen` | Complemented multiplication produces a brighter combined image. |
| Shift RGB | `shift-rgb` | Move outgoing color channels off one side and incoming channels in from the other at three different distances. |
| SoftLight | `soft-light` | Soft Light with its piecewise shadow/highlight curve. |
| Static | `static` | Animated scanline displacement, pixel noise, and pixel replacement; degradation peaks near the midpoint. |
| Subtract | `subtract` | At the midpoint subtract the inverse incoming color: `max(input + layer − 1, 0)`. Dark incoming areas darken the input, matching the manual's description. |
| Tile | `tile` | Split into progressively smaller repeated tiles, replace tiles independently, then reassemble the incoming image. |
| TimeSwitcher | `time-switcher` | Switch between complete images at 0.5–20 Hz, controlled by opacity. Opacity zero bypasses the layer. A clip transition also guarantees its initial and final image. |
| Wipe Down | `wipe-down` | Translate the input down while the incoming image pushes in from above. |
| Wipe Ellipse | `wipe-ellipse` | Reveal through an expanding, pixel-aspect-correct circle with a one-pixel edge. |
| Wipe Left | `wipe-left` | Push the input left; incoming image enters from the right. |
| Wipe Right | `wipe-right` | Push the input right; incoming image enters from the left. |
| Wipe Up | `wipe-up` | Push the input up; incoming image enters from below. |
| Zoom In | `zoom-in` | Enlarge the input toward the midpoint, change images while enlarged, then reduce the incoming image to its normal size. |
| Zoom Out | `zoom-out` | Shrink the input toward the midpoint, change images while small, then enlarge the incoming image to its normal size. |
| Overlay (legacy) | `overlay` | Multiply/screen combination selected by the input channel's brightness. Retained for existing compositions. |

## Defined implementation choices and limits

These are functional implementations of the manual's descriptions. The PDF does not supply the original shader source, exact animation curves, random seeds, tile counts, displacement amplitude, camera projection, or switching-frequency range. Those details are explicit choices in `src/blends.js`; pixel-identical compatibility with Resolume 4 has not been established. In particular, the manual does not specify the luma-key threshold direction or a mathematical formula for Subtract, so the directions and formula above state the chosen interpretation.

Luminance uses RGB weights 0.2126, 0.7152, and 0.0722. Spatial sampling outside a moving panel is transparent; during a clip transition, the composition underneath can show through. Applying a spatial blend to a layer also moves the accumulated input itself. Displace clamps its displaced input coordinates at the edge. Cube, panel rotations, and MultiTask use perspective rays. Static uses the rendering clock; Parts and tile ordering stay deterministic for the same progress.

**50 Mask remains unresolved.** Page 11 excludes it from transitions, but neither page 9 nor page 10 defines its operation. It appears as unsupported metadata and is absent from the usable mode lists. No unrelated mask operation is labeled “50 Mask.” A description or reference behavior is needed before implementing that name.

50 Add and 50 Lighten are available only for layers, as specified by page 11. Transition Random selects one supported transition per actual clip activation in the transport and retains it for that transition.

`tests/blends.webgl.test.mjs` exercises the real LiveEngine with headless GPU rendering, comparing known color values, endpoints, pushed-image geometry, luminance keys, temporal switching, and full-catalog image signatures. It does not compile a separate test-only copy of the shader.
