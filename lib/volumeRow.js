import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

// Dragging fires many value changes; write GSettings once it settles.
const SAVE_DELAY_MS = 300;

function volumeIconName(value, muted) {
    if (muted || value <= 0)
        return 'audio-volume-muted-symbolic';
    if (value < 1 / 3)
        return 'audio-volume-low-symbolic';
    if (value < 2 / 3)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

/**
 * Mute button + slider for this player's own volume (independent of the
 * system volume). The slider value is perceptual; the daemon maps it to a
 * cubic amplitude.
 */
export const VolumeRow = GObject.registerClass(
class VolumeRow extends PopupMenu.PopupBaseMenuItem {
    _init(settings, player) {
        super._init({activate: false});
        this._settings = settings;
        this._player = player;
        this._saveSourceId = 0;
        this._syncing = false;

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this._muteButton = new St.Button({
            style_class: 'bmp-mute-button',
            can_focus: true,
            child: this._icon,
        });
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = 'Volume';
        this.add_child(this._muteButton);
        this.add_child(this._slider);

        this._muteButton.connect('clicked', () => {
            this._settings.set_boolean('muted', !this._settings.get_boolean('muted'));
        });
        this._slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            if (this._settings.get_boolean('muted'))
                this._settings.set_boolean('muted', false);
            this._apply();
            this._scheduleSave();
        });
        this._slider.connect('drag-end', () => this._save());

        this._settings.connectObject(
            'changed::volume', () => {
                // Ignore our own pending write; otherwise follow external changes.
                if (!this._saveSourceId)
                    this._syncFromSettings();
            },
            'changed::muted', () => this._apply(),
            this);
        this._player.connectObject('ready', () => this._apply(), this);

        this.connect('destroy', () => this._save());
        this._syncFromSettings();
    }

    /** Lets the panel icon adjust the volume with the scroll wheel. */
    scroll(event) {
        return this._slider.scroll(event);
    }

    _syncFromSettings() {
        this._syncing = true;
        this._slider.value = this._settings.get_double('volume');
        this._syncing = false;
        this._apply();
    }

    _apply() {
        const muted = this._settings.get_boolean('muted');
        const value = this._slider.value;
        this._player.setVolume(muted ? 0 : value);
        this._icon.icon_name = volumeIconName(value, muted);
        this._muteButton.accessible_name = muted ? 'Unmute' : 'Mute';
        if (muted)
            this._slider.add_style_pseudo_class('insensitive');
        else
            this._slider.remove_style_pseudo_class('insensitive');
    }

    _scheduleSave() {
        if (this._saveSourceId)
            GLib.source_remove(this._saveSourceId);
        this._saveSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveSourceId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Writes a pending change now (drag end, destroy). */
    _save() {
        if (!this._saveSourceId)
            return;
        GLib.source_remove(this._saveSourceId);
        this._saveSourceId = 0;
        this._write();
    }

    _write() {
        this._settings.set_double('volume', this._slider.value);
    }
});
