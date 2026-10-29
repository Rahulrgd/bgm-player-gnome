import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {SeekBar} from './seekBar.js';

// Toggles that are off are dimmed with opacity rather than a fixed colour so
// they read correctly on both light and dark shell themes.
const TOGGLE_OFF_OPACITY = 128;

const LOOP_UI = {
    none: {icon: 'media-playlist-repeat-symbolic', name: 'Loop: off', checked: false},
    all: {icon: 'media-playlist-repeat-symbolic', name: 'Loop: all', checked: true},
    one: {icon: 'media-playlist-repeat-song-symbolic', name: 'Loop: one', checked: true},
};

function controlButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'bmp-control-button',
        accessible_name: accessibleName,
        can_focus: true,
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
    });
}

/**
 * Now-playing title, transport buttons and seek bar.
 * Emits 'play-pause', 'previous', 'next', 'cycle-loop', 'toggle-shuffle';
 * the seek bar is exposed as `seekBar`.
 */
export const PlayerControls = GObject.registerClass({
    Signals: {
        'play-pause': {},
        'previous': {},
        'next': {},
        'cycle-loop': {},
        'toggle-shuffle': {},
    },
}, class PlayerControls extends St.BoxLayout {
    _init() {
        super._init({vertical: true, x_expand: true, style_class: 'bmp-player'});

        this._titleLabel = new St.Label({
            text: 'Nothing playing',
            style_class: 'bmp-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._titleLabel);

        const buttons = new St.BoxLayout({
            style_class: 'bmp-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._shuffleButton = controlButton('media-playlist-shuffle-symbolic', 'Shuffle');
        this._prevButton = controlButton('media-skip-backward-symbolic', 'Previous');
        this._playButton = controlButton('media-playback-start-symbolic', 'Play');
        this._playButton.add_style_class_name('bmp-play-button');
        this._nextButton = controlButton('media-skip-forward-symbolic', 'Next');
        this._loopButton = controlButton(LOOP_UI.none.icon, LOOP_UI.none.name);
        this._shuffleButton.add_style_class_name('bmp-toggle-button');
        this._loopButton.add_style_class_name('bmp-toggle-button');

        for (const [button, signal] of [
            [this._shuffleButton, 'toggle-shuffle'],
            [this._prevButton, 'previous'],
            [this._playButton, 'play-pause'],
            [this._nextButton, 'next'],
            [this._loopButton, 'cycle-loop'],
        ]) {
            button.connect('clicked', () => this.emit(signal));
            buttons.add_child(button);
        }
        this.add_child(buttons);

        this.seekBar = new SeekBar();
        this.add_child(this.seekBar);
    }

    get title() {
        return this._titleLabel.text;
    }

    setTitle(text) {
        this._titleLabel.text = text;
    }

    setPlaying(playing) {
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? 'Pause' : 'Play';
    }

    setLoopMode(mode) {
        const ui = LOOP_UI[mode] ?? LOOP_UI.none;
        this._loopButton.child.icon_name = ui.icon;
        this._loopButton.accessible_name = ui.name;
        this._setToggle(this._loopButton, ui.checked);
    }

    _setToggle(button, on) {
        button.checked = on;
        button.opacity = on ? 255 : TOGGLE_OFF_OPACITY;
    }

    setShuffle(shuffle) {
        this._setToggle(this._shuffleButton, shuffle);
        this._shuffleButton.accessible_name = shuffle ? 'Shuffle: on' : 'Shuffle: off';
    }
});
