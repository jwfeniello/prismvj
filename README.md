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

`npm run package` produces `release/resolume-transports/PrismLive-win32-x64/PrismLive.exe`. The launcher prefers that updated build and retains the earlier packages as fallbacks. Close the running app and reopen the launcher to use an update. Keep the entire packaged directory together. Once packaged, the app runs offline without Node.js or a development server.

## Using the current build

- The workspace follows the supplied Arena screenshots: a compact clip bank, stacked composition and preview monitors, separate composition/layer and clip panels, and a dark interface with mint selection highlights.
- Clip and inspector playheads now follow the animation frame rate, with immediate visual response to seeking and reversing.
- Drag the thin divider below the deck to resize the top workspace and bottom panels. Drag between the composition and preview monitors to change their heights, or between the four bottom panels to change their widths. Sizes are saved locally and restored when you reopen the app. Double-click a divider to reset it; arrow keys work when a divider has focus.
- The newer manual's clip label colors and first dashboard controls are available. Select a clip to set its label highlight. Each clip, layer, and composition inspector has eight dials: drag the small handle beside a numeric parameter onto a dial or choose a parameter in its dropdown, then move the dial. Assignments and values save with the composition. Each dial currently controls one numeric parameter.
- Mark a clip **Persistent across decks** in its inspector to keep it visible in the same layer and column after switching decks. A clip it covers stays in its own deck; drag the small thumbnail at the top left of the persistent clip to another slot to move the covered clip. Turn persistence off to show the deck's original clip again.
- Use **Snapshot** beside Record for a PNG of the current output, or **Save clip frame as PNG** in the selected clip's inspector. The PNG is saved under `E:\resolume-data\profile\Recordings` and added to the first empty slot on the bottom layer. Clip snapshots retain transparency. If that layer has no empty slot, the PNG still saves and the app shows its path.
- Animated GIFs play in the composition and preview with their original frame timing. Composition playback follows transport pause, seeking, speed, reverse, and looping.
- HAP (Hap, Hap Alpha, Hap Q, Hap Q Alpha, Hap Alpha-Only) and DXV3 (normal and high quality, with or without alpha) MOVs import instantly and play from the original file: worker threads read and decompress each frame, and the GPU decodes its DXT/BC textures. Forward, reverse, speed and scrubbing need no second file. The movie's soundtrack is extracted once to FLAC (forward and reversed) on first playback. See [docs/MEDIA.md](docs/MEDIA.md#gpu-decoded-movies).
- Other MOVs (ProRes, Animation and the like) are prepared to cached forward and reverse playback copies with transparency and audio. Opaque MOVs use H.264/AAC MP4 copies; transparent MOVs use VP9/Opus WebM copies. Deck slots and the Files tab show preview thumbnails. The original MOV stays untouched and remains the saved media reference. First import shows preparation progress; later opens reuse the cache in `E:\resolume-data\profile\media-cache`.
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
- **Parameter animation (as in Resolume):** click the ⚙ beside any parameter and choose Timeline, BPM Sync, Clip Position, Dashboard › Dial, or Audio Analysis › External/Composition/Group/Layer/Clip FFT. The parameter then expands inline with its own transport: ◀ ‖ ▶, play mode (loop, bounce, random, once), a mini timeline with a live playhead and in/out bar, Duration in seconds or Beats with ÷2 − + ×2, and speed (BPM Sync speeds stay on powers of two). The animation range is a bracket on the parameter's own slider; drag its ends, or past each other to invert. Audio Analysis shows the spectrum with L/M/H, a draggable band, gain, fall and > < − + responses. Envelope adds a drawable curve.
- **Clip transport:** Timeline or BPM Sync selector, in/out bar under the timeline (Shift-drag moves the range), direction and play-mode buttons (loop, ping pong, random, play once and eject, play once and hold), Duration (Timeline) or Beats with ÷2 − + ×2 and quantized BPM speed, Restart or Pick-up when returning to a clip, and click the time to show time remaining.
- **Groups:** right-click a layer name → *Group › New*. Groups render their layers on transparent black, then mix as one layer with their own blend, opacity, audio, speed, bypass/solo/eject, effects, transform and column triggers. The **Group** tab shows the group panel.
- **Layers:** mask mode (luma/alpha, inverted), lock content, duplicate, clear clips, previous/next clip.
- **Shortcuts:** Ctrl+Shift+K (keyboard) or Ctrl+Shift+M (MIDI), or the Control tab's Edit buttons for OSC and DMX. Click a highlighted control, then give the input. Modes: value, toggle, momentary, trigger, set and relative (encoders). MIDI feedback is sent to controllers, BPM can follow MIDI clock, and shortcut sets can be saved as presets.
- **Advanced Output:** Output → *Advanced Output…* edits screens, slices, polygon slices, masks, perspective, grid and bezier warping, soft edges, colour correction, test card, identify and presets. Output windows now share the editor's process, so the composition goes to them GPU-to-GPU every frame instead of as 30 fps JPEG frames.
- **DMX and OSC out:** the Control tab sends pixel-mapped fixtures over Art-Net or sACN, receives DMX for shortcuts, and can send OSC feedback for OSC shortcuts.
- **Preferences:** audio output device, external FFT input device, MIDI clock sync and the SMPTE input.
- **Crossfader:** layers and groups on the A or B bus render into their bus first; the buses mix with a chosen blend mode and curve (Overlap keeps both at full strength in the middle, Linear is a classic mix, Smooth is equal power, Cut switches at the centre). The A/B buttons follow the Behaviour setting: Fade over 4 beats, Jump, Jump & Return, or Cut while held.
- **Clip transport extras:** Random play mode has Interval and Distance (seconds or beats); Away has Relative pick-up; SMPTE transport follows incoming LTC timecode from an offset (Hold, Loop or Stop at the end). Choose the LTC input in Settings; the status bar shows the timecode.
- **Image sequences:** right-click an empty slot → Import image sequence…, or drop a folder of numbered frames on a slot. It plays as one clip at 25 fps.
- **Previewing effects:** double-click an effect in the browser to see it over the live composition in the Preview monitor.
- **Shortcut target:** a layer or clip shortcut can control *This* item or whatever is *Selected*.
- **Number fields:** type math such as `1920/3` or `/2`; ↑/↓ nudge, with Shift for ×10.
- **Advanced Output:** slices can use a single layer or group as input; screens have a delay (0–100 ms); several selected slices scale and rotate together, and list items reorder by dragging.
- **Video Router:** Input Opacity and Input Bypass follow the routed layer's fader and bypass/solo.
- **Thumbnails** for videos and generators, previous/next column buttons beside the Composition label, and smoother editing: effects compile in the background, so adding one no longer drops frames.

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

Still outstanding: features that need native code a browser engine cannot provide — Ableton Link, NDI, Spout/Syphon, FFGL video plugins, VST audio plugins and Denon StageLinQ. ProRes and other non-texture MOV codecs still play through FFmpeg-prepared copies.

The [newer manual coverage](docs/NEW-MANUAL-COVERAGE.md), [full requirements](docs/REQUIREMENTS.md), and [acceptance plan](docs/ACCEPTANCE.md) preserve the complete manual scope. Significant remaining items include hierarchical groups, advanced output slices/warping/masks/edge blending, complete effect coverage, unresolved blend compatibility, audio effect hosting, multi-parameter dashboards and parameter animation/FFT control, camera capture, extended MIDI/OSC feedback, DMX/Art-Net and SMPTE, legacy content/plugin compatibility, original project import, and sustained hardware/device testing.

Current video output is relayed to the second window as bounded JPEG frames up to 30 fps. HAP and DXV reverse plays the original frames backwards, with a reversed copy of the soundtrack; other MOV reverse uses a prepared reverse copy, including its embedded audio; other reverse video uses seeking and reverse audio is not implemented there. Audio preview is muted, with separate device/channel monitoring still pending. Other MOV playback uses FFmpeg to prepare H.264 MP4 copies for opaque media and VP9 WebM copies for transparent media. Other video decoding follows Electron/Chromium codec support. QuickTime recording, FFGL/VST, Flash, and macOS-only formats are not claimed compatible.

MOV preparation requires FFmpeg and ffprobe. This machine's installation at `C:\ffmpeg\bin` is detected automatically. Other installations can be supplied through `PATH`, `PRISM_FFMPEG_PATH` / `PRISM_FFPROBE_PATH`, or the packaged application's `resources/tools` directory. Existing playback copies can be reused without the converter. Playback copies preserve resolution, frame timing, and alpha but use 8-bit YUV color and Opus audio; they are not lossless archival conversions.

Do not equate green unit tests with verification of these outstanding requirements.
