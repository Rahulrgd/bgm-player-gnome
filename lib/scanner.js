import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::type',
    'standard::fast-content-type',
    'standard::is-hidden',
    'id::file',
].join(',');
const BATCH_SIZE = 100;
// audio/* types that are playlists rather than playable files.
const NON_TRACK_TYPES = new Set(['audio/x-mpegurl', 'audio/mpegurl', 'audio/x-scpls']);

/**
 * @param {Gio.Settings} settings
 * @returns {Gio.File} the configured music folder, or the XDG Music directory
 */
export function getMusicFolder(settings) {
    const configured = settings.get_string('music-folder');
    if (configured)
        return Gio.File.new_for_path(configured);
    const xdg = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC);
    return Gio.File.new_for_path(xdg ?? GLib.build_filenamev([GLib.get_home_dir(), 'Music']));
}

/**
 * @param {Gio.File} file
 * @returns {Promise<boolean>} whether `file` exists, without blocking
 */
export async function fileExists(file) {
    try {
        await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
        return true;
    } catch {
        return false;
    }
}

function isTrack(info) {
    const type = info.get_attribute_string('standard::fast-content-type') ?? '';
    return type.startsWith('audio/') && !NON_TRACK_TYPES.has(type);
}

function trackTitle(displayName) {
    const dot = displayName.lastIndexOf('.');
    return dot > 0 ? displayName.slice(0, dot) : displayName;
}

/**
 * Yields the visible children of `dir` in batches.
 *
 * @param {Gio.File} dir
 * @param {Gio.Cancellable} cancellable
 */
async function* listChildren(dir, cancellable) {
    const enumerator = await dir.enumerate_children_async(ATTRIBUTES,
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(BATCH_SIZE,
                GLib.PRIORITY_LOW, cancellable);
            if (infos.length === 0)
                return;
            yield* infos.filter(info => !info.get_is_hidden());
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
}

/**
 * Lists audio files under `folder` without blocking the main loop.
 *
 * @param {Gio.File} folder
 * @param {object} options
 * @param {boolean} options.recursive descend into subfolders
 * @param {Gio.Cancellable} options.cancellable
 * @returns {Promise<{uri: string, title: string, relPath: string}[]>} sorted by path
 */
export async function scanMusic(folder, {recursive = false, cancellable = null} = {}) {
    const tracks = [];
    const rootInfo = await folder.query_info_async('id::file',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
    // Symlinks are followed, so remember directories to avoid loops.
    const visited = new Set([rootInfo.get_attribute_string('id::file')]);
    const pending = [folder];

    while (pending.length > 0) {
        const dir = pending.shift();
        for await (const info of listChildren(dir, cancellable)) {
            const child = dir.get_child(info.get_name());
            const type = info.get_file_type();
            const id = info.get_attribute_string('id::file');
            if (type === Gio.FileType.DIRECTORY && recursive && !visited.has(id)) {
                visited.add(id);
                pending.push(child);
            } else if (type === Gio.FileType.REGULAR && isTrack(info)) {
                tracks.push({
                    uri: child.get_uri(),
                    title: trackTitle(info.get_display_name()),
                    relPath: folder.get_relative_path(child) ?? info.get_display_name(),
                });
            }
        }
    }

    tracks.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined,
        {numeric: true, sensitivity: 'base'}));
    return tracks;
}
