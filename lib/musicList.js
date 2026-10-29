import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {getMusicFolder, scanMusic} from './scanner.js';

// Creating thousands of menu items at once stalls the shell, so the list is
// rendered in pages.
const PAGE_SIZE = 200;

function displayPath(file) {
    const rel = Gio.File.new_for_path(GLib.get_home_dir()).get_relative_path(file);
    return rel ? `~/${rel}` : file.get_path() ?? file.get_uri();
}

/**
 * "Music List" submenu. The music folder is scanned each time the submenu
 * opens. Emits 'track-activated' (index into `tracks`) when a track is clicked.
 */
export const MusicList = GObject.registerClass({
    Signals: {'track-activated': {param_types: [GObject.TYPE_INT]}},
}, class MusicList extends PopupMenu.PopupSubMenuMenuItem {
    _init(settings) {
        super._init('Music List', true);
        this._settings = settings;
        this._tracks = [];
        this._items = new Map();
        this._currentUri = null;
        this._cancellable = null;

        this.icon.icon_name = 'folder-music-symbolic';
        this.menu.actor.add_style_class_name('bmp-music-list');

        // PopupSubMenu only shows a scrollbar when the whole top menu is too
        // tall; the list has its own max-height, so always allow scrolling.
        const open = this.menu.open.bind(this.menu);
        this.menu.open = animate => {
            open(animate);
            this.menu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        };

        // A PopupSubMenu refuses to open while empty.
        this._showMessage('Open to load music');

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._refresh().catch(e => logError(e, 'Background Music Player: scan failed'));
        });
    }

    get tracks() {
        return this._tracks;
    }

    setCurrent(uri) {
        this._currentUri = uri;
        for (const [itemUri, item] of this._items) {
            item.setOrnament(itemUri === uri
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
    }

    async _refresh() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        if (this._tracks.length === 0)
            this._showMessage('Scanning…');

        const folder = getMusicFolder(this._settings);
        let tracks;
        try {
            tracks = await scanMusic(folder, {
                recursive: this._settings.get_boolean('recursive-scan'),
                cancellable,
            });
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._tracks = [];
            this._showMessage(e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                ? `Folder not found: ${displayPath(folder)}`
                : `Cannot read ${displayPath(folder)}`);
            console.warn(`Background Music Player: ${e.message}`);
            return;
        }
        if (cancellable.is_cancelled())
            return;
        this._cancellable = null;

        this._tracks = tracks;
        if (tracks.length === 0) {
            this._showMessage(`No music found in ${displayPath(folder)}`);
            return;
        }
        this.menu.removeAll();
        this._items.clear();
        this._renderFrom(0);
    }

    _renderFrom(start) {
        const end = Math.min(start + PAGE_SIZE, this._tracks.length);
        const showRelPath = this._settings.get_boolean('recursive-scan');
        for (let i = start; i < end; i++) {
            const track = this._tracks[i];
            const item = new PopupMenu.PopupMenuItem(showRelPath ? track.relPath : track.title);
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            item.setOrnament(track.uri === this._currentUri
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            item.connect('activate', () => this.emit('track-activated', i));
            this._items.set(track.uri, item);
            this.menu.addMenuItem(item);
        }

        const remaining = this._tracks.length - end;
        if (remaining > 0) {
            const more = new PopupMenu.PopupMenuItem(`Show more (${remaining} left)`);
            more.add_style_class_name('bmp-show-more');
            // Keep the menu open while appending the next page.
            more.activate = () => {
                more.destroy();
                this._renderFrom(end);
            };
            this.menu.addMenuItem(more);
        }
    }

    _showMessage(text) {
        this.menu.removeAll();
        this._items.clear();
        const item = new PopupMenu.PopupMenuItem(text);
        item.sensitive = false;
        this.menu.addMenuItem(item);
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        super.destroy();
    }
});
