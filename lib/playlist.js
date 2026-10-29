export const LOOP_MODES = ['none', 'all', 'one'];

function shuffled(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * The queue of tracks and the rules for moving through it.
 *
 * `_order` is the play order as indices into `tracks` (identity, or shuffled
 * with the current track first) and `_pos` is the position in that order.
 */
export class Playlist {
    constructor({loopMode = 'none', shuffle = false} = {}) {
        this.tracks = [];
        this.loopMode = loopMode;
        this.shuffle = shuffle;
        this._order = [];
        this._pos = -1;
    }

    setQueue(tracks, index) {
        this.tracks = [...tracks];
        this._rebuildOrder(index);
    }

    get index() {
        return this._order[this._pos] ?? -1;
    }

    get current() {
        return this.tracks[this.index] ?? null;
    }

    setShuffle(shuffle) {
        this.shuffle = shuffle;
        this._rebuildOrder(this.index);
    }

    /** Advances to the next track and returns it, or null at the end of the queue. */
    next({auto = false} = {}) {
        if (this.tracks.length === 0)
            return null;
        if (auto && this.loopMode === 'one')
            return this.current;
        if (this._pos + 1 < this._order.length) {
            this._pos++;
        } else if (this.loopMode === 'all' || (this.loopMode === 'one' && !auto)) {
            if (this.shuffle)
                this._order = shuffled(this._order);
            this._pos = 0;
        } else {
            return null;
        }
        return this.current;
    }

    /** Moves to the previous track (wrapping when looping) and returns it. */
    previous() {
        if (this.tracks.length === 0)
            return null;
        if (this._pos > 0)
            this._pos--;
        else if (this.loopMode !== 'none')
            this._pos = this._order.length - 1;
        return this.current;
    }

    _rebuildOrder(currentIndex) {
        const indices = this.tracks.map((_t, i) => i);
        if (currentIndex < 0 || currentIndex >= indices.length) {
            this._order = this.shuffle ? shuffled(indices) : indices;
            this._pos = indices.length > 0 ? 0 : -1;
        } else if (this.shuffle) {
            const rest = indices.filter(i => i !== currentIndex);
            this._order = [currentIndex, ...shuffled(rest)];
            this._pos = 0;
        } else {
            this._order = indices;
            this._pos = currentIndex;
        }
    }
}
