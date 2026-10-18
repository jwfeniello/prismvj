# Newer Resolume Avenue & Arena manual coverage

Source: `E:\DOWNLOADS\Resolume-Manual.pdf` (295 PDF pages; supplied by the user on 2026-10-11). PDF page numbers below count from the cover. This manual takes precedence over the earlier Resolume 4 manual for intended controls and behavior. The Arena screenshots supplied in the conversation remain the visual reference.

This is a live coverage map, not a claim of feature parity. Existing detailed tests and older requirements remain in [REQUIREMENTS.md](REQUIREMENTS.md) and [ACCEPTANCE.md](ACCEPTANCE.md).

| Newer manual area | PDF pages | Current status and next gap |
| --- | --- | --- |
| **2026-10-18 update** | — | Groups, the effect/source catalogs, ISF, audio effects, parameter animation/FFT/envelopes, multi-parameter dashboard links, shortcuts (keyboard/MIDI/OSC/DMX, MIDI out, presets), Advanced Output (slices, polygons, masks, warping, soft edge) and DMX fixtures are now implemented. See the README's manual-parity section; rows below predate this update. |
| Clips, colors, transport, cues, BeatLoopr | 28–33, 65–71 | Triggering, transport, cue points and BeatLoopr work. Clip label highlights and persistent clips are editable and saved. Clip Snapshot exports transparent PNG and imports it to the first free bottom-layer slot. Image sequences and some trigger settings remain. |
| Layers, groups, decks, composition | 37–65 | Layers, A/B crossfader assignment, transitions, decks and composition settings work in part. The manual's hierarchical groups and group-to-slice routing remain. |
| Sources and live inputs | 75–86 | Five basic generated sources work. Text Animator, live cameras, NDI, Spout and Syphon remain. |
| Effects and transforms | 88–101 | Basic effects, transforms, image masks and ordering work. The full effect catalog, effect clips, presets and Slice Transform remain. |
| Output setup, input/output mapping and DMX | 102–139, 246–269 | A second output window, recording, and Output Snapshot work. Advanced slices, warping, edge blending, masks, LED fixture output and DMX remain. |
| Parameters, animation, dashboard, envelopes | 140–153, 218–224 | Eight assignable dials now appear in each clip, layer and composition inspector. They accept a parameter drag handle or a dropdown, drive the selected numeric parameter, and persist in project files. Multiple parameters per dial, parameter and dial ranges, inversion, timeline/BPM/clip-position animation, audio analysis and envelopes remain. |
| Shortcuts and external control | 157–216 | Basic keyboard, MIDI learn and a subset of OSC input work. Shortcut editing/presets, MIDI output, DMX input, OSC output, SMPTE and DJ sync remain. |
| Media preparation and DXV | 228–245 | DXV3 and HAP play natively: frames decompress in workers and upload as DXT/BC textures, in both directions, without a playback copy. Other MOVs are prepared to cached forward and reverse playback copies with thumbnails. DXV export remains. |

## Current manual-driven slice

- PDF pages 33 and 108 describe clip and output snapshots. Both now save PNGs to the app profile's `Recordings` directory and import to the first free bottom-layer slot. Clip snapshots retain transparent pixels; output snapshots contain the visible composite. The launcher keeps the profile under `E:\resolume-data\profile`, avoiding the full system drive.
- PDF page 33 describes separate pastel clip highlights. The inspector now sets or clears a highlight independently of a source generator's image color; it appears on the clip slot and survives save/reopen.
- PDF page 32 describes persistent clips carrying across decks and a small thumbnail for a covered clip. A clip can now be marked persistent in its inspector. It appears in the same layer/column on every deck while keeping each deck's original clip intact. The covered clip can be dragged from its small thumbnail to another slot, and switching persistence off restores the original view.
- PDF page 218 describes eight dashboard dials at the top of clip, layer, group and composition panels. The current clip/layer/composition panels have eight dials; group panels depend on implementing actual hierarchical groups. A dial may be assigned by dragging the small handle beside a numeric parameter onto it or by choosing its parameter from the dropdown.
- The current dashboard implements one numeric parameter per dial. The manual's multiple-parameter mapping and adjustment options (PDF page 219) are still outstanding.

## Next implementation areas

1. Hierarchical groups and their blend/transport controls, then group dashboards and routing.
2. Full parameter dashboard mappings and animation/envelopes, with saved, deterministic playback.
3. Advanced output slices and mapping tools, with qualification on actual displays and media.
