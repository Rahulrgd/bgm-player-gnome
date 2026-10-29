import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PlayerControls} from './controls.js';
import {MusicList} from './musicList.js';
import {LOOP_MODES} from './playlist.js';
import {fileExists, getMusicFolder, scanMusic} from './scanner.js';
import {VolumeRow} from './volumeRow.js';

// "Previous" restarts the current track once it has played this long.
const RESTART_THRESHOLD_MS = 3000;
// While playing, the position is persisted at most this often.
const POSITION_SAVE_INTERVAL_US = 10 * 1000 * 1000;
// Login autoplay: wait a little after startup for the audio server, and retry
// if playback fails because it is still not ready.
const AUTOPLAY_DELAY_MS = 2500;
const AUTOPLAY_RETRY_MS = 3000;
const AUTOPLAY_ATTEMPTS = 3;
// Unplayable files are skipped, but stop after this many in a row.
const MAX_CONSECUTIVE_ERRORS = 3;

function errorHint(message) {
    if (/plug-?in|codec|decoder|determine type/i.test(message))
        return 'The file may be damaged, or a GStreamer codec is missing ' +
            '(gstreamer1.0-plugins-good/-ugly, gstreamer1.0-libav).';
    return message;
}

/**
 * Panel button + menu, and the playback controller behind them.
 * Emits 'now-playing-changed' when the track or its metadata changes and
 * 'seeked' (ms) after a jump in position; the public play()/pause()/next()/…
 * methods are used by MPRIS.
 */
export const Indicator = GObject.registerClass({
    Signals: {
        'now-playing-changed': {},
        'seeked': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class Indicator extends PanelMenu.Button {
    _init(settings, player, playlist, {name, openPreferences}) {
        super._init(0.5, name, false);
        this._openPreferences = openPreferences;
        this._settings = settings;
        this._player = player;
        this._playlist = playlist;
        this._positionMs = 0;
        this._durationMs = 0;
        this._lastPositionSave = 0;
        this._loadGeneration = 0;
        this._autoplaySourceId = 0;
        this._autoplayAttempts = 0;
        this._autoplayGeneration = null;
        this._consecutiveErrors = 0;
        this._lastLoadAutoplay = false;
        this._tags = {};

        this.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon',
        }));

        this.menu.box.add_style_class_name('bmp-menu');

        this._buildPlayerSection();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildVolumeRow();
        this._buildMusicList();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildAutoplaySwitch();
        this._buildSettingsItem();
        this._connectPlayer();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._controls.seekBar.setPosition(this._positionMs);
        });
        // The extension stays enabled on the lock screen so music keeps
        // playing, but its menu must not be reachable there.
        Main.sessionMode.connectObject('updated', () => this.syncSessionMode(), this);

        this.connect('destroy', () => {
            if (this._autoplaySourceId)
                GLib.source_remove(this._autoplaySourceId);
            this._autoplaySourceId = 0;
            if (this._player.state !== 'stopped')
                this._savePosition();
            this._destroyed = true;
        });
    }

    /** Hides the indicator on the lock screen; call again once it is in the panel. */
    syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        // No animation: the indicator may be destroyed right after this.
        if (locked)
            this.menu.close(BoxPointer.PopupAnimation.NONE);
        this.container.visible = !locked;
    }

    /** UI state needed to rebuild the indicator around a still-playing player. */
    snapshot() {
        return {
            title: this._controls.title,
            positionMs: this._positionMs,
            durationMs: this._durationMs,
            lastLoadAutoplay: this._lastLoadAutoplay,
            tags: this._tags,
        };
    }

    adopt({title, positionMs, durationMs, lastLoadAutoplay, tags}) {
        this._positionMs = positionMs;
        this._durationMs = durationMs;
        this._lastLoadAutoplay = lastLoadAutoplay;
        this._tags = tags;
        this._controls.setTitle(title);
        this._controls.setPlaying(this._player.state === 'playing');
        this._controls.seekBar.setDuration(durationMs);
        this._controls.seekBar.setPosition(positionMs);
        this._musicList.setCurrent(this._playlist.current?.uri ?? null);
        this.emit('now-playing-changed');
    }

    // --- Public controls (MPRIS) ---

    /** The current track, or null when nothing is loaded or queued. */
    get nowPlaying() {
        const track = this._playlist.current;
        if (!track)
            return null;
        return {
            id: this._loadGeneration,
            uri: track.uri,
            title: this._tags.title ?? track.title,
            artist: this._tags.artist ?? null,
            durationMs: this._durationMs,
        };
    }

    get positionMs() {
        return this._positionMs;
    }

    playPause() {
        this._togglePlayback().catch(e => logError(e, 'Background Music Player'));
    }

    play() {
        if (this._player.state !== 'playing')
            this.playPause();
    }

    pause() {
        if (this._player.state === 'playing')
            this._player.pause();
    }

    stop() {
        if (this._player.state === 'stopped')
            return;
        this._savePosition();
        this._player.stop();
        this._positionMs = 0;
        this._controls.seekBar.setPosition(0);
    }

    next() {
        this._next();
    }

    previous() {
        this._previous();
    }

    seekTo(ms) {
        if (this._player.state === 'stopped')
            return;
        this._seek(Math.max(0, Math.min(ms, this._durationMs)));
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_MIDDLE) {
            this._togglePlayback().catch(e => logError(e, 'Background Music Player'));
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    vfunc_scroll_event(event) {
        return this._volumeRow.scroll(event);
    }

    _buildPlayerSection() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._controls = new PlayerControls();
        item.add_child(this._controls);
        this.menu.addMenuItem(item);

        this._playlist.loopMode = this._settings.get_string('loop-mode');
        this._playlist.setShuffle(this._settings.get_boolean('shuffle'));
        this._controls.setLoopMode(this._playlist.loopMode);
        this._controls.setShuffle(this._playlist.shuffle);

        this._controls.connectObject(
            'play-pause', () => {
                this._togglePlayback().catch(e => logError(e, 'Background Music Player'));
            },
            'previous', () => this._previous(),
            'next', () => this._next(),
            'cycle-loop', () => {
                const i = LOOP_MODES.indexOf(this._playlist.loopMode);
                this._settings.set_string('loop-mode', LOOP_MODES[(i + 1) % LOOP_MODES.length]);
            },
            'toggle-shuffle', () => {
                this._settings.set_boolean('shuffle', !this._playlist.shuffle);
            },
            this);
        this._controls.seekBar.connect('seek', (_bar, ms) => this._seek(ms));

        this._settings.connectObject(
            'changed::loop-mode', () => {
                this._playlist.loopMode = this._settings.get_string('loop-mode');
                this._controls.setLoopMode(this._playlist.loopMode);
            },
            'changed::shuffle', () => {
                this._playlist.setShuffle(this._settings.get_boolean('shuffle'));
                this._controls.setShuffle(this._playlist.shuffle);
            },
            this);
    }

    _connectPlayer() {
        this._player.connectObject(
            'state', (_p, {value}) => {
                this._controls.setPlaying(value === 'playing');
                if (value === 'paused')
                    this._savePosition();
                if (value === 'playing') {
                    this._autoplayGeneration = null;
                    this._consecutiveErrors = 0;
                }
            },
            'duration', (_p, {ms}) => {
                this._durationMs = ms;
                this._controls.seekBar.setDuration(ms);
                this.emit('now-playing-changed');
            },
            'position', (_p, {ms}) => {
                this._positionMs = ms;
                if (this.menu.isOpen)
                    this._controls.seekBar.setPosition(ms);
                if (GLib.get_monotonic_time() - this._lastPositionSave >= POSITION_SAVE_INTERVAL_US)
                    this._savePosition();
            },
            'tags', (_p, {title, artist}) => {
                if (!title)
                    return;
                this._tags = {title, artist};
                this._controls.setTitle(artist ? `${artist} — ${title}` : title);
                this.emit('now-playing-changed');
            },
            'eos', () => this._onEndOfTrack(),
            'error', (_p, {message}) => this._onPlaybackError(message),
            'failed', () => this._controls.setTitle('Player unavailable'),
            this);
    }

    async _togglePlayback() {
        switch (this._player.state) {
        case 'playing':
            this._player.pause();
            return;
        case 'paused':
            this._player.play();
            return;
        }

        if (this._playlist.current) {
            this._playTrack(this._playlist.current);
            return;
        }
        if (!this._settings.get_string('last-track-uri')) {
            this._controls.setTitle('Pick a track from Music List');
            return;
        }
        await this.restoreSession({autoplay: true});
    }

    /** Plays the last track shortly after login (see AUTOPLAY_* above). */
    autoplay() {
        this._autoplayAttempts = 0;
        this._scheduleAutoplay(AUTOPLAY_DELAY_MS);
    }

    _scheduleAutoplay(delayMs) {
        const generation = this._loadGeneration;
        this._autoplaySourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._autoplaySourceId = 0;
            // The user already started something; leave it alone.
            if (generation !== this._loadGeneration)
                return GLib.SOURCE_REMOVE;
            this._autoplayAttempts++;
            this.restoreSession({autoplay: true}).then(loaded => {
                if (loaded)
                    this._autoplayGeneration = this._loadGeneration;
            }).catch(e => logError(e, 'Background Music Player: autoplay failed'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _onPlaybackError(message) {
        // The autoplayed track is retried (the audio server may not be up yet)
        // until it has played once or the attempts run out.
        if (this._autoplayGeneration === this._loadGeneration) {
            this._autoplayGeneration = null;
            if (this._autoplayAttempts < AUTOPLAY_ATTEMPTS) {
                console.log(`Background Music Player: autoplay attempt ${this._autoplayAttempts} failed, retrying`);
                this._scheduleAutoplay(AUTOPLAY_RETRY_MS);
                return;
            }
        }
        // A failed paused preload is not worth a notification or a skip.
        if (!this._lastLoadAutoplay)
            return;
        this._skipBrokenTrack(message);
    }

    _skipBrokenTrack(message) {
        const failed = this._playlist.current;
        Main.notify(`Cannot play “${failed?.title ?? 'track'}”`, errorHint(message));
        this._consecutiveErrors++;
        if (this._consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.warn(`Background Music Player: ${this._consecutiveErrors} tracks failed in a row, stopping`);
            this._consecutiveErrors = 0;
            return;
        }
        const next = this._playlist.next();
        if (next && next.uri !== failed?.uri)
            this._playTrack(next);
    }

    /**
     * Loads the last saved track (at its saved position when `resume-position`
     * is on) and rebuilds the queue around it so next/previous keep working.
     * Without `autoplay` the track is left paused, ready to resume.
     *
     * @returns {Promise<boolean>} whether a track was loaded
     */
    async restoreSession({autoplay = false} = {}) {
        const uri = this._settings.get_string('last-track-uri');
        if (!uri)
            return false;
        const generation = this._loadGeneration;

        if (!await fileExists(Gio.File.new_for_uri(uri))) {
            console.log(`Background Music Player: last track is gone, forgetting it: ${uri}`);
            this._settings.reset('last-track-uri');
            this._settings.reset('last-position-ms');
            this._musicList.setCurrent(null);
            return false;
        }

        let tracks = [];
        try {
            tracks = await scanMusic(getMusicFolder(this._settings), {
                recursive: this._settings.get_boolean('recursive-scan'),
            });
        } catch (e) {
            console.warn(`Background Music Player: cannot restore queue: ${e.message}`);
        }
        // Give up if the extension was disabled or the user picked a track meanwhile.
        if (this._destroyed || generation !== this._loadGeneration)
            return false;

        const index = tracks.findIndex(t => t.uri === uri);
        if (index >= 0)
            this._playlist.setQueue(tracks, index);
        else
            this._playlist.setQueue([{uri, title: Gio.File.new_for_uri(uri).get_basename()}], 0);

        const startMs = this._settings.get_boolean('resume-position')
            ? Number(this._settings.get_int64('last-position-ms')) : 0;
        this._playTrack(this._playlist.current, {autoplay, startMs});
        return true;
    }

    _savePosition() {
        if (!this._playlist.current)
            return;
        this._lastPositionSave = GLib.get_monotonic_time();
        this._settings.set_int64('last-position-ms', Math.floor(this._positionMs));
    }

    _previous() {
        const active = this._player.state !== 'stopped';
        if (active && this._positionMs > RESTART_THRESHOLD_MS) {
            this._seek(0);
            return;
        }
        const track = this._playlist.previous();
        if (track)
            this._playTrack(track);
    }

    _next() {
        const track = this._playlist.next();
        if (track)
            this._playTrack(track);
    }

    _onEndOfTrack() {
        const track = this._playlist.next({auto: true});
        if (track) {
            this._playTrack(track);
        } else {
            this._positionMs = 0;
            this._controls.seekBar.setPosition(0);
            this._savePosition();
        }
    }

    _seek(ms) {
        this._player.seek(ms);
        this._positionMs = ms;
        this._savePosition();
        this.emit('seeked', ms);
    }

    _playTrack(track, {autoplay = true, startMs = 0} = {}) {
        this._loadGeneration++;
        this._lastLoadAutoplay = autoplay;
        this._tags = {};
        this._positionMs = startMs;
        this._durationMs = 0;
        this._controls.seekBar.reset();
        this._controls.seekBar.setPosition(startMs);
        this._controls.setTitle(track.title);
        this._musicList.setCurrent(track.uri);
        this._settings.set_string('last-track-uri', track.uri);
        this._savePosition();
        this._player.load(track.uri, {autoplay, startMs});
        this.emit('now-playing-changed');
    }

    _buildVolumeRow() {
        this._volumeRow = new VolumeRow(this._settings, this._player);
        this.menu.addMenuItem(this._volumeRow);
    }

    _buildMusicList() {
        this._musicList = new MusicList(this._settings);
        this._musicList.setCurrent(this._settings.get_string('last-track-uri') || null);
        this._musicList.connect('track-activated', (_list, index) => {
            this._playlist.setQueue(this._musicList.tracks, index);
            this._playTrack(this._playlist.current);
        });
        this.menu.addMenuItem(this._musicList);
    }

    _buildAutoplaySwitch() {
        this._autoplaySwitch = new PopupMenu.PopupSwitchMenuItem(
            'Autoplay on login', this._settings.get_boolean('autoplay'));
        this._autoplaySwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean('autoplay', state);
        });
        this._settings.connectObject('changed::autoplay', () => {
            this._autoplaySwitch.setToggleState(this._settings.get_boolean('autoplay'));
        }, this);
        this.menu.addMenuItem(this._autoplaySwitch);
    }

    _buildSettingsItem() {
        const item = new PopupMenu.PopupMenuItem('Settings…');
        item.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(item);
    }
});
