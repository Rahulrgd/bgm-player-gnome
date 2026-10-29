import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// MPRIS lets GNOME's media controls (the player card in the notification
// list), the keyboard media keys and tools like playerctl drive the player.
// https://specifications.freedesktop.org/mpris-spec/latest/

const BUS_NAME = 'org.mpris.MediaPlayer2.BackgroundMusicPlayer';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const TRACK_PATH = '/org/gnome/shell/extensions/BackgroundMusicPlayer/Track';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
const US_PER_MS = 1000;

const ROOT_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <method name="OpenUri"><arg direction="in" name="Uri" type="s"/></method>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const LOOP_TO_MPRIS = {none: 'None', one: 'Track', all: 'Playlist'};
const LOOP_FROM_MPRIS = {None: 'none', Track: 'one', Playlist: 'all'};
const PLAYBACK_STATUS = {playing: 'Playing', paused: 'Paused', stopped: 'Stopped'};

// Properties that depend on the current track, re-sent together.
const TRACK_PROPS = ['Metadata', 'CanGoNext', 'CanGoPrevious', 'CanPlay', 'CanPause', 'CanSeek'];
const PROP_TYPES = {
    PlaybackStatus: 's', LoopStatus: 's', Shuffle: 'b', Volume: 'd',
    Metadata: 'a{sv}', CanGoNext: 'b', CanGoPrevious: 'b', CanPlay: 'b',
    CanPause: 'b', CanSeek: 'b',
};

class RootImpl {
    Raise() {}
    Quit() {}
    get CanQuit() {
        return false;
    }

    get CanRaise() {
        return false;
    }

    get HasTrackList() {
        return false;
    }

    get Identity() {
        return 'Background Music Player';
    }

    // Opening arbitrary URIs is not supported; tracks come from the music folder.
    get SupportedUriSchemes() {
        return [];
    }

    get SupportedMimeTypes() {
        return [];
    }
}

class PlayerImpl {
    constructor(indicator, player, settings) {
        this._indicator = indicator;
        this._player = player;
        this._settings = settings;
    }

    Next() {
        this._indicator.next();
    }

    Previous() {
        this._indicator.previous();
    }

    Pause() {
        this._indicator.pause();
    }

    PlayPause() {
        this._indicator.playPause();
    }

    Stop() {
        this._indicator.stop();
    }

    Play() {
        this._indicator.play();
    }

    Seek(offsetUs) {
        const track = this._indicator.nowPlaying;
        if (!track)
            return;
        const target = this._indicator.positionMs + offsetUs / US_PER_MS;
        // Per spec, seeking past the end acts like Next.
        if (track.durationMs > 0 && target > track.durationMs)
            this._indicator.next();
        else
            this._indicator.seekTo(Math.max(0, target));
    }

    SetPosition(trackId, positionUs) {
        const track = this._indicator.nowPlaying;
        if (!track || trackId !== trackPath(track))
            return;
        const ms = positionUs / US_PER_MS;
        if (ms < 0 || (track.durationMs > 0 && ms > track.durationMs))
            return;
        this._indicator.seekTo(ms);
    }

    OpenUri(_uri) {}

    get PlaybackStatus() {
        return PLAYBACK_STATUS[this._player.state] ?? 'Stopped';
    }

    get LoopStatus() {
        return LOOP_TO_MPRIS[this._settings.get_string('loop-mode')] ?? 'None';
    }

    set LoopStatus(value) {
        if (value in LOOP_FROM_MPRIS)
            this._settings.set_string('loop-mode', LOOP_FROM_MPRIS[value]);
    }

    get Rate() {
        return 1.0;
    }

    set Rate(_value) {
        // Only normal speed is supported (MinimumRate = MaximumRate = 1).
    }

    get Shuffle() {
        return this._settings.get_boolean('shuffle');
    }

    set Shuffle(value) {
        this._settings.set_boolean('shuffle', value);
    }

    get Metadata() {
        const track = this._indicator.nowPlaying;
        if (!track)
            return {'mpris:trackid': new GLib.Variant('o', NO_TRACK)};
        const metadata = {
            'mpris:trackid': new GLib.Variant('o', trackPath(track)),
            'xesam:title': new GLib.Variant('s', track.title),
            'xesam:url': new GLib.Variant('s', track.uri),
        };
        if (track.artist)
            metadata['xesam:artist'] = new GLib.Variant('as', [track.artist]);
        if (track.durationMs > 0)
            metadata['mpris:length'] = new GLib.Variant('x', Math.round(track.durationMs * US_PER_MS));
        return metadata;
    }

    get Volume() {
        return this._settings.get_boolean('muted') ? 0 : this._settings.get_double('volume');
    }

    set Volume(value) {
        this._settings.set_boolean('muted', false);
        this._settings.set_double('volume', Math.min(1, Math.max(0, value)));
    }

    get Position() {
        return Math.round(this._indicator.positionMs * US_PER_MS);
    }

    get MinimumRate() {
        return 1.0;
    }

    get MaximumRate() {
        return 1.0;
    }

    get CanGoNext() {
        return this._indicator.nowPlaying !== null;
    }

    get CanGoPrevious() {
        return this._indicator.nowPlaying !== null;
    }

    get CanPlay() {
        return this._indicator.nowPlaying !== null;
    }

    get CanPause() {
        return this._indicator.nowPlaying !== null;
    }

    get CanSeek() {
        return (this._indicator.nowPlaying?.durationMs ?? 0) > 0;
    }

    get CanControl() {
        return true;
    }
}

function trackPath(track) {
    return `${TRACK_PATH}/${track.id}`;
}

/** Exports the player on the session bus for as long as it exists. */
export class Mpris {
    constructor(indicator, player, settings) {
        this._impl = new PlayerImpl(indicator, player, settings);
        this._root = Gio.DBusExportedObject.wrapJSObject(ROOT_IFACE, new RootImpl());
        this._playerObject = Gio.DBusExportedObject.wrapJSObject(PLAYER_IFACE, this._impl);
        this._root.export(Gio.DBus.session, OBJECT_PATH);
        this._playerObject.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
            null, null);

        player.connectObject('state', () => this._notify('PlaybackStatus'), this);
        indicator.connectObject(
            'now-playing-changed', () => this._notify(...TRACK_PROPS),
            'seeked', (_indicator, ms) => {
                this._playerObject.emit_signal('Seeked',
                    new GLib.Variant('(x)', [Math.round(ms * US_PER_MS)]));
            },
            this);
        settings.connectObject(
            'changed::loop-mode', () => this._notify('LoopStatus'),
            'changed::shuffle', () => this._notify('Shuffle'),
            'changed::volume', () => this._notify('Volume'),
            'changed::muted', () => this._notify('Volume'),
            this);
        this._disconnectables = [player, indicator, settings];
    }

    _notify(...names) {
        for (const name of names)
            this._playerObject.emit_property_changed(name, new GLib.Variant(PROP_TYPES[name], this._impl[name]));
    }

    destroy() {
        for (const object of this._disconnectables)
            object.disconnectObject(this);
        this._disconnectables = [];
        Gio.bus_unown_name(this._nameId);
        this._playerObject.unexport();
        this._root.unexport();
    }
}
