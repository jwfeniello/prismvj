# Resolume 4 functional requirements

Source: user supplied `E:\DOWNLOADS\Resolume-4-Manual-English.pdf`, 70 PDF pages, extracted into `manual.txt` and `manual-layout.txt`. Page numbers below are PDF pages. The objective is a working, stable Windows audiovisual performance application covering the documented Avenue and Arena workflows. This document records the full scope; implementation stages are sequencing, not reductions in the completion criteria.

The original product's brand, registration server, commercial licensing, and promotional website links are not application functionality to reproduce. The clone must have its own identity. The manual explicitly marks Syphon and Quartz Composer as macOS only; they are tracked as platform specific compatibility items rather than claimed Windows functionality. Native plugin, codec, Flash, project import, and hardware compatibility must each have explicit evidence. A similarly named built-in feature does not prove compatibility with the original file or protocol.

Status as of initial audit: requirements derived from the supplied manual; implementation and runtime verification pending. Update evidence in ACCEPTANCE.md as features are verified. Do not infer completion from a requirement appearing in the UI.

## Implementation sequence

| Stage | Deliverable | Completion dependency |
| --- | --- | --- |
| S0 | Installable or self-contained Windows launch, saved composition schema, real rendering/audio clock, local demo | Foundation for subsequent stages |
| S1 | Complete everyday performance loop: import, decks, layers, transport, mixing, effects, preview, output, persistence, recording | Real media and output evidence |
| S2 | Parameter modulation, autopilot, dashboard, keyboard/MIDI/OSC mapping, preferences | Deterministic timing and protocol fixtures |
| S3 | Arena output mapping, warps, masks/crops, blending, DMX, SMPTE | Render fixtures plus real device validation |
| S4 | Full built-in effects and blend catalog, native FFGL/VST, legacy format/codec/project compatibility | Individual compatibility evidence |
| S5 | Soak, recovery, performance, packaging and operator documentation | All applicable rows below verified; no hidden unsupported features |

## Composition, decks and layers

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| C01 | 3, 6, 68 | Launch with a usable demo composition. Save/load compositions including decks, media references, effects, settings, control mappings and output setup references. | S0 |
| C02 | 6 | Composition name, description and editable output resolution; processing uses that resolution. | S1 |
| C03 | 6 | Import Resolume 3 compositions. Preserve documented data or identify individual unsupported fields; format compatibility requires fixture evidence. | S4 |
| C04 | 6, 8 | Named decks; create at end, insert before selection, rename; deck switching does not interrupt already playing clips or reset their transport/effects. | S1 |
| C05 | 8 | Add layer at top or insert below selection, select, rename, rearrange up/down; layer count is dynamic within available resources. | S1 |
| C06 | 6, 8 | One active normal clip per layer. Clear stops it, bypass temporarily hides it, solo shows selected solo layers. Selection changes inspector/preview independently of triggering. | S1 |
| C07 | 7 | Composition clear-all, bypass-all and master video blackout. Global audio volume and pan. | S1 |
| C08 | 7, 10 | Global timeline speed and direction controls; direction may be pinned for future triggers. Global speed does not affect BPM-synced clips. Layer transport can be shown and operated without changing selected clip. | S1 |
| C09 | 6, 24, 60 | Sliders permit direct drag, numeric entry and reset to default. Optional automatic clip-inspector selection on trigger; audio controls and layer transport/transition controls can be shown/hidden. | S1 |

## Media and clip management

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| M01 | 13, 59–60 | Import real video, still images, audio and audiovisual files through OS drag/drop and built-in file browser. Maintain alpha. Support and document actual formats, including DXV compatibility as a separately verified item. | S1/S4 |
| M02 | 13 | File browser supports folders/root drives, A/B locations, thumbnails on/off, type-to-find, double-click preview. | S1 |
| M03 | 13, 59 | Combine separate audio and video into a clip; video duration conforms to audio for seamless AV loops. Audio alone remains a valid clip. Shift-drag merges existing audio/video clips. | S1 |
| M04 | 13, 19 | Drag by clip label to move; occupied slots swap; Ctrl-drop copies. Cut/copy/paste across decks and shift multi-select. Multiple selected clips can share property/menu edits. Reveal source in Explorer. | S1 |
| M05 | 14 | Missing-media detection with explicit affected paths; reconnect one file or all other missing files discovered in the selected location. | S1 |
| M06 | 18 | Remove a clip's video while retaining audio. Per-clip RGB toggles and alpha toggle only when alpha exists. Fit to width, fit to height, stretch to composition, and original size. | S1 |
| M07 | 23 | Generated source clips; editable source parameters, normal clip effects and transport/sequence duration (default 5 seconds). | S1 |
| M08 | 23 | Enumerate/capture live cameras; deinterlace option; source duration for autopilot; device loss is reported and recoverable. | S3 |
| M09 | 27 | Configurable defaults for future audio/video imports, without modifying existing clips. | S2 |

## Triggering and transport

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| T01 | 4, 15 | Click thumbnail to trigger, separate name selection, column trigger starts participating clips together. Arrow left/right triggers adjacent clips; Shift-arrows select; Enter triggers selection. | S1 |
| T02 | 15 | Beat snap: immediate, beat, bar and multibar quantization; composition default plus per-clip override/inherit. Pending trigger indicator and deterministic common boundary. | S1 |
| T03 | 15 | Normal and piano trigger style at composition/clip scope; piano releases the triggered voice on mouse/key/MIDI release. | S1 |
| T04 | 15, 60 | Trigger into own, selected or next free layer; composition default and clip override. Free-layer piano permits simultaneous held clips. | S1 |
| T05 | 15 | Ignore-column setting on clip or layer preserves playing content when another column is triggered. | S1 |
| T06 | 16 | Timeline mode speed; BPM mode derives playback speed from global BPM and clip beat count. Set beats manually, double/halve, source BPM or automatic beat estimate. | S1 |
| T07 | 16 | Global BPM numeric input, increment/decrement, tap tempo, beat/bar visual indicator and resync; retrigger after scratching realigns at next snap boundary. | S1 |
| T08 | 16 | Forward, reverse, pause, random. Timeline random speed controls frame jump frequency. BPM random jumps to random beat and continues from there, for audio and video. | S1 |
| T09 | 16–17 | Loop, ping-pong, once-and-clear and once-and-hold. Timeline trigger can restart from in-point or resume last position. | S1 |
| T10 | 17 | Scrubbable timeline, editable in/out points, current/remaining time display; layer playhead scroll scratching. | S1 |
| T11 | 17, 69–70 | BPM BeatLoopr sections including 4, 2, 1, 1/2, 1/4 beats; toggle/off; six editable cue points. Cue jumps disable BeatLoopr. | S1 |
| T12 | 33 | Layer autopilot next/previous/random skips empty slots; per-clip override can continue, stop, or loop a sequence. Sources/effect clips use configured durations. | S2 |
| T13 | 33 | Autopilot respects destination beat snap, looping current clip until the boundary; stays in its sequence layer even when a clip has alternate trigger target. | S2 |

## Audio, mixing and render graph

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| R01 | 4, 9, 12, 17 | Real audible audio mixing with independent clip/layer/composition volume and pan; layer A, V and linked AV controls. Multiplicative gain hierarchy and no UI-only audio controls. | S1 |
| R02 | 9 | Composite bottom layer over black, then upward in stack order with each layer's opacity and selected blend operation. Three favorite blend selectors per layer. | S1 |
| R03 | 9–11 | Implement every blend in the catalog below, including the distinct 50 Add/50 Lighten versus Add/Lighten behaviors. | S1/S4 |
| R04 | 11 | Automatic layer transition 0–10 seconds blends old/new clips using catalog transition modes, with random option. 50 Add, 50 Lighten, 50 Mask are excluded from transitions. | S1 |
| R05 | 11 | A/B assignment per layer; crossfader modulates each assigned layer's existing volume/opacity maximum. Unassigned layers unaffected. Clicking endpoint A/B animates over 2 seconds. | S1 |
| R06 | 7, 12, 18 | Transform controls: composition scale and XYZ rotation; layer/clip scale, XY position, XYZ rotation, XYZ anchor; layer optional width/height and clip width/height. Preserve correct center/anchor behavior. | S1 |
| R07 | 7, 12, 20 | Image masks at clip/layer/composition scopes with bypass/remove/invert. PNG alpha supplies mask when present; other images use red channel. | S1 |
| R08 | 6, 19, 21 | Ordered effect stacks at clip → layer → composition. Bypass/remove/reorder each effect. Reorder transforms, masks and effects; default effects/mask precede transforms. | S1 |
| R09 | 20 | Effect clip samples composited lower layers, then applies its effects/transform; it remains a lower-layer copy after deleting the effect. Trigger, transition, duration and autopilot work for effect clips. | S2 |
| R10 | 22 | Every video effect has opacity and blend mode; every audio effect has dry/wet. Save, update, rename, delete and reset effect presets; browser exposes presets under parent effect. | S2 |
| R11 | 19, 23, 25–26 | Host compatible VST audio effects/sources and FreeFrame GL 1.5 GPU effects/sources; configurable scan directories. Native plugin scan failures must not compromise stable launch. | S4 |
| R12 | 61–67 | Implement full included effect catalog below with parameters, live rendering/audio and modulation. | S1/S4 |
| R13 | 26 | Scaling quality: smooth/trilinear and nearest neighbor. Optional disabling of global effects/advanced blends for a basic alpha performance mode. | S2 |

### Blend catalog

Pages 9–10 list: 50 Add, 50 Lighten, Add, Alpha, Burn, Cube, Darken, Difference, Difference I, Displace, Dodge, HardLight, Lighten, LoRez, Luma is Alpha, Luma Key, Luma Key I, MetaMix, MultiTask, Multiply, Parts, RGB, Rotate X, Rotate Y, Screen, Shift RGB, SoftLight, Static, Subtract, Tile, TimeSwitcher, Wipe Down, Wipe Ellipse, Wipe Left, Wipe Right, Wipe Up, Zoom In, Zoom Out. Page 11 also names 50 Mask as excluded from transitions; its behavior is not defined by the supplied text and needs a reference fixture or explicit unresolved compatibility entry.

Nonlinear modes generally show input at 0, combined imagery at 0.5 and the new layer at 1; implement individual semantics rather than assuming all modes are ordinary alpha overlays. Luma Key uses opacity as a threshold, Luma is Alpha derives transparency from brightness, and TimeSwitcher controls switching frequency. Effects described as spatial transitions must visibly move/transform pixels.

### Included effects catalog

| Pages | Audio effects |
| --- | --- |
| 61 | Bitcrusher; Distortion; EQ-3; Flanger; High-Pass; Low-Pass |

| Pages | Video effects |
| --- | --- |
| 62 | AddSubtract; Auto Mask; Bendoscope; Blow; Blur; Bright Contrast; ChromaKey; Circles; Colorize; Colour pass; Cube Tiles; Delay RGB |
| 63 | Displace; Distortion; Drop Shadow; Edge Detection; Exposure; Fish Eye; Flip; Fragment; Freeze; Goo; Heat |
| 64 | Hue Rotate; Invert RGB; Iterate; Kaleidoscope; Keystone; Keystone Crop; Keystone Mask; Levels; LoRez; Luma Waves; Mirror; Particles; Pixel High Pass |
| 65 | Pixels In Space; Point Grid; Posterize; Radial Blur; Recolour; Ripples; Saturation; Shift Glitch; Shift RGB; Slide; Snow; Static |
| 66–67 | Stingy Sphere; Stop motion; Stripper; Strobe; Suckr; Threshold; Tile; Trails; Tunnel; Twisted; Videowall; Vignette; Wave Warp |

Temporal effects (Delay RGB, Freeze, Trails, Stop motion) require frame history; 3D effects require the documented spatial behavior. A color filter sharing a name does not satisfy these requirements. Detailed visual descriptions remain in the source manual because many parameter ranges are unspecified.

## Preview, output and recording

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| O01 | 28 | Separate program output window; display enumeration, windowed/fullscreen per display, disable output; preserve control UI on its own display. | S1 |
| O02 | 32 | Independent clip/layer preview without triggering program output. Preview ignores clip/layer volume and opacity; dark/light checkerboard or black transparent background; collapse/expand monitor. | S1 |
| O03 | 25, 32 | Select audio device and master/preview output channels; independently monitor audio with a device that has sufficient channels. Sample rate/buffer size settings and supported ASIO configuration. | S3 |
| O04 | 29 | Advanced output screens mapped to physical displays; one or more slices per screen, precise input rectangles, drag/resize, presets and quick slice creation. Route composition or individual layer directly to each slice. | S3 |
| O05 | 30 | Arena slice warp: movable/addable/removable control points, linear and Bezier interpolation/handles, alignment grid, numeric positioning and keyboard nudge. Whole-slice translation/scale/rotation. Input wrap for panoramas. | S3 |
| O06 | 30 | Reorder/move slices, masks and crops between screens. Display identification and test card on live output. Arbitrary polygon mask/crop point edit, switch mask/crop. Crop retains inside; mask removes inside. | S3 |
| O07 | 31 | Slice black-level compensation, output brightness/contrast. Soft edge blend derives overlaps and exposes power, center luminance and gamma. | S3 |
| O08 | 57 | Record final composition while performing; selectable video/audio/both and output directory. Stop saves playable files and imports first free slot on bottom layer without disturbing live output. | S1 |
| O09 | 57 | Compatible recording outputs: QuickTime Photo JPEG video and PCM WAV audio. If additionally offering modern formats, preserve an explicit compatibility status for originals. Recording queue bounded; overload/disk-full ends recording safely and flushes accepted frames. | S1/S4 |

## Parameter automation and input

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| A01 | 34 | Parameters support timeline animation with range, speed, direction, loop/ping-pong/once; clip-position following; BPM-synced animation with beat duration; clip/composition beat pulse/decay with inversion. Easing applies across animation modes. | S2 |
| A02 | 35 | Separate composition/layer/clip dashboards, eight named knobs each. Multiple parameter links per knob, each with range/inversion; drag parameter name to link or choose from menu. | S2 |
| A03 | 25, 36 | Audio FFT from external input, composition and own clip. Low/mid/high or selectable frequency range, spectrum, gain, fall/decay; direct/inverted amplitude or forward/backward rate control. | S2 |
| A04 | 37–38 | Keyboard maps: application versus composition persistence; application layer-relative/deck-absolute focus; clip-tab controls always selected-clip relative. Learn overlay, remove/edit mapping, Escape exits. | S2 |
| A05 | 37 | Button click, toggle/piano and mouse-driven mapping; numeric min/max, toggle/piano and mouse position modes. Do not trigger show shortcuts while typing text. | S2 |
| A06 | 69–70 | Default keys: F1–F3 layer selection; 1–0 clips; Shift+1–0 columns; i/o in/out; comma reverse, period forward, slash pause; z/x/c/v/b/n loop off/4/2/1/0.5/0.25; Shift+QWERTY cue set, QWERTY cue jump; Shift+F maximize, s scale by mouse, p position by mouse. | S1/S2 |
| A07 | 27, 38–39 | Enable MIDI inputs/outputs; map learn and manual assignment; application/composition and focus rules match keyboard. Notes/velocity/piano; CC absolute/relative/endless/invert; input and output ranges; hardware feedback mirrors UI changes. Save/load MIDI maps. | S2 |
| A08 | 39 | MIDI clock receive: disabled, start/stop, switch to manual on stop. Stable tempo from clock and deterministic transport response. Original manual specifies receiving rather than sending MIDI clock. | S2 |
| A09 | 27, 42–48 | OSC UDP input/output enable, listening/output ports and destination address. Support exact documented address tree, strings/events/toggles/parameters, normalized ranges and parameter animation properties. OSC inspector exposes input/output address; output address override and feedback. | S2 |
| A10 | 40–42 | Arena DMX input from ENTTEC USB Pro and Art-Net; device selection, node name, subnet/port, automatic stable mapping, composition learn/manual mapping, channel offset. | S3 |
| A11 | 42 | Arena SMPTE input device/channel and frame rate, displayed timecode, transport mode per active clip, clip starting offset and input delay compensation. Timecode never triggers inactive clips. | S3 |

OSC minimum compatibility paths (pp. 43–48): `/composition`, `/layerN`, `/trackN/connect`, `/layerN/clipN`, and scoped `/audio/effectN` or `/video/effectN`. Parameters expose `values` (one value or in/current/out triple), `textvalue`, `direction` (reverse=0, forward=1, pause=2, random=3), `speed`, `playmode` (once=0, loop=1, bounce=2), `playmodeaway` (rewind=0, continue=1). Composition supports bypass/disconnectall, audio volume/pan and video fadeout/scale/XYZ rotation. Layer supports name/select/clear/bypass/solo/group/move, audio volume/pan and video opacity/transforms. Clip supports connect, audio/video positions, volume/pan and video dimensions/opacity/transforms. Effects expose bypass and drywet/opacity/paramN. Consult source tables for each numeric normalization and units. Avoid silently treating normalized OSC volume as a linear gain where the table defines decibels.

The exact DMX Auto Map channel table is referenced in an additional PDF on page 41 but not embedded in this manual. Obtaining or independently verifying that table is a compatibility dependency; invented channel assignments do not satisfy it.

## Legacy content and application operation

| ID | Pages | Requirement and behavior | Stage |
| --- | --- | --- | --- |
| L01 | 49–55 | Flash SWF AS2/AS3 playback; legacy `rtext`; resolumeCom float/string/boolean/event parameter bridge, live updates and animated multiline text. Raster size/quality/duration settings. Timeline/BPM/autonomous modes, autonomous default for <=3 frames. | S4 |
| L02 | 32 | Syphon input/output and advanced-output routing are explicitly macOS only. Record platform applicability; do not display a nonfunctional Windows toggle or claim native compatibility. | Platform-specific |
| L03 | 56 | Quartz Composer imports, published number/boolean/index/string parameters are explicitly macOS only. Preserve platform limitation in support matrix. | Platform-specific |
| P01 | 24 | General preferences: recording path/audio/video selection, clip panel follows trigger, clip start offset ms, Unicode text, quit confirmation. | S2 |
| P02 | 5, 68 | Contextual help, useful error log, predictable locations for preferences, compositions, presets, screen setups, recordings and cached thumbnails. Use clone-owned directories. | S1 |
| P03 | 2–3 | Reproducible Windows launch/install and offline use after install; no dependency on original product activation. User data survives upgrade/relaunch. | S0/S5 |
| P04 | Goal | Stable live show behavior: no unbounded queues, memory leaks or frozen UI; correct disposal of media/GL/audio resources; clear handling of unsupported/corrupt media and disconnected devices. | S0–S5 |
| P05 | Goal | Recoverable persistence: schema validation/migrations, atomic project saves, usable autosave/recovery, no successful-save indication until data is durable. | S0/S5 |
| P06 | Goal | Measured audio/video synchronization and responsiveness on documented hardware/workload; expose actual load/frame rate/drop diagnostics. Fullscreen/display reconnect and GPU/context failure have controlled behavior. | S5 |

## Scope and fidelity audit rules

1. Every row needs implementation evidence and behavior evidence. Tests for state reducers alone do not prove rendered pixels, audible sound, native devices, or saved playable recordings.
2. Features pending hardware must remain unverified until exercised with the relevant device or an authoritative simulator plus a separately documented hardware gap.
3. A deferred stage is incomplete work. Do not mark the full objective achieved while applicable rows remain unsupported, partial, or unverified.
4. Modern implementation choices may improve reliability without deleting the documented workflows. List any format/protocol incompatibility explicitly.
5. Refer to ACCEPTANCE.md for executable scenarios and evidence expectations. Catalog completeness requires a separate result for every named entry.
