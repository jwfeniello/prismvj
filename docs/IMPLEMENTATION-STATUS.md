# Implementation status

## 2026-10-18 manual-parity pass

Built on branch `feature/manual-parity` and packaged as `release/manual-parity`, which the launcher now prefers. This pass adds:
- a parameter system: path addressing, a definition registry, and a GLSL contract shared by catalog and imported effects
- 84 video effects with opacity/blend, multi-pass and feedback, plus presets
- 19 Web Audio effects at four scopes
- 40 generators, the Text Animator, capture/screen sources and the Video Router
- ISF import
- parameter animation (timeline, BPM, clip position, FFT, dashboard) with envelopes
- groups, mask layers, effect clips, layer lock/duplicate/clear
- a keyboard/MIDI/OSC/DMX shortcut system with MIDI feedback and clock sync
- Advanced Output (screens, slices, masks, warps, soft edges, test card)
- same-process GPU output windows
- Art-Net/sACN DMX output and input, OSC output
- audio device preferences

Verification: `npm test` 242 passed; `npm run test:ui` 30 passed plus 5 new feature specs; `npm run test:desktop` 31 passed plus the new output-window desktop test; packaged smoke passed for `release/manual-parity`. Undo now coalesces only continuous slider edits. Known gaps are listed in the README.

## 2026-10-11 opaque DXV reverse playback

The reported `spinning eli head_DXV 3 Normal Quality No Alpha.mov` is 3840×2160, 57 frames at 30 fps. FFprobe reports RGBA for DXV even when every alpha plane is fully opaque; the old cache therefore encoded a 61 MB alpha-bearing reverse VP9 file. The converter now scans DXV alpha planes across all frames, writes opaque MOV playback as H.264/AAC MP4 with eight-frame keyframe intervals, and retains VP9/Opus WebM for genuinely transparent MOVs. Existing cached opaque DXV assets are checked and migrated on their next import while the original MOV remains untouched. The renderer also skips repeated full-frame alpha readbacks for native MOVs with verified alpha status.

An isolated migration of the existing cache produced a 21 MB reverse MP4 from the 61 MB reverse WebM. A headless Chrome decode comparison of the user's 4K reverse copy showed 125 presented frames and zero dropped frames over 4.2 seconds for H.264, versus 118 presented and six dropped for opaque VP9. These are decoder measurements, not sustained visible show performance. The user's MOV passed native reverse playback in the composition; the Shop74 transparent DXV reverse and 15-thumbnail check also passed. The new `release/reverse-smooth-dxv` package passed standalone startup/media smoke and both MOV checks from isolated profiles. The core suite passed 133 tests, production browser suite 30, and native desktop suite 31. The normal launcher opened the new package with a visible, responding window and its production cache automatically migrated the reported MOV to the new reverse MP4. Visible playback with the user's full composition remains for user testing.

## 2026-10-11 transport responsiveness pass

The layer and selected-clip playheads and clip progress bars now update on every animation frame instead of every 100 ms. Progress bars change with CSS transforms, and the frame loop reuses DOM references refreshed after the clip bank or inspector is rebuilt. Beat and recording labels retain their slower update cadence. A focused browser regression measured 10 playhead updates over 59 callbacks before the change and 59 updates over 59 callbacks afterward; its seek check also passed. The full core suite passed 132 tests and the production browser suite passed 30 tests. The update is staged separately under `release/smooth-transport` so the running app can remain open until user testing.

## 2026-10-11 resizable workspace pass

The user-requested workspace splitters are implemented. Drag the horizontal divider between the clip bank/decks and the lower toolbar to resize the top and bottom sections. A second horizontal divider resizes the composition and preview monitors. Three vertical dividers resize the monitor, composition/layer inspector, clip inspector, and browser panels. Sizes persist in local storage and are clamped on window resize so both monitors remain visible and the layout fits at 1100×650. Focused dividers also respond to arrow keys; double-click resets their section.

Verification: 132 core tests and 29 production browser tests pass, including drag and reload persistence for all five dividers and a small-window overflow check. The isolated `release/resizable-panels` package passed hidden native startup and media smoke, including a real top divider drag and size restoration after packaged reload. Its clip and output Snapshot smoke passed, as did the Shop74 transparent MOV reverse and 15-thumbnail regression. After the old package exited, the normal launcher opened the new executable with the production profile; Windows reported a visible, responding `Prism Live` window and the startup stderr log was empty.

## 2026-10-11 Snapshot pass

The newer manual's clip and output Snapshot actions (PDF pages 33 and 108) are implemented. Clip snapshots preserve alpha and unpremultiplied color; output snapshots capture the visible composite. The packaged app saves each PNG atomically under its profile `Recordings` directory and imports it into the first free slot on the bottom layer. The launcher locates that profile at `E:\resolume-data\profile`. Browser development mode downloads the PNG and imports a temporary browser URL. When no bottom-layer slot is free, the PNG still saves and the UI reports where it went.

Launcher follow-up: a user launch now checks for a Prism Live copy already using the same production profile and reports whether the same or an older package is running. This prevents a successful-looking launch that leaves the operator viewing an old build. `PRISM_TEST_DATA` now also sets the launcher's Chromium profile path for isolated hidden checks, avoiding reuse of the production profile. The live older-package case was reproduced: the launcher printed the instruction, exited with code 1, and left the four existing processes untouched.

The production launcher logs from earlier repeated launches contain Chromium `Unable to move the cache: Access is denied` and `Gpu Cache Creation failed` messages, while the production profile directory is readable and writable and the older process is still active. Concurrent access to one Chromium profile is the likely cause; the launcher guard now blocks this handoff until the older copy exits. A mocked hidden launch selected the `release/snapshots` executable and directed Chromium to the isolated test profile without starting a window.

Verification: 132 core tests and 28 production browser tests pass. New browser checks verify PNG dimensions, bottom-layer imports, and transparent/partial-alpha pixels. The isolated `release/snapshots` package passed a hidden native save/import smoke for both actions, rejected invalid PNG input, and passed packaged startup plus Shop74 reverse MOV playback with thumbnails. Its MOV alpha regression passed for DXV, qtrle, and ProRes 4444 in the composition and preview, including cache reuse after restart. The MOV regression now also saves a selected-clip Snapshot for all three codecs and checks the PNG pixels; all retained transparent and opaque regions, and both generated codecs retained the blue partial-alpha rectangle. The full newer-manual objective remains incomplete.

## 2026-10-11 persistent clips pass

The newer manual's persistent clip behavior (PDF page 32) is implemented as a deck overlay. A persistent clip remains stored once in its home deck, appears in the same layer/column on other decks, and never deletes a covered deck clip. The covered clip has a small draggable thumbnail so it can be moved into an empty slot. Turning persistence off exposes the stored deck content. Column insertions follow the clip, copying creates a non-persistent copy, conflicting persistent flags are normalized during project validation, and OSC clip/column addressing uses the visible clip. Media imports reject a covered destination before changing any stored clip.

Verification: 132 model/engine tests and 26 production browser tests pass. The isolated `release/persistent-clips` package passes hidden startup from an unrelated working directory, Shop74 reverse playback with 15 thumbnails, and DXV/qtrle/ProRes4444 alpha playback with original paths and cache reuse across restart. Tests cover overlay, preservation, moving a covered clip, deck switching, saved projects, OSC targeting, and restoration. The full requirement remains incomplete; see the newer manual coverage map.

## 2026-10-11 newer manual pass

The user's 295-page `E:\DOWNLOADS\Resolume-Manual.pdf` is now the primary scope source. [NEW-MANUAL-COVERAGE.md](NEW-MANUAL-COVERAGE.md) records the major sections, current gaps, and PDF page references. Feature development has resumed at the user's request.

Implemented clip label highlights (manual PDF page 33) and eight single-parameter dashboard dials in each clip, layer, and composition inspector (manual PDF page 218). Dashboard assignments can be made by dropping a numeric parameter's small drag handle or choosing from the dial's menu. Dials change their actual target parameter, and both assignments and colors persist through composition validation and save. This is a subset of the manual dashboard: multiple parameters, range shaping, inversion, animation, and group dashboards remain.

The final package is staged at `release/new-manual-dashboard/PrismLive-win32-x64/PrismLive.exe`, separately from the running older release. Verification: 129 model/engine tests, 25 production browser tests, and a hidden packaged startup smoke pass. The new dashboard browser tests exercise dial assignment by dropdown and drag, parameter changes, clip label color, and composition master opacity. The package also passed hidden Shop74 MOV reverse/thumbnails and DXV/qtrle/ProRes4444 alpha smoke checks before the final dashboard-only visual adjustment; packaged startup was repeated after that adjustment. The full manual objective remains active.

## 2026-10-10 development pass

Created the Windows desktop application in `E:\resolume`, with a Vite build, isolated Electron shell, GPU renderer, model/transport, performance UI, and test suites. The full objective remains incomplete. The package passed its hidden launch check and was provided for user testing at that checkpoint.

Implemented foundations:

- Validated bounded project schema; generated demo; named decks; layers; native save/open; atomic replacement; recovery files; undo/redo; reconnect individual media.
- Deterministic clock with beat quantization, BPM playback, reverse/ping-pong/once modes, cues, BeatLoopr, piano release, transitions, and autopilot.
- Actual GPU layering and effect ordering, perspective XYZ rotation and anchor controls, clip/layer dimensions and fit modes, real media decode, stereo audio hierarchy, meters, and idle decoder eviction.
- Separate output, streaming WebM recording, keyboard controls, MIDI learn, and a documented subset of the original OSC tree.
- Editable column counts, deck/layer insertion and ordering, cross-deck move/cut/copy/paste, range selection, numeric parameter entry, and column trigger locks.
- Native folder browsing, A/B folder bookmarks, image thumbnails, separate file preview, bounded missing-file scans, and single-component reconnect.
- Paired soundtracks with video duration matching, independent video/audio toggles, fit modes, linked AV faders, and image masks with configurable processing order at all three scopes.
- Clip RGB/alpha controls, composition description and custom resolution, global direction pinning, and saved interface preferences for clip selection, audio controls, layer transport, and transitions.
- Own/selected/free layer trigger destinations, composition trigger defaults and clip overrides, independent decoders for routed copies, and piano release tied to the input that started each voice.
- A catalog of 39 supported layer blends and 37 clip transitions, including a random transition selected once per activation. See [BLENDS.md](BLENDS.md) for behavior and compatibility limits; 50 Mask remains unsupported.

This is partial evidence for C01, C04–C06, M01/M04/M05/M07, T01–T03/T06–T13, R01/R02/R04–R06/R08, O01/O02/O08/O09, A06/A07/A09, P03–P05. Each contains manual details beyond the current implementation. No full matrix row should be marked verified solely from this list.

## User-reported startup dialog

The first native test run displayed `ERR_FAILED (-2)` in an error dialog while loading the production page. That run was stopped. Startup now validates the compiled page and referenced assets before creating a window. Windows begin hidden and become visible only after loading succeeds during a normal user launch. Startup failures exit with a log entry instead of showing a native error modal. Automated launches are detected from test profiles, CI/test context, debugging switches, or `PRISM_HEADLESS=1`; native dialogs and Explorer are disabled in that mode. The launcher stores its profile, logs, and temporary files in the sibling `E:\resolume-data` directory, including startup stderr under `logs`, to avoid the full C: drive blocking launch or recovery saves.

Vite retains previous hashed build assets so rebuilding cannot delete a file an opening window is requesting. Desktop tests still run against a fixed completed build. The startup regression launches an actual Electron process against a disposable missing-build fixture: exit code 1, a durable diagnostic log, zero BrowserWindows, and zero native dialog attempts. A separate test uses only the automation debugging marker and verifies the loaded editor remains hidden.

The user subsequently reported that the launcher appeared to do nothing. It was passing `WindowStyle Hidden` to ordinary GUI launches, which can suppress Electron's first show request. The launcher now uses `Normal` for user launches and retains `Hidden` for automation. The corrected launcher was used to open the app for the user; native Windows inspection confirmed a visible, responsive Prism Live window at 1540×960. Earlier hidden smoke checks did not verify this user-visible launch behavior.

## Evidence locations

- `tests/model.test.mjs`: deterministic state, validation, transport and BeatLoopr.
- `tests/controls.test.mjs`: documented OSC routes and value encoding, unsupported/invalid address rejection.
- `tests/engine.webgl.test.mjs`: actual rendered pixels, video/audio playback, audio pan/meter, resource eviction, and graphics recovery.
- `tests/blends.webgl.test.mjs`: blend catalog pixels, transition endpoints, spatial geometry, luminance keys, and time-dependent switching.
- `tests/ui/workspace.spec.js`: assembled UI, real media import/recording, save/recovery, piano release, inactive clip safety, and undo preserving media.
- `tests/ui/performance.spec.js`: resolution and transform persistence, component pixels, direction pins, routed piano input, independent media clocks, and saved preferences.
- `tests/desktop.test.mjs`: actual Electron IPC, local media range requests and seeking, persistence/recovery, output frames, UDP OSC, streaming recording, and hidden-window behavior.
- `tests/composition.test.mjs` and `tests/ui/editing.spec.js`: grouped editing, decoder identity, live playhead preservation, real paired audio and mask pixels.
- `tests/files-browser.test.mjs`: failed thumbnail retry bounds, detached-tab isolation, and scrolling layout at 1360×900.
- `tests/media-desktop.test.mjs`: native folder listings, nested media persistence, exact media ranges, safe reconnect and ambiguous/incomplete search handling.
- `tests/startup.test.mjs`: automated-launch detection, build preflight, and actual Electron success/failure cases without windows or dialogs.

Hardware qualification is pending. GPU-completed rendering throughput and hidden-window animation timing are different measurements; neither alone establishes sustained visible output frame rate or audio/video synchronization during a show.

## Verified checkpoint

- Core, renderer, and browser suites: 126 passed across model/composition (72), OSC controls (23), engine (23), blends (6), and file-browser (2) tests.
- Production UI: 23 passed, including real paired audio, masks, column locks, grouped cut continuity, recording, recovery, undo, spatial controls, routed playback, preferences, simultaneous inspector isolation, and the reference layout at 1600×1000 and 1360×900.
- Hidden native Electron suites: 24 passed (5 startup, 9 desktop, 10 media), including actual output pixel decoding and acknowledgements waiting for every output consumer.
- Current packaged executable and `node scripts/smoke-package.mjs`: passed startup from an unrelated working directory without a development server, three rendered demo clips, 1280×720 output, isolated-profile autosave, external Unicode-path media import, exact HTTP byte ranges, and video seeking. All windows remained hidden. An additional packaged launch verified `--user-data-dir` relocates both profile and Chromium session data to E: while C: has no free space.
- Updated `release/current` package: both package smoke checks passed. `scripts/smoke-gif.mjs` imported the user's actual GIF through the native media dialog path, triggered it as the only live clip, observed three distinct composition pixel signatures, verified that pause holds both position and pixels, and verified resume. This ran in an isolated profile with every window hidden. Screenshots are in `test-results/reference-layout-1600.png`, `reference-layout-1360.png`, and `gif-composition.png`.
- The final PowerShell launcher also passed an isolated hidden launch: its helper returned, the packaged editor stayed running, and profile/recovery/log directories were created on E: without startup errors. The test process was then stopped.

Native inspection detected NVIDIA GeForce RTX 2060 SUPER through ANGLE/Direct3D 11. Hidden-window animation callbacks were throttled to approximately one per second; this is not a visible performance measurement. No sustained show performance claim is made.

## User testing and remaining work

The first feedback requested two changes: match the supplied Arena screenshots and fix GIF playback in the composition. The interface now has the reference clip-bank/deck/tempo arrangement, stacked output and preview monitors, simultaneous composition/layer and clip panels, and compact charcoal/mint controls. The preview is independent of live output. Existing controls remain bound to their own inspector targets.

GIF images now use explicitly decoded frames selected by the clip transport instead of a static image texture. Regression tests cover frame delays, transparency/disposal, pause, seek, reverse, retrigger, loops, independently routed copies, and resource disposal. A delayed-decoder regression ensures completed frames continue displaying when decoding is slower than the requested frame rate. The user's original GIF was verified as 87 frames over 3.48 seconds and produced different rendered pixels at five sampled times in the engine check.

That package was staged under `release/current` so the earlier running package was not overwritten. Subsequent work added MOV alpha import, reverse playback, thumbnails, and the newer manual features above.

The outstanding scope in REQUIREMENTS.md and the sustained release gates in ACCEPTANCE.md remain required for completion. This includes audio preview, parameter animation/dashboard/FFT, advanced output mapping, external protocols and hardware qualification, effect hosting and catalog coverage, unresolved blend compatibility, and legacy media/plugin/project compatibility. Current test passes do not establish full manual parity or sustained show stability.
