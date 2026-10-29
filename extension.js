import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './lib/indicator.js';
import {Mpris} from './lib/mpris.js';
import {PlayerClient} from './lib/playerClient.js';
import {Playlist} from './lib/playlist.js';

// Playback kept alive across a temporary disable on the lock screen; see disable().
let parked = null;
// A parked player that is not picked up again by then is shut down.
const PARK_TIMEOUT_MS = 10000;

function park(session) {
    parked = session;
    parked.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PARK_TIMEOUT_MS, () => {
        parked.player.destroy();
        parked = null;
        return GLib.SOURCE_REMOVE;
    });
}

function unpark() {
    if (!parked)
        return null;
    GLib.source_remove(parked.timeoutId);
    const session = parked;
    parked = null;
    return session;
}

export default class BackgroundMusicPlayerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const session = unpark();
        this._player = session?.player ?? new PlayerClient(`${this.path}/daemon/player-daemon.js`);
        this._playlist = session?.playlist ?? new Playlist();
        this._indicator = new Indicator(this._settings, this._player, this._playlist, {
            name: this.metadata.name,
            openPreferences: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._indicator.syncSessionMode();
        this._mpris = new Mpris(this._indicator, this._player, this._settings);

        if (session) {
            this._indicator.adopt(session.snapshot);
            return;
        }

        // Extensions are enabled while the shell is still starting up at login;
        // a manual enable happens later and must not autoplay.
        if (Main.layoutManager._startingUp) {
            this._startupId = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startupId);
                this._startupId = 0;
                this._startSession(true);
            });
        } else {
            this._startSession(false);
        }
    }

    _startSession(atLogin) {
        if (atLogin && this._settings.get_boolean('autoplay')) {
            this._indicator.autoplay();
        } else {
            this._indicator.restoreSession()
                .catch(e => logError(e, 'Background Music Player: restore failed'));
        }
    }

    disable() {
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
            this._startupId = 0;
        }

        // When the screen locks, GNOME disables the extensions that do not
        // support the lock screen and, to keep their order, also disables and
        // re-enables every extension enabled after them, this one included.
        // Keep the music playing through that cycle.
        const keepPlaying = Main.sessionMode.isLocked && this._player.state !== 'stopped';
        if (keepPlaying) {
            park({
                player: this._player,
                playlist: this._playlist,
                snapshot: this._indicator.snapshot(),
            });
        }

        this._mpris.destroy();
        this._mpris = null;
        this._indicator.destroy();
        this._indicator = null;
        if (!keepPlaying)
            this._player.destroy();
        this._player = null;
        this._playlist = null;
        this._settings = null;
    }
}
