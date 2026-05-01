import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface LogStoreState {
    total: number;
    firstAvailable: number;
    partial: string;
}

export interface RangeResult {
    from: number;
    lines: string[];
}

export interface MatchesResult {
    matches: number[];
    visible: number[];
}

export const RAM_TAIL = 5000;
export const MAX_LINES = 1_000_000;
export const RANGE_CHUNK = 256;
const FLUSH_THRESHOLD = 64 * 1024;
const SCAN_STEP = 8192;

const ANSI_RE =
    /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

interface PatternCache {
    pattern: string;
    matches: number[];
    scannedUpTo: number;
}

export class LogStore {
    private filePath: string;
    private fh: fsp.FileHandle | null = null;
    private writeChain: Promise<void> = Promise.resolve();

    private flushedOffset = 0;
    private writeOffset = 0;
    private pending: Buffer[] = [];
    private pendingBytes = 0;

    private offsets: number[] = [];
    private firstAvailable = 0;
    private total = 0;

    private ramLines: string[] = [];
    private tailStart = 0;

    private buffer = '';

    private patternCache: PatternCache | null = null;

    constructor() {
        this.filePath = path.join(
            os.tmpdir(),
            `debug-console-grep-${process.pid}-${Date.now()}.log`,
        );
    }

    private async ensureOpen(): Promise<fsp.FileHandle> {
        if (!this.fh) {
            this.fh = await fsp.open(this.filePath, 'w+');
        }
        return this.fh;
    }

    appendOutput(text: string): boolean {
        this.buffer += text;
        const parts = this.buffer.split(/\r?\n/);
        this.buffer = parts.pop() ?? '';
        if (parts.length === 0) {
            return false;
        }
        for (const raw of parts) {
            this.appendLine(stripAnsi(raw));
        }
        return true;
    }

    private appendLine(line: string) {
        const data = Buffer.from(line + '\n', 'utf8');
        this.offsets.push(this.writeOffset);
        this.writeOffset += data.length;
        this.pending.push(data);
        this.pendingBytes += data.length;
        if (this.pendingBytes >= FLUSH_THRESHOLD) {
            this.scheduleFlush();
        }

        this.ramLines.push(line);
        if (this.ramLines.length > RAM_TAIL) {
            const drop = this.ramLines.length - RAM_TAIL;
            this.ramLines.splice(0, drop);
            this.tailStart += drop;
        }
        this.total++;

        const overflow = this.total - this.firstAvailable - MAX_LINES;
        if (overflow > 0) {
            this.firstAvailable += overflow;
            this.offsets.splice(0, overflow);
            this.trimPatternCacheFront();
        }
    }

    private trimPatternCacheFront() {
        const cache = this.patternCache;
        if (!cache) {
            return;
        }
        let cut = 0;
        while (
            cut < cache.matches.length &&
            cache.matches[cut] < this.firstAvailable
        ) {
            cut++;
        }
        if (cut > 0) {
            cache.matches.splice(0, cut);
        }
    }

    private scheduleFlush() {
        if (this.pendingBytes === 0) {
            return;
        }
        const merged = Buffer.concat(this.pending, this.pendingBytes);
        this.pending = [];
        this.pendingBytes = 0;
        const off = this.flushedOffset;
        this.flushedOffset += merged.length;
        this.writeChain = this.writeChain.then(async () => {
            const fh = await this.ensureOpen();
            await fh.write(merged, 0, merged.length, off);
        });
    }

    async drain(): Promise<void> {
        this.scheduleFlush();
        await this.writeChain;
    }

    getState(): LogStoreState {
        return {
            total: this.total,
            firstAvailable: this.firstAvailable,
            partial: stripAnsi(this.buffer),
        };
    }

    async getRange(reqFrom: number, reqTo: number): Promise<RangeResult> {
        const span = Math.max(0, reqTo - reqFrom);
        const lines: string[] = new Array(span).fill('');
        if (span === 0) {
            return { from: reqFrom, lines };
        }

        const from = Math.max(reqFrom, this.firstAvailable);
        const to = Math.min(reqTo, this.total);
        if (from >= to) {
            return { from: reqFrom, lines };
        }

        const diskTo = Math.min(to, this.tailStart);

        if (from < diskTo) {
            await this.drain();
            const fh = await this.ensureOpen();
            const startIdx = from - this.firstAvailable;
            const endIdx = diskTo - this.firstAvailable;
            const startOff = this.offsets[startIdx];
            const endOff =
                endIdx < this.offsets.length
                    ? this.offsets[endIdx]
                    : this.flushedOffset;
            const len = endOff - startOff;
            if (len > 0) {
                const buf = Buffer.alloc(len);
                await fh.read(buf, 0, len, startOff);
                const text = buf.toString('utf8');
                let cursor = 0;
                const need = diskTo - from;
                for (let i = 0; i < need; i++) {
                    const slot = from + i - reqFrom;
                    const nl = text.indexOf('\n', cursor);
                    if (nl < 0) {
                        lines[slot] = text.substring(cursor);
                        break;
                    }
                    lines[slot] = text.substring(cursor, nl);
                    cursor = nl + 1;
                }
            }
        }

        const ramFrom = Math.max(from, this.tailStart);
        for (let i = ramFrom; i < to; i++) {
            lines[i - reqFrom] = this.ramLines[i - this.tailStart] ?? '';
        }

        return { from: reqFrom, lines };
    }

    async findMatches(
        pattern: string,
        before: number,
        after: number,
    ): Promise<MatchesResult> {
        let re: RegExp;
        try {
            re = new RegExp(pattern, 'i');
        } catch {
            return { matches: [], visible: [] };
        }

        let matches: number[];
        if (this.patternCache && this.patternCache.pattern === pattern) {
            this.trimPatternCacheFront();
            const cache = this.patternCache;
            const start = Math.max(cache.scannedUpTo, this.firstAvailable);
            await this.scanInto(re, start, this.total, cache.matches);
            cache.scannedUpTo = this.total;
            matches = cache.matches;
        } else {
            matches = [];
            await this.scanInto(re, this.firstAvailable, this.total, matches);
            this.patternCache = {
                pattern,
                matches,
                scannedUpTo: this.total,
            };
        }

        const visible = this.buildVisible(matches, before, after);
        return { matches: matches.slice(), visible };
    }

    private async scanInto(
        re: RegExp,
        from: number,
        to: number,
        out: number[],
    ): Promise<void> {
        if (from >= to) {
            return;
        }
        for (let s = from; s < to; s += SCAN_STEP) {
            const e = Math.min(s + SCAN_STEP, to);
            const { lines } = await this.getRange(s, e);
            for (let j = 0; j < lines.length; j++) {
                const i = s + j;
                if (i < this.firstAvailable || i >= this.total) {
                    continue;
                }
                if (re.test(lines[j])) {
                    out.push(i);
                }
            }
        }
    }

    private buildVisible(
        matches: number[],
        before: number,
        after: number,
    ): number[] {
        if (matches.length === 0) {
            return [];
        }
        const result: number[] = [];
        let cursor = -1;
        for (const m of matches) {
            const lo = Math.max(this.firstAvailable, m - before, cursor + 1);
            const hi = Math.min(this.total - 1, m + after);
            for (let k = lo; k <= hi; k++) {
                result.push(k);
            }
            cursor = Math.max(cursor, hi);
        }
        return result;
    }

    async clear(): Promise<void> {
        try {
            await this.writeChain;
        } catch {
            // ignore
        }
        if (this.fh) {
            try {
                await this.fh.truncate(0);
            } catch {
                // ignore
            }
        }
        this.flushedOffset = 0;
        this.writeOffset = 0;
        this.pending = [];
        this.pendingBytes = 0;
        this.offsets = [];
        this.firstAvailable = 0;
        this.total = 0;
        this.ramLines = [];
        this.tailStart = 0;
        this.buffer = '';
        this.patternCache = null;
    }

    async dispose(): Promise<void> {
        try {
            await this.writeChain;
        } catch {
            // ignore
        }
        if (this.fh) {
            try {
                await this.fh.close();
            } catch {
                // ignore
            }
            this.fh = null;
        }
        try {
            await fsp.unlink(this.filePath);
        } catch {
            // ignore
        }
    }
}
