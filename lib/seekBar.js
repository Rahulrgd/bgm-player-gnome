import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

export function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Position slider with "elapsed / duration" labels.
 * Emits 'seek' (ms) when the user drags, clicks, scrolls or uses the keyboard.
 */
export const SeekBar = GObject.registerClass({
    Signals: {'seek': {param_types: [GObject.TYPE_DOUBLE]}},
}, class SeekBar extends St.BoxLayout {
    _init() {
        super._init({style_class: 'bmp-seek-row', x_expand: true});
        this._durationMs = 0;
        this._dragging = false;
        this._updating = false;

        this._positionLabel = new St.Label({
            text: formatTime(0),
            style_class: 'bmp-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = 'Seek';
        this._durationLabel = new St.Label({
            text: formatTime(0),
            style_class: 'bmp-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._positionLabel);
        this.add_child(this._slider);
        this.add_child(this._durationLabel);

        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._emitSeek();
        });
        this._slider.connect('notify::value', () => {
            if (this._dragging)
                this._positionLabel.text = formatTime(this._slider.value * this._durationMs);
            else if (!this._updating)
                this._emitSeek(); // scroll or arrow keys
        });

        this.setDuration(0);
    }

    setDuration(ms) {
        this._durationMs = ms;
        this._durationLabel.text = formatTime(ms);
        this._slider.reactive = ms > 0;
    }

    /** Ignored while the user is dragging, so the handle does not jump back. */
    setPosition(ms) {
        if (this._dragging)
            return;
        this._positionLabel.text = formatTime(ms);
        this._updating = true;
        this._slider.value = this._durationMs > 0 ? Math.min(1, ms / this._durationMs) : 0;
        this._updating = false;
    }

    reset() {
        this.setDuration(0);
        this.setPosition(0);
    }

    _emitSeek() {
        if (this._durationMs > 0)
            this.emit('seek', this._slider.value * this._durationMs);
    }
});
