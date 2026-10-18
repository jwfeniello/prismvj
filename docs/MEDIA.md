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
