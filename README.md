# Prism Live

A Windows audiovisual performance application being built from the supplied Resolume Avenue & Arena manual, with the newer `E:\DOWNLOADS\Resolume-Manual.pdf` taking precedence over the earlier Resolume 4 manual. This is an early working build. Full manual parity and live-show stability qualification are still in progress; it is not yet a complete replacement for Resolume. See [newer manual coverage](docs/NEW-MANUAL-COVERAGE.md).

## Launch

Double-click **Launch Prism Live.cmd**. The launcher uses the packaged executable when present, otherwise the local Electron build. It stores the app profile, logs, and temporary files in the sibling `E:\resolume-data` directory so a full system drive does not block startup or recovery saves.

Development is continuing against the newer manual. Close and reopen the app through the launcher to try an updated package. If an older copy is still running, the launcher now says so instead of leaving you in the old window.

Development requirements: Node.js and npm. From this directory:

```powershell
npm ci
npm run build
npm start
```

`npm run package` produces `release/manual-parity/PrismLive-win32-x64/PrismLive.exe`. The launcher prefers that updated build and retains the earlier packages as fallbacks. Close the running app and reopen the launcher to use an update. Keep the entire packaged directory together. Once packaged, the app runs offline without Node.js or a development server.

## Using the current build

- The workspace follows the supplied Arena screenshots: a compact clip bank, stacked composition and preview monitors, separate composition/layer and clip panels, and a dark interface with mint selection highlights.
- Clip and inspector playheads now follow the animation frame rate, with immediate visual response to seeking and reversing.
- Drag the thin divider below the deck to resize the top workspace and bottom panels. Drag between the composition and preview monitors to change their heights, or between the four bottom panels to change their widths. Sizes are saved locally and restored when you reopen the app. Double-click a divider to reset it; arrow keys work when a divider has focus.
- The newer manual's clip label colors and first dashboard controls are available. Select a clip to set its label highlight. Each clip, layer, and composition inspector has eight dials: drag the small handle beside a numeric parameter onto a dial or choose a parameter in its dropdown, then move the dial. Assignments and values save with the composition. Each dial currently controls one numeric parameter.
- Mark a clip **Persistent across decks** in its inspector to keep it visible in the same layer and column after switching decks. A clip it covers stays in its own deck; drag the small thumbnail at the top left of the persistent clip to another slot to move the covered clip. Turn persistence off to show the deck's original clip again.
- Use **Snapshot** beside Record for a PNG of the current output, or **Save clip frame as PNG** in the selected clip's inspector. The PNG is saved under `E:\resolume-data\profile\Recordings` and added to the first empty slot on the bottom layer. Clip snapshots retain transparency. If that layer has no empty slot, the PNG still saves and the app shows its path.
- Animated GIFs play in the composition and preview with their original frame timing. Composition playback follows transport pause, seeking, speed, reverse, and looping.
- MOV import prepares cached forward and reverse playback with transparency and audio, including the DXV clips in Resolume Arena's Shop74 folder. Opaque MOVs use H.264/AAC MP4 copies; transparent MOVs use VP9/Opus WebM copies. Deck slots and the Files tab show preview thumbnails. The original MOV stays untouched and remains the saved media reference. First import shows preparation progress; later opens reuse the cache in `E:\resolume-data\profile\media-cache`.
- The demo opens with three animated layers and two decks. Click thumbnails to play; right-click to inspect without triggering. A deck change preserves playing clips.
- Browse folders and drives from **Files**, preview by double-clicking, and drag media into a slot. Shift-click A/B to save a folder bookmark. Native media references survive saves and restarts. **Reconnect missing files** searches a folder for unique matches; individual media and soundtrack controls handle ambiguous matches.
- Use **Deck…** and **Columns…** to rename, insert, reorder, and remove decks or edit the column count. Shift-click selects a clip range. Copy/cut/paste and clip moves preserve playback when the destination layer can keep that clip active.
- **Pair audio…** attaches a separate soundtrack to video, still images, or generated sources. The soundtrack sets the clip duration; paired video stretches to match. Video and audio can be enabled independently. Linked AV faders scale both outputs without changing their separate faders.
- Adjust independent layer audio/video levels, blend mode, solo, bypass, and A/B assignment. The crossfader multiplies the layer levels. Clicking A or B fades over two seconds.
- Clip controls include forward/reverse/pause, loops, ping-pong, once/hold, once/clear, speed, trim, BPM sync, beat snap, six cues, and BeatLoopr. Layers can transition and sequence automatically.
- Composition settings provide a description, custom resolution, normal/piano trigger defaults, and own/selected/free layer destinations. Clips can override those trigger settings. Hold a piano trigger to play and release that input to stop its voice. Right-click a global direction button to pin the direction for new triggers.
- Add and order effects on a clip, layer, or composition. Transform, image masks, processing order, and stereo pan controls work at each scope. Preview selected clips without changing live output.
- Transform controls include XYZ rotation, anchors, dimensions, and numeric pixel entry. Clip controls include RGB channels and alpha when detected. Layer blends and clip transitions use the [documented blend catalog](docs/BLENDS.md); 50 Mask is still unsupported.
- **Settings** saves preferences for whether the clip panel follows triggers and whether audio, layer transport, and transition controls are shown.
- **Save/Open** use validated composition files. Recovery is saved after edits; a prior session can be recovered at launch. Keep your media at its saved location.
- **Output** opens a separate display window. With one display it opens windowed; multiple displays allow fullscreen output. Escape closes the output window.
- **Record** saves a WebM containing the rendered composition and mixed audio. Desktop recording streams to a temporary file before finalizing it, so long recordings do not accumulate in memory. A saved recording is added to the first free slot on the bottom layer.
- **Control** provides MIDI learn and local OSC UDP input. See [OSC address support](docs/OSC.md).

The browser development view is useful for testing. Files imported there use temporary browser URLs and need importing again after a restart. Use the Windows application for persistent media references.

### Manual-parity additions

- **Effects:** 84 video effects in the Effects tab, grouped by category and searchable (Ctrl+/). Each effect has its own parameters, Opacity, Blend mode, Bypass (B), presets (Save as… / apply from the effect card or the browser) and drag-to-reorder. Drop effects on a clip, a layer header or any panel; Alt-drop adds one at 0% opacity. Dropping an effect on an empty slot creates an **Effect Clip** that processes every layer beneath it. Older projects' effects still load.
- **Audio effects:** switch the Effects tab to **Audio** for 19 effects (EQ, filters, delay, ping-pong, reverb, distortion, bit crusher, compressor, limiter, flanger, chorus, phaser, tremolo, auto pan, stereo width, gain), each with Dry/Wet, on clips, layers, groups and the composition.
- **Sources:** 40 generators (shapes, patterns, fractals, particles, lasers, audio spectrum/waveform, colour bars, test card and more), the **Text Animator** with per-character animation, capture devices (cameras), **screen capture**, and the **Video Router** (layers below, or a chosen layer or group). Source parameters appear in the clip panel.
- **ISF shaders:** Effects tab → *Import .fs files…* or *Import folder…* loads Interactive Shader Format effects and generators.
- **Parameter animation:** click the ⚙ beside any parameter to animate it by Timeline, BPM Sync, Clip Position, Audio Analysis (composition, group, layer, clip or an external input with L/M/H bands, gain and fall) or a Dashboard dial (several parameters per dial, each with its own range). Shapes include ramp, sine, triangle, square, random and a drawable envelope.
- **Groups:** right-click a layer name → *Group › New*. Groups render their layers on transparent black, then mix as one layer with their own blend, opacity, audio, speed, bypass/solo/eject, effects, transform and column triggers. The **Group** tab shows the group panel.
- **Layers:** mask mode (luma/alpha, inverted), lock content, duplicate, clear clips, previous/next clip.
- **Shortcuts:** Ctrl+Shift+K (keyboard) or Ctrl+Shift+M (MIDI), or the Control tab's Edit buttons for OSC and DMX. Click a highlighted control, then give the input. Modes: value, toggle, momentary, trigger, set and relative (encoders). MIDI feedback is sent to controllers, BPM can follow MIDI clock, and shortcut sets can be saved as presets.
- **Advanced Output:** Output → *Advanced Output…* edits screens, slices, polygon slices, masks, perspective, grid and bezier warping, soft edges, colour correction, test card, identify and presets. Output windows now share the editor's process, so the composition goes to them GPU-to-GPU every frame instead of as 30 fps JPEG frames.
- **DMX and OSC out:** the Control tab sends pixel-mapped fixtures over Art-Net or sACN, receives DMX for shortcuts, and can send OSC feedback for OSC shortcuts.
- **Preferences:** audio output device, external FFT input device and MIDI clock sync.

## Keyboard

| Key | Action |
| --- | --- |
| F1–F3 | Select layer 1–3 |
| 1–0 | Trigger clip 1–10 in selected layer |
| Shift + 1–0 | Trigger column 1–10 |
| Left/Right; Shift + Left/Right | Trigger adjacent clip; select only |
| Enter | Trigger selection |
| Q W E R T Y; Shift + those keys | Jump to cue; set cue |
| Z X C V B N | BeatLoopr off / 4 / 2 / 1 / ½ / ¼ |
| Comma / Period / Slash | Reverse / forward / clip pause |
| I / O | Set in / out at playhead |
| Space | Pause/resume composition |
| Backtick; Escape | Toggle blackout; clear blackout |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O | Save / Save as / Open |
| Ctrl+Z / Ctrl+Y | Undo / redo edits |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste selected clips |
| Ctrl+Shift+K / Ctrl+Shift+M | Keyboard / MIDI shortcut edit mode (Escape exits) |
| Ctrl+/ | Search effects |

## Verification

```powershell
npm test
npm run test:ui
npm run test:desktop
npm run test:startup
npm run test:mov
npm run test:mov-reverse
node scripts/smoke-snapshot.mjs
```

The engine tests use an installed Chrome browser (`CHROME_PATH` overrides its path) and real GPU pixel checks, media decode, audio meters, context loss, and decoder cleanup. Pixel tests deliberately use software rendering for consistent comparisons. They do not measure hardware performance.

UI tests run a fixed production build. Desktop tests use an isolated temporary profile and hidden windows. Automation is detected from test/debug launches as well as the explicit headless flag; native dialogs are disabled. Startup checks the page and assets before opening a window. Startup failures exit with diagnostics in the profile's `prism.log`; the launcher also captures errors under `E:\resolume-data\logs`. Builds retain prior hashed assets to protect windows already loading them. Keep builds and desktop tests sequential for repeatable verification.

## Remaining work

Still outstanding after the manual-parity pass: Advanced Output slices that use a layer or group as input show the composition (layer textures are not yet shared with output windows); screen delay is stored but not applied; multi-select scale/rotate in the output editor; SMPTE timecode, Ableton Link, NDI/Spout/Syphon, FFGL/VST plugins, and native DXV/HAP decoding.

The [newer manual coverage](docs/NEW-MANUAL-COVERAGE.md), [full requirements](docs/REQUIREMENTS.md), and [acceptance plan](docs/ACCEPTANCE.md) preserve the complete manual scope. Significant remaining items include hierarchical groups, advanced output slices/warping/masks/edge blending, complete effect coverage, unresolved blend compatibility, audio effect hosting, multi-parameter dashboards and parameter animation/FFT control, camera capture, extended MIDI/OSC feedback, DMX/Art-Net and SMPTE, native GPU DXV decoding and legacy content/plugin compatibility, original project import, and sustained hardware/device testing.

Current video output is relayed to the second window as bounded JPEG frames up to 30 fps. MOV reverse uses a prepared reverse copy, including its embedded audio; other reverse video uses seeking and reverse audio is not implemented there. Audio preview is muted, with separate device/channel monitoring still pending. MOV playback uses FFmpeg to prepare H.264 MP4 copies for opaque media and VP9 WebM copies for transparent media; it does not use Resolume's native GPU DXV decoder. Other video decoding follows Electron/Chromium codec support. QuickTime recording, FFGL/VST, Flash, and macOS-only formats are not claimed compatible.

MOV preparation requires FFmpeg and ffprobe. This machine's installation at `C:\ffmpeg\bin` is detected automatically. Other installations can be supplied through `PATH`, `PRISM_FFMPEG_PATH` / `PRISM_FFPROBE_PATH`, or the packaged application's `resources/tools` directory. Existing playback copies can be reused without the converter. Playback copies preserve resolution, frame timing, and alpha but use 8-bit YUV color and Opus audio; they are not lossless archival conversions.

Do not equate green unit tests with verification of these outstanding requirements.
