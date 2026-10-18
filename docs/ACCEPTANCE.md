# Acceptance and evidence plan

Reference: REQUIREMENTS.md and the user supplied 70-page Resolume 4 manual. This is a verification plan, not a report of passed tests. At initial creation all scenarios below are **unverified**. Record the build revision, command, exact fixture, timestamp, host hardware, observed result and artifact path before changing a scenario to verified. Failures and missing hardware remain visible.

## Evidence ledger

| Scenario | Requirements | Required evidence | Initial state |
| --- | --- | --- | --- |
| V01 Launch and project lifecycle | C01–C03, P02–P05 | Packaged Windows launch, persistence/recovery files and roundtrip assertions | Unverified |
| V02 Deck/layer/clip management | C04–C09, M02–M06 | Automated UI sequence plus project snapshots and output continuity trace | Unverified |
| V03 Real media and synchronized audio | M01, M03, R01, T06–T10 | Decoded frame IDs, audio capture and timestamp report | Unverified |
| V04 Trigger, beat and transport matrix | T01–T13, A06 | Deterministic clock tests plus observed playback/recording | Unverified |
| V05 Render graph and mixing | R02–R09, R13 | GPU pixel comparisons and animated output captures | Unverified |
| V06 Effects, presets and plugins | R10–R12 | Per-effect result table and isolated plugin compatibility fixtures | Unverified |
| V07 Preview and output | O01–O03 | Independent program/preview capture and real display/audio device exercise | Unverified |
| V08 Arena mapping | O04–O07 | Numbered grid image comparisons plus projector/display calibration | Unverified |
| V09 Recording | O08–O09 | ffprobe/decoder results, live output timing and reimported clip | Unverified |
| V10 Modulation | A01–A03 | Parameter traces and video/audio output comparisons | Unverified |
| V11 Keyboard and MIDI | A04–A08 | Mapping roundtrips, simulated events and actual controller feedback | Unverified |
| V12 OSC | A09 | UDP packet capture, address/range contract tests and real output changes | Unverified |
| V13 DMX | A10 | Art-Net/ENTTEC packet fixtures, reference Auto Map and hardware check | Unverified |
| V14 SMPTE | A11 | Known LTC waveform, frame-index capture and discontinuity report | Unverified |
| V15 Preferences and legacy | M08–M09, L01–L03, P01 | Persisted preference checks, source/device/legacy compatibility matrix | Unverified |
| V16 Stability and release | P03–P06, all applicable rows | Stress/soak/crash-recovery logs and clean installation run | Unverified |

## Controlled fixtures

Generate original test assets and keep generation commands: red/green/blue/white and alpha checker images; numbered quadrants and UV grids; frame-numbered motion video with timestamps; short and long audio/video clips with differing frame rates; PCM impulses aligned to marked video frames; a 440 Hz left/880 Hz right stereo tone; separately authored audio/video with intentionally different durations; transparent video; silent audio; no-audio video; missing, zero-length, truncated and unsupported files. Include paths with spaces, Unicode, long names and duplicate basenames in different directories. Use generated content in the shipped demo so availability does not depend on third party media.

Stable timing requires injecting a controllable clock into core scheduling tests. Output evidence must also exercise the actual clock, decoder, audio engine and renderer. Seed random tests for reproducibility; separately verify that different seeds produce different outcomes. Avoid tests that simply repeat implementation formulas without independent expected behavior.

## V01 — Launch, persistence and recovery

Launch from the delivered Windows entry point on a clean local user profile without a development server already running. Demo must visibly animate and controls respond. Save a composition containing multiple decks/layers, independent audio/video references, effects/presets, modulation, mappings and output configuration. Exit, relaunch and compare restored semantic state and rendered output. Change output resolution and verify actual render dimensions.

Attempt loading malformed, truncated, newer-version and missing-media projects; current unsaved project must remain recoverable. Kill the app during repeated atomic saves and verify the last complete save or recovery file opens. Simulate unwritable paths and disk-full errors without claiming success. Import representative Resolume 3 projects for C03; lack of fixtures is unverified, not passed. Confirm clone-owned data/log directories and useful recovery instructions.

## V02 — Management and uninterrupted performance

Run one clip while switching between three decks at least 100 times; record output frame/time continuity. Create/insert/rename/reorder decks and layers. Verify one normal voice per layer, clear/bypass/solo behavior, selected inspector independent from output, and global blackout/clear. Drag move/swap/copy, cut/paste across decks and multi-select edits. Undo/redo, if provided, must restore valid media ownership and render state.

Use the file browser A/B locations, type-to-find, thumbnail toggle and preview. Merge separate media; verify transposed video length follows audio. Remove video and retain audible audio. Test RGB and alpha channel controls and each fit mode against a nonmatching aspect image. Move a media directory and reconnect one/all without misidentifying duplicate filenames. Test numeric entry/reset and visibility settings. Future import defaults must not change existing clips.

## V03 — Actual media, audio and synchronization

Load real files via both dialog/browser and OS drop. Capture numbered video frames and audio impulses from program output. Verify normal, slow, fast, reverse, pause, scrub, loop and changing BPM behaviors. Audio and video must remain aligned through sustained playback, repeated seeks and loop boundaries. Document achieved skew and any decoder restrictions. Separate audio/video with intentionally mismatched durations must loop together on the audio duration.

Use the stereo tone fixture to verify clip → layer → master gain/pan and linked AV versus separate faders. Confirm master mute is silent and selected-channel routing is real. Verify decode errors are isolated to the affected clip and recovering/clearing it frees resources. DXV alpha and GPU path claims require an actual DXV fixture and measured implementation path; generic MOV playback is insufficient.

## V04 — Transport and triggering matrix

At a fake clock set to 120 BPM, request triggers just before, on and just after beat/bar boundaries. Assert no early start, one scheduled start and common column boundary. Exercise per-clip overrides versus composition defaults, normal/piano styles, target own/selected/free layer, exhausted free layers, and release before a quantized start. Each held voice must have its own release identity so a late key release cannot clear a newer unrelated clip.

Test forward/reverse at in/out boundaries, ping-pong without duplicate or skipped endpoints, once-clear, once-hold, pause, retrigger restart/resume, and speed changes. Global speed affects timeline clips only. Pin direction then trigger a differently configured clip. Test explicit beats, source BPM and detected beats; change global tempo without abrupt phase drift. Verify random BPM jumps to beat positions and continues playback, while random timeline mode samples frames at speed-dependent intervals.

Set all six cues while paused; jump to each and confirm BeatLoopr clears. Loop each supported beat fraction near both clip edges. Scratch then retrigger and confirm quantized resynchronization. Verify current/remaining time. Autopilot skips empty cells in all directions, per-clip stop/loop overrides, generated clip duration, destination quantization wait, and ignoring alternate target. Include zero/near-zero duration so no synchronous infinite loop is possible.

## V05 — Pixels and render graph

Render known-color layers in a tiny offscreen target and read back pixels. Check bottom-to-top ordering, alpha and all blends at 0, 0.25, 0.5, 0.75, 1. Compare expected special semantics from the manual; spatial modes require animated shape/position comparisons. Keep one result per catalog entry, including unresolved 50 Mask semantics.

Crossfade A/B groups including multiple layers and an unassigned layer; layer maxima must remain intact. Check automatic two-second endpoint fade. Transition duration 0/1/10 seconds, rapid retriggers mid-transition and random selection; old and new media resources must be released when no longer used. Confirm manual exclusions from transition list.

Use grid/alpha fixtures for clip/layer/composition transforms and masks, including PNG-alpha versus red-channel mask, invert/bypass/remove, XYZ anchor and rotation. Compare effect→transform against transform→effect and mask→transform against transform→mask. Effect clips must sample lower composites and remain valid after the last effect is removed. Nearest and smooth scaling must visibly differ on a checkerboard. Performance mode must implement the documented reduced render graph.

## V06 — Effects and plugin compatibility

Create a result table containing every audio/video effect and every parameter exposed in REQUIREMENTS.md catalogs. Test minimum, default and maximum values, animated values, opacity/dry-wet at 0 and 1, bypass, remove and reorder. Check no nonfinite output or GL/audio errors at extremes. Temporal effects need a moving fixture; spatial effects need a grid. Do not accept unchanged pixels or a generic substitution for named behavior.

Save, reload, rename, overwrite, delete and reset presets, including Unicode names. Add the same effect multiple times and edit independently. Host real known FFGL 1.5 and VST fixtures with declared ABI/architecture; prove parameters and rendered/audio output. Feed a bad plugin during scan and exercise plugin failure isolation. Native-host compatibility is distinct from built-in effect coverage.

## V07 — Preview, displays and audio devices

While program plays clip A, preview inactive clip B and then another layer. Program frames/audio must be unchanged; preview ignores source volume/opacity. Test transparency backgrounds and collapse/expand. Capture master and preview audio channels independently using a multichannel device or documented loopback; verify no preview signal leaks into master.

Open output window, move it to another display, fullscreen, return windowed, close/reopen, disable and re-enable. Program output must remain animated while application UI is covered or unfocused. Unplug/reconnect a display and audio device; app remains controllable and reports routing changes. Record monitor count, resolutions, DPI scales and refresh rates. Single-monitor tests do not prove multi-monitor operation.

## V08 — Arena advanced output

Use a numbered composition grid and two different output aspect ratios. Route nonoverlapping and overlapping rectangles; verify exact source pixels, individual layer routing, slice stacking and movement between screens. Move each warp point, add/remove points, use Bezier handles, numeric input and keyboard nudge. A straight line should remain straight under linear interpolation and curve under Bezier control. Check whole-slice scale/rotate/position independently of source selection, plus panoramic wrap.

Draw triangle, concave polygon and curved mask/crop; verify inside/outside semantics, invert type and multiple overlapping shapes. Identify displays and show test card. Blend overlapping slices with varied power/luminance/gamma, then test black compensation and per-output brightness/contrast. CPU reference/pixel captures prove math; real overlapping projectors are needed for a claim of calibrated projector performance. Save/load output presets and reconnect changed display IDs gracefully.

## V09 — Recording that produces reusable media

Record at least 60 seconds while triggering clips, mixing, changing effects and switching decks. Test video-only, audio-only and both. Decode the resulting files independently; verify expected codec/container, dimensions, duration, audio channels, monotonic timestamps and synchronized impulses. Stop inserts a playable new clip in the bottom layer's first empty slot; do not overwrite occupied clips. Replay it through the app.

Record to a slow target and simulate full/unwritable storage. Memory queue must stay bounded; accepted frames flush or failures are clearly reported. Program performance and UI remain responsive. Repeated start/stop creates distinct valid files and releases encoders/file handles. QuickTime Photo JPEG and WAV compatibility each need actual evidence if claimed; WebM alone does not fulfill the original recording format row.

## V10 — Modulation

Trace a parameter through timeline loop/ping-pong/once, clip position, BPM cycle, clip/composition beat decay, inversion and easing. Check min/max, zero range, reversed range, paused transport and tempo changes. Link several parameters to one dashboard knob with different ranges/inversions; verify scope isolation and persistence for all eight knobs.

Feed known sine sweeps/impulses into clip, composition and external FFT. Check low/mid/high discrimination, selected frequency interval, gain, decay and amplitude/speed modes. A disconnected external input yields controlled silence and can reconnect. Capture actual output changes as well as parameter traces.

## V11 — Keyboard and MIDI

Exercise the complete default key table and custom mappings with text fields focused, repeated keydown, keyup after focus loss, and modifier combinations. Check application layer-relative/deck-absolute rules, always-relative clip inspector controls and composition-specific addressing. Test toggle, piano, ranges and mouse-driven controls. Escape exits mapping, and mappings survive their correct persistence scope.

Use a MIDI virtual loop and real controller: note on/off including velocity-zero note-on; velocity, absolute CC, each supported relative encoding, inverted/ranged mapping, manual assignment, map save/load and feedback without recursive echo. For clock, inject 24 pulses per quarter note with jitter, start/continue/stop, missing pulses and device disconnect; verify each preference mode and controlled fallback. MIDI simulator success alone does not prove physical controller feedback.

## V12 — OSC contract

Send independent UDP OSC packets to all documented object/property paths, including strings, ints, floats, and one/triple `values`. Assert actual state/output, normalized range conversion and no mutation for malformed packets, nonexistent indexes or unsupported types. Test bundle ordering/timetags according to declared support and document any difference. Use long/Unicode strings and maximum packet boundaries without allocating unchecked sizes.

Verify receiving network configuration and outbound feedback destination/port, custom output address, no output when disabled and no self-feedback storm. Test composition/layer/clip effects at different indexes, layer move/clear/solo/group, `/trackN/connect`, parameter directions/play modes and text values. Retain packet capture plus observed frame/parameter change for representative commands.

## V13 — DMX/Art-Net

Acquire the separate referenced DMX Auto Map sheet or authoritative compatible channel fixture before claiming automatic-map parity. Compare every channel and offset against it. Send ArtDmx packets with correct/incorrect subnet/universe/port, sequence wrap, partial payloads and malformed lengths. Verify configurable node identity/discovery if supported by reference behavior. Exercise custom learn and manual mappings and persistence.

Connect an ENTTEC USB Pro, validate framing and device reconnect using its official protocol, and compare physical desk changes with output. Test auto and custom map channel offsets near 1 and 512. A network-only DMX implementation leaves ENTTEC compatibility unverified.

## V14 — SMPTE

Generate or capture known LTC at each supported frame rate, including applicable drop-frame behavior. Feed the selected audio input, verify displayed timecode and active-clip frame position with start offset and input delay. Test jumps backward/forward, signal loss, malformed waveform, midnight wrap and recovery. An inactive SMPTE clip must stay inactive until separately triggered. Software-injected time values do not prove LTC audio decoding.

## V15 — Preferences and legacy

Verify every listed preference persists and changes real behavior: recording modes/path, follow-trigger selection, clip-start offset, quit confirmation, fonts/Unicode, audio devices/channels/rate/buffer, external FFT, plugin paths, video quality/performance mode, MIDI, OSC, import defaults. Test camera capture/deinterlacing, source duration and camera reconnect.

For Flash, use original minimal AS2 and AS3 fixtures with rtext and float/string/boolean/event parameters, callback updates, multiline strings, render-size/quality and autonomous/timeline/BPM modes. Confirm <=3-frame default behavior. Test malformed SWF without compromising the host. Identify unsupported Flash APIs/content explicitly. Syphon and Quartz Composer remain explicitly macOS-specific; do not report a Windows approximation as those protocols.

## V16 — Stability and release gate

Set and report measured targets on the actual host, including CPU/GPU/RAM/audio device/display setup and fixture codec/resolution. Suggested baseline workload: three 1920×1080 video layers at 30 fps, audio playback, two effects per layer, a composition effect, output window and active preview. These are engineering targets, not performance guarantees derived from the old manual.

Run a sustained show soak (minimum two hours before claiming stable performance): automated triggering/deck switches, transport changes, source reloads, output open/close, recording segments and mappings. Track frame time percentiles, dropped frames, audible underruns, A/V skew, memory/handles and errors. After warm-up, repeated identical cycles must not grow resources without bound. Excess load must degrade predictably while emergency blackout/clear stays responsive.

Exercise faults: corrupt/missing media, moved media directories, failed save, disk full, lost camera/audio/MIDI/display, decoder/encoder failure and graphics context loss where supported. Verify logs, user-facing recovery and ability to save/open a good composition afterward. Package and launch from a fresh install with network disconnected; confirm no missing build-time dependency or console setup step. Capture a walkthrough covering live mixing, output mapping, recording and recovery.

The full goal can be declared complete only when every applicable requirement has direct evidence, catalog/protocol compatibility gaps are resolved, and release/stability gates pass. A passing unit suite, rendered screenshot or launch demo alone is insufficient.

## Verified implementation evidence — 2026-10-10

`node --test tests/desktop.test.mjs` completed with 9 passing tests, 0 failures, 0 skips on the current worktree. Tests launched actual Electron with an isolated temporary profile, hidden windows and all native dialogs disabled unless explicitly stubbed. No application window or fullscreen output was shown on the operator's desktop.

Observed subsets: real WebM import via registered local-media URL; correct 206 byte-range contents and actual seek to 1.2 seconds; restricted MIDI API access from the editor; atomic save/open and path reset; malformed project preserves current save destination; current-session autosave preserves earlier and corrupt recovery files; real external output first displays the 1280×720 composition, then decodes a known red JPEG; output backpressure waits for all consumers; real UDP OSC reception/rejection; streamed WebM chunks produce identical bytes and independently loadable video. The streaming shell test validates file writing/reopening, not the renderer's full live recording workflow or original QuickTime/WAV compatibility.

Native testing exposed and fixed two runtime issues: Electron's `net.fetch(file:)` ignored Range, requiring explicit streaming 206/416 responses; Electron 44 requested its `midiSysex` permission label even for `requestMIDIAccess({sysex:false})`, so both MIDI labels are restricted to the trusted editor frame. Output acknowledgement now occurs once after every subscriber finishes decoding.

The detected WebGL renderer is ANGLE using NVIDIA GeForce RTX 2060 SUPER / Direct3D11. Hidden-window animation scheduling measured about one frame per second; that is not a live visible-window performance result. A synchronous render microbenchmark is emitted for diagnosis but is not accepted as proof of performance. Multi-monitor/projector operation, physical MIDI devices, preview audio routing, full OSC compatibility, original formats/plugins and sustained show stability remain unverified. Full scenario rows above remain open until their entire scope is covered.
