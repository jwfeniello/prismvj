# Media browser and reconnect

The desktop media browser lists mounted drives and common folders, opens folders, moves to their parent, and shows folders plus supported media files. Files enter the composition through the same registered media protocol used by the import dialog and file drops. Browser entries include file size and modification time; browsing does not create media tokens until a file is imported.

Folder listings put folders first and sort names naturally, so `Video 2` precedes `Video 10`. Each listing contains at most 2,000 entries and inspects at most 10,000 directory entries. A truncated result is identified explicitly. Symbolic links and junctions are omitted from listings and recursive reconnect scans.

Primary clip media, attached soundtracks, and masks at clip, layer, and composition level are saved as file paths. Session media URLs are cleared before saving and registered again when opening or recovering a composition. An unavailable path stays in the composition and is reported with the component identity so it can be repaired without losing its settings.

Reconnect scans the selected folder and its descendants for missing filenames. It replaces a path only when there is exactly one compatible match. Multiple matches are returned for explicit selection; existing media paths are never redirected because a matching name happens to be in the selected folder. Folder searches stop after 20,000 entries, 2,000 directories, 16 levels, or 10 seconds. A partial or unreadable search does not establish uniqueness and therefore applies no automatic replacements. Choose a smaller folder or reconnect that component to an explicitly selected file.

## Desktop bridge

- `browseRoots()` returns `{ name, path, kind: 'directory' }` entries.
- `browseDirectory(path)` returns `{ path, parent, entries, truncated }`. Entries have `name`, `path`, `kind`, `size`, and `modified`; `parent` is `null` at a filesystem root.
- `chooseMediaDirectory(initialPath?)` opens the native folder picker and returns its absolute path, or `null` on cancel.
- `importPaths(paths)` registers selected media and returns names, paths, kinds, and session URLs. Per-file failures appear as `error` values.
- `reconnectMedia(project, { clipId?, layerId?, component, replacementPath? })` reconnects one missing component. Omitting the replacement path opens a compatible-file picker. `component` is `video` for primary clip media, `audio` for an attached soundtrack, or `mask`; a mask with only `layerId` targets that layer, and a mask with neither ID targets the composition.
- `relinkProject(project, folder?)` reconnects unique missing filenames. Omitting the folder opens a folder picker.
- `revealInExplorer(path)` reveals an existing file or folder in the system file browser when requested by the user.

Both reconnect methods return `{ project, missing, relinked, ambiguous }`, or `null` on cancel. Bulk reconnect also returns `scan: { entries, directories, truncated, errors }` when a search occurs. Component identities contain `id`, `path`, `component`, and optional `clipId` and `layerId`. Relinked identities also contain `previousPath`; ambiguous identities also contain candidate absolute paths.

Only the trusted editor window can invoke these operations. Native media and file requests use filesystem APIs directly, without invoking a shell command. `tests/media-desktop.test.mjs` exercises the real IPC bridge in hidden windows with an isolated temporary profile and stubbed native dialogs and Explorer action.

## GPU-decoded movies

HAP and DXV store every frame as DXT/BC texture blocks. Registration asks ffprobe for the codec (`hap` or `dxv`), creates no playback copy, and returns a URL to the original file with `?gpu=hap|dxv&rev=<size>-<mtime>`. A changed file therefore opens a fresh decoder. `PRISM_GPU_VIDEO=0` turns this off, so every MOV is converted as before.

The renderer (`src/gpu-video/`) plays these movies as follows:

1. A worker reads the QuickTime header with HTTP Range requests and builds the frame index (`mov.js`). It also reads the format of the first DXV frame to learn whether the file has alpha.
2. Each frame is fetched by its byte range and decompressed in a pool of up to four workers. `hap.js` handles HAP sections, Snappy and chunked frames. `dxv.js` is an LGPL port of FFmpeg's DXV decompression, covering DXT1, DXT5, YCG6, YG10 and the old LZF/raw headers. The output is the texture blocks themselves.
3. The compositor uploads the blocks with `compressedTexSubImage2D`, using S3TC, RGTC and BPTC. One shader pass then writes an ordinary RGBA texture, which the rest of the pipeline uses like a `<video>` frame. That pass flips rows, converts Hap Q's scaled YCoCg and DXV's planar YCoCg, adds RGTC alpha planes, and un-premultiplies DXV DXT5.
4. The transport position picks the frame. The six frames ahead in the playback direction (forward or reverse, wrapping at the loop) decode in advance. When speed exceeds one frame per render, only the frames that will be shown are decoded. A frame that is still decoding is replaced by the nearest frame already passed, so a slow disk lags rather than freezes. Each clip keeps at most 12 decoded frames.

| Variant | Texture planes | Requires |
| --- | --- | --- |
| Hap (`Hap1`), DXV DXT1 | BC1 | S3TC |
| Hap Alpha (`Hap5`), DXV DXT5 (premultiplied) | BC3 | S3TC |
| Hap Q (`HapY`) | BC3 holding scaled YCoCg | S3TC |
| Hap Q Alpha (`HapM`) | BC3 YCoCg + BC4 alpha | S3TC, RGTC* |
| Hap Alpha-Only (`HapA`), shown as an opaque grey matte | BC4 | RGTC* |
| DXV high quality YCG6 / YG10 | BC4 Y (BC5 Y+alpha) + half-size BC5 CoCg | RGTC* |
| Hap R (`Hap7`), Hap HDR (`HapH`) — implemented, not yet verified with real files | BC7 / BC6H | BPTC |

\* Without RGTC, the workers expand BC4/BC5 planes to R8/RG8. Without S3TC, the clip requests `?converted=1`, and the host prepares the usual playback copy on first request.

The movie's own soundtrack plays from `?audio=1`, or `?audio=1&reverse=1` while the clip runs backwards. Both are FLAC files that FFmpeg extracts on first request and caches beside the other playback data. `?thumbnail=1` produces the usual cached JPEG.

Verification: `tests/gpu-video.webgl.test.mjs` compares rendered frames against FFmpeg's decoding for FFmpeg-encoded Hap, Hap Alpha, Hap Q (single and chunked, Snappy and uncompressed) and DXV DXT1. Hap Q Alpha, Hap Alpha-Only and DXV high quality are checked against assembled files. The installed Resolume DXT5 clip is also checked when present. High-quality DXV is verified only with literal-opcode frames, because FFmpeg cannot encode it. `tests/gpu-video-desktop.test.mjs` covers import, the protocol, composition, preview, output window, reverse playback and 1080p decode cost in Electron.