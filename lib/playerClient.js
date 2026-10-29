import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const RESTART_DELAYS_MS = [1000, 2000, 5000];
// A daemon that stayed up this long is considered healthy again.
const STABLE_RUN_MS = 30000;
const QUIT_GRACE_MS = 1000;

const encoder = new TextEncoder();

/**
 * Spawns daemon/player-daemon.js and talks to it with line-delimited JSON.
 *
 * Commands: load(uri, opts), play(), pause(), stop(), seek(ms), setVolume(v).
 * Signals: 'ready', 'state', 'duration', 'position', 'tags', 'eos', 'error'
 * (each with the daemon's event object), plus 'failed' when restarts are
 * exhausted.
 */
export class PlayerClient extends EventEmitter {
    constructor(daemonPath) {
        super();
        this._daemonPath = daemonPath;
        this._restartCount = 0;
        this._restartSourceId = 0;
        this._writeQueue = [];
        this._writing = false;
        this._destroyed = false;
        this.state = 'stopped';
        this._spawn();
    }

    load(uri, {autoplay = true, startMs = 0} = {}) {
        this._send({cmd: 'load', uri, autoplay, startMs});
    }

    play() {
        this._send({cmd: 'play'});
    }

    pause() {
        this._send({cmd: 'pause'});
    }

    stop() {
        this._send({cmd: 'stop'});
    }

    seek(ms) {
        this._send({cmd: 'seek', ms});
    }

    setVolume(value) {
        this._send({cmd: 'volume', value});
    }

    destroy() {
        this._destroyed = true;
        if (this._restartSourceId) {
            GLib.source_remove(this._restartSourceId);
            this._restartSourceId = 0;
        }
        this._cancellable?.cancel();

        const proc = this._proc;
        const stdin = this._stdin;
        this._proc = null;
        this._stdin = null;
        this._writeQueue = [];
        if (!proc)
            return;

        // Ask nicely, then close stdin (the daemon also quits on EOF),
        // and kill it if it is still around after a grace period.
        try {
            stdin.write_all(encoder.encode('{"cmd":"quit"}\n'), null);
            stdin.close(null);
        } catch {
            // Daemon already gone.
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIT_GRACE_MS, () => {
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _spawn() {
        const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
        try {
            this._proc = Gio.Subprocess.new([gjs, '-m', this._daemonPath],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            console.error(`Background Music Player: cannot start player daemon: ${e.message}`);
            this._scheduleRestart();
            return;
        }
        this._spawnTime = GLib.get_monotonic_time();
        this._cancellable = new Gio.Cancellable();
        this._stdin = this._proc.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readNextLine(this._stdout, this._cancellable);
        this._proc.wait_async(this._cancellable, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch {
                return; // Cancelled by destroy().
            }
            this._onDaemonExit(proc);
        });
    }

    _onDaemonExit(proc) {
        if (this._destroyed || proc !== this._proc)
            return;
        console.warn(`Background Music Player: player daemon exited (status ${proc.get_status()})`);
        this._proc = null;
        this._stdin = null;
        this._writeQueue = [];
        this._writing = false;
        this._cancellable.cancel();
        this._setState('stopped');

        const ranMs = (GLib.get_monotonic_time() - this._spawnTime) / 1000;
        if (ranMs >= STABLE_RUN_MS)
            this._restartCount = 0;
        this._scheduleRestart();
    }

    _scheduleRestart() {
        if (this._restartCount >= RESTART_DELAYS_MS.length) {
            console.error('Background Music Player: player daemon keeps crashing, giving up');
            this.emit('failed');
            return;
        }
        const delay = RESTART_DELAYS_MS[this._restartCount++];
        this._restartSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartSourceId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readNextLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`Background Music Player: daemon read failed: ${e.message}`);
                return;
            }
            if (line === null)
                return; // EOF; exit is handled by wait_async.
            this._handleLine(line);
            this._readNextLine(stream, cancellable);
        });
    }

    _handleLine(line) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            console.warn(`Background Music Player: bad daemon output: ${line}`);
            return;
        }
        if (event.ev === 'state') {
            this._setState(event.value);
            return;
        }
        if (event.ev === 'error')
            console.warn(`Background Music Player: ${event.message}`);
        this.emit(event.ev, event);
    }

    _setState(state) {
        if (this.state === state)
            return;
        this.state = state;
        this.emit('state', {ev: 'state', value: state});
    }

    _send(message) {
        if (!this._stdin)
            return;
        this._writeQueue.push(encoder.encode(`${JSON.stringify(message)}\n`));
        this._flush();
    }

    // Gio allows one pending write per stream, so writes are serialized.
    _flush() {
        if (this._writing || !this._stdin || this._writeQueue.length === 0)
            return;
        this._writing = true;
        const stdin = this._stdin;
        const bytes = new GLib.Bytes(this._writeQueue.shift());
        stdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (_s, result) => {
            try {
                stdin.write_bytes_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Background Music Player: daemon write failed: ${e.message}`);
            }
            if (stdin !== this._stdin)
                return;
            this._writing = false;
            this._flush();
        });
    }
}
