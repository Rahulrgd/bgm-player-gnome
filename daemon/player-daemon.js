// Playback engine for Background Music Player.
// Runs as a separate process (gjs -m) so a GStreamer crash cannot take down
// gnome-shell. Protocol: one JSON object per line.
//   stdin  (commands): load, play, pause, stop, seek, volume, quit
//   stdout (events):   ready, state, duration, position, tags, eos, error
// The process exits when stdin reaches EOF.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gst from 'gi://Gst?version=1.0';

const POSITION_INTERVAL_MS = 500;
const NS_PER_MS = 1000000;

Gst.init(null);

const loop = new GLib.MainLoop(null, false);
const playbin = Gst.ElementFactory.make('playbin', 'player');
if (!playbin) {
    emit({ev: 'error', message: 'GStreamer playbin element is not available'});
    throw new Error('playbin missing');
}
// Audio-only player: never open a window for files with a video stream.
playbin.set_property('video-sink', Gst.ElementFactory.make('fakesink', null));

// playbin's own 'uri' property is cleared once playback starts, so track it here.
let currentUri = null;
let pendingLoad = null;
let lastState = null;
// A flushing seek briefly drops the pipeline to PAUSED; don't report that.
let seeking = false;
let positionSourceId = 0;

function emit(event) {
    print(JSON.stringify(event));
}

function emitState(state) {
    if (state === lastState)
        return;
    lastState = state;
    emit({ev: 'state', value: state});
    if (state === 'playing')
        startPositionTimer();
    else
        stopPositionTimer();
}

function queryPositionMs() {
    const [ok, position] = playbin.query_position(Gst.Format.TIME);
    return ok ? Math.floor(position / NS_PER_MS) : null;
}

function emitDuration() {
    const [ok, duration] = playbin.query_duration(Gst.Format.TIME);
    if (ok && duration > 0)
        emit({ev: 'duration', ms: Math.floor(duration / NS_PER_MS)});
}

function startPositionTimer() {
    if (positionSourceId)
        return;
    positionSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_INTERVAL_MS, () => {
        const ms = queryPositionMs();
        if (ms !== null)
            emit({ev: 'position', ms});
        return GLib.SOURCE_CONTINUE;
    });
}

function stopPositionTimer() {
    if (positionSourceId) {
        GLib.source_remove(positionSourceId);
        positionSourceId = 0;
    }
}

function seekMs(ms) {
    seeking = playbin.seek_simple(Gst.Format.TIME,
        Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, Math.max(0, ms) * NS_PER_MS);
}

function stop() {
    pendingLoad = null;
    seeking = false;
    playbin.set_state(Gst.State.NULL);
    emitState('stopped');
}

const commands = {
    load({uri, autoplay = true, startMs = 0}) {
        if (typeof uri !== 'string' || !uri)
            throw new Error('load: missing uri');
        stop();
        playbin.uri = uri;
        currentUri = uri;
        // Preroll in PAUSED first so the start position can be applied
        // before any audio is heard; see ASYNC_DONE handling.
        pendingLoad = {autoplay, startMs};
        playbin.set_state(Gst.State.PAUSED);
    },
    play() {
        if (currentUri)
            playbin.set_state(Gst.State.PLAYING);
    },
    pause() {
        if (!currentUri)
            return;
        // An explicit pause must be reported even in the middle of a seek.
        seeking = false;
        playbin.set_state(Gst.State.PAUSED);
    },
    stop,
    seek({ms}) {
        if (lastState === 'playing' || lastState === 'paused')
            seekMs(Number(ms) || 0);
    },
    // `value` is the perceptual slider position (0..1). Cubing it matches
    // GstStreamVolume's CUBIC format, so equal slider steps sound equal.
    volume({value}) {
        const cubic = Math.min(1, Math.max(0, Number(value) || 0));
        playbin.volume = cubic ** 3;
    },
    quit() {
        stop();
        loop.quit();
    },
};

function handleCommand(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        emit({ev: 'error', message: `invalid JSON: ${line}`});
        return;
    }
    const handler = commands[message.cmd];
    if (!handler) {
        emit({ev: 'error', message: `unknown command: ${message.cmd}`});
        return;
    }
    try {
        handler(message);
    } catch (e) {
        emit({ev: 'error', message: e.message});
    }
}

function onBusMessage(_bus, message) {
    switch (message.type) {
    case Gst.MessageType.EOS:
        stop();
        emit({ev: 'eos'});
        break;
    case Gst.MessageType.ERROR: {
        const [error, debug] = message.parse_error();
        printerr(`player-daemon: ${error.message}\n${debug ?? ''}`);
        stop();
        emit({ev: 'error', message: error.message});
        break;
    }
    case Gst.MessageType.STATE_CHANGED: {
        if (message.src !== playbin)
            break;
        const [, newState] = message.parse_state_changed();
        if (newState === Gst.State.PLAYING) {
            pendingLoad = null;
            emitState('playing');
        } else if (newState === Gst.State.PAUSED && !pendingLoad && !seeking) {
            emitState('paused');
        }
        break;
    }
    case Gst.MessageType.ASYNC_DONE:
        seeking = false;
        // Keep pendingLoad set until PLAYING is reached so the intermediate
        // PAUSED states of preroll and the start seek are not reported.
        if (pendingLoad && !pendingLoad.prerolled) {
            const {autoplay, startMs} = pendingLoad;
            pendingLoad.prerolled = true;
            emitDuration();
            if (startMs > 0)
                seekMs(startMs);
            if (autoplay) {
                playbin.set_state(Gst.State.PLAYING);
            } else {
                pendingLoad = null;
                emitState('paused');
            }
        }
        break;
    case Gst.MessageType.DURATION_CHANGED:
        emitDuration();
        break;
    case Gst.MessageType.TAG: {
        const tags = message.parse_tag();
        const [, title] = tags.get_string(Gst.TAG_TITLE);
        const [, artist] = tags.get_string(Gst.TAG_ARTIST);
        if (title || artist)
            emit({ev: 'tags', title: title ?? null, artist: artist ?? null});
        break;
    }
    }
}

const bus = playbin.get_bus();
bus.add_signal_watch();
bus.connect('message', onBusMessage);

const stdin = new Gio.DataInputStream({
    base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
});

function readNextLine() {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        let line;
        try {
            [line] = stream.read_line_finish_utf8(result);
        } catch (e) {
            printerr(`player-daemon: stdin read failed: ${e.message}`);
            line = null;
        }
        if (line === null) {
            commands.quit();
            return;
        }
        if (line.trim())
            handleCommand(line);
        readNextLine();
    });
}

readNextLine();
emit({ev: 'ready'});
loop.run();
