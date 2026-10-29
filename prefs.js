import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function displayPath(path) {
    const home = GLib.get_home_dir();
    return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function defaultMusicPath() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Music']);
}

export default class BackgroundMusicPlayerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        const library = new Adw.PreferencesGroup({title: 'Music Library'});
        page.add(library);
        library.add(this._buildFolderRow(window, settings));

        const recursive = new Adw.SwitchRow({
            title: 'Include subfolders',
            subtitle: 'Also list music inside folders of the music folder',
        });
        settings.bind('recursive-scan', recursive, 'active', Gio.SettingsBindFlags.DEFAULT);
        library.add(recursive);

        const playback = new Adw.PreferencesGroup({title: 'Playback'});
        page.add(playback);

        const autoplay = new Adw.SwitchRow({
            title: 'Autoplay on login',
            subtitle: 'Play the last track automatically after logging in',
        });
        settings.bind('autoplay', autoplay, 'active', Gio.SettingsBindFlags.DEFAULT);
        playback.add(autoplay);

        const resume = new Adw.SwitchRow({
            title: 'Resume where you left off',
            subtitle: 'Start the last track from its saved position instead of the beginning',
        });
        settings.bind('resume-position', resume, 'active', Gio.SettingsBindFlags.DEFAULT);
        playback.add(resume);
    }

    _buildFolderRow(window, settings) {
        const row = new Adw.ActionRow({title: 'Music folder'});

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Use the default Music folder',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.reset('music-folder'));

        const choose = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: 'Choose folder',
            valign: Gtk.Align.CENTER,
        });
        choose.connect('clicked', () => this._chooseFolder(window, settings));

        row.add_suffix(reset);
        row.add_suffix(choose);
        row.activatable_widget = choose;

        const sync = () => {
            const custom = settings.get_string('music-folder');
            row.subtitle = custom
                ? displayPath(custom)
                : `${displayPath(defaultMusicPath())} (default)`;
            reset.visible = custom !== '';
        };
        const id = settings.connect('changed::music-folder', sync);
        row.connect('destroy', () => settings.disconnect(id));
        sync();
        return row;
    }

    _chooseFolder(window, settings) {
        const current = settings.get_string('music-folder') || defaultMusicPath();
        const dialog = new Gtk.FileDialog({
            title: 'Choose Music Folder',
            modal: true,
            initial_folder: Gio.File.new_for_path(current),
        });
        dialog.select_folder(window, null, (_dialog, result) => {
            let folder;
            try {
                folder = dialog.select_folder_finish(result);
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    logError(e, 'Background Music Player: folder selection failed');
                return;
            }
            const path = folder?.get_path();
            if (path)
                settings.set_string('music-folder', path);
        });
    }
}
