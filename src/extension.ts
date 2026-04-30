import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RAM_TAIL = 5000;
const MAX_LINES = 1_000_000;
const RANGE_CHUNK = 256;
const FLUSH_THRESHOLD = 64 * 1024;

const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

class LogStore {
    private filePath: string;
    private fd: number;
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

    constructor() {
        this.filePath = path.join(
            os.tmpdir(),
            `debug-console-grep-${process.pid}-${Date.now()}.log`
        );
        this.fd = fs.openSync(this.filePath, 'w+');
    }

    appendOutput(text: string): boolean {
        this.buffer += text;
        const parts = this.buffer.split(/\r?\n/);
        this.buffer = parts.pop() || '';
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
            this.flush();
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
        }
    }

    private flush() {
        if (this.pendingBytes === 0) {
            return;
        }
        const merged = Buffer.concat(this.pending, this.pendingBytes);
        this.pending = [];
        this.pendingBytes = 0;
        fs.writeSync(this.fd, merged, 0, merged.length, this.flushedOffset);
        this.flushedOffset += merged.length;
    }

    getState() {
        return {
            total: this.total,
            firstAvailable: this.firstAvailable,
            partial: stripAnsi(this.buffer),
        };
    }

    getRange(from: number, to: number): { from: number; lines: string[] } {
        from = Math.max(from, this.firstAvailable);
        to = Math.min(to, this.total);
        if (from >= to) {
            return { from, lines: [] };
        }

        const result: string[] = [];
        const diskTo = Math.min(to, this.tailStart);

        if (from < diskTo) {
            this.flush();
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
                fs.readSync(this.fd, buf, 0, len, startOff);
                const text = buf.toString('utf8');
                let cursor = 0;
                const need = diskTo - from;
                for (let i = 0; i < need; i++) {
                    const nl = text.indexOf('\n', cursor);
                    if (nl < 0) {
                        result.push(text.substring(cursor));
                        cursor = text.length;
                        break;
                    }
                    result.push(text.substring(cursor, nl));
                    cursor = nl + 1;
                }
            }
        }

        const ramFrom = Math.max(from, this.tailStart);
        for (let i = ramFrom; i < to; i++) {
            result.push(this.ramLines[i - this.tailStart] ?? '');
        }
        return { from, lines: result };
    }

    findMatches(
        pattern: string,
        before: number,
        after: number
    ): { matches: number[]; visible: number[] } {
        let re: RegExp;
        try {
            re = new RegExp(pattern, 'i');
        } catch {
            return { matches: [], visible: [] };
        }

        const matches: number[] = [];
        const visibleSet = new Set<number>();
        const STEP = 8192;
        for (let s = this.firstAvailable; s < this.total; s += STEP) {
            const e = Math.min(s + STEP, this.total);
            const { lines } = this.getRange(s, e);
            for (let j = 0; j < lines.length; j++) {
                const i = s + j;
                if (re.test(lines[j])) {
                    matches.push(i);
                    const lo = Math.max(this.firstAvailable, i - before);
                    const hi = Math.min(this.total - 1, i + after);
                    for (let k = lo; k <= hi; k++) {
                        visibleSet.add(k);
                    }
                }
            }
        }

        const visible = Array.from(visibleSet).sort((a, b) => a - b);
        return { matches, visible };
    }

    clear() {
        this.flush();
        try {
            fs.ftruncateSync(this.fd, 0);
        } catch {
            // ignore
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
    }

    dispose() {
        try {
            fs.closeSync(this.fd);
        } catch {
            // ignore
        }
        try {
            fs.unlinkSync(this.filePath);
        } catch {
            // ignore
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    let store: LogStore | undefined;
    let stateUpdatePending = false;

    const postState = () => {
        if (!panel || !store || stateUpdatePending) {
            return;
        }
        stateUpdatePending = true;
        setTimeout(() => {
            stateUpdatePending = false;
            if (panel && store) {
                panel.webview.postMessage({
                    type: 'state',
                    ...store.getState(),
                });
            }
        }, 30);
    };

    const openCommand = vscode.commands.registerCommand(
        'debug-console-grep.open',
        () => {
            if (panel) {
                panel.reveal(vscode.ViewColumn.Two);
                return;
            }
            const initialWrap = context.globalState.get<boolean>(
                'grep-console-wrap',
                false
            );
            const initialAutoScroll = context.globalState.get<boolean>(
                'grep-console-autoscroll',
                true
            );
            panel = vscode.window.createWebviewPanel(
                'grepConsole',
                'Grep Console',
                vscode.ViewColumn.Two,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            store = new LogStore();
            panel.webview.html = getWebviewContent(
                initialWrap,
                initialAutoScroll
            );

            panel.onDidDispose(
                () => {
                    store?.dispose();
                    store = undefined;
                    panel = undefined;
                },
                null,
                context.subscriptions
            );

            panel.webview.onDidReceiveMessage((m) => {
                if (!store || !panel) {
                    return;
                }
                switch (m.type) {
                    case 'log':
                        console.log('Webview Log:', m.data);
                        break;
                    case 'ready':
                        panel.webview.postMessage({
                            type: 'state',
                            ...store.getState(),
                        });
                        break;
                    case 'set-wrap':
                        context.globalState.update(
                            'grep-console-wrap',
                            m.value
                        );
                        break;
                    case 'set-autoscroll':
                        context.globalState.update(
                            'grep-console-autoscroll',
                            m.value
                        );
                        break;
                    case 'request-range': {
                        const { requestId, from, to } = m;
                        const res = store.getRange(from, to);
                        panel.webview.postMessage({
                            type: 'range',
                            requestId,
                            from: res.from,
                            lines: res.lines,
                        });
                        break;
                    }
                    case 'request-matches': {
                        const { requestId, pattern, before, after } = m;
                        const { matches, visible } = store.findMatches(
                            pattern,
                            before,
                            after
                        );
                        panel.webview.postMessage({
                            type: 'matches',
                            requestId,
                            pattern,
                            before,
                            after,
                            matches,
                            visible,
                        });
                        break;
                    }
                    case 'clear':
                        store.clear();
                        panel.webview.postMessage({
                            type: 'cleared',
                            ...store.getState(),
                        });
                        break;
                }
            });
        }
    );

    context.subscriptions.push(openCommand);

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(_session: vscode.DebugSession) {
            return {
                onDidSendMessage: (message) => {
                    if (
                        message.type === 'event' &&
                        message.event === 'output'
                    ) {
                        const output =
                            message.body?.output || message.body?.text;
                        if (output && store) {
                            const had = store.appendOutput(output);
                            if (had) {
                                postState();
                            }
                        }
                    }
                },
            };
        },
    });
    context.subscriptions.push(tracker);
}

function getWebviewContent(initialWrap: boolean, initialAutoScroll: boolean) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: var(--vscode-editor-font-family), sans-serif; padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; background: var(--vscode-editor-background); color: var(--vscode-foreground); overflow: hidden; }
        #header { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); flex-shrink: 0; }
        #controls { display: flex; gap: 8px; align-items: center; }
        input { flex: 1; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); outline: none; }
        input:focus { border-color: var(--vscode-focusBorder); }
        button { padding: 4px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        .checkbox-container { display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; user-select: none; }
        #debug-info { font-size: 10px; opacity: 0.6; margin-top: 4px; height: 1.2em; display: flex; justify-content: space-between; }
        #output { flex: 1; overflow-y: auto; padding: 8px; font-family: var(--vscode-editor-font-family), monospace; font-size: 12px; position: relative; }
        #output { white-space: pre; }
        #output.wrap { white-space: pre-wrap; }
        #inner { position: relative; width: 100%; }
        .line { line-height: 1.4; contain: layout style; }
        #output.wrap .line { white-space: pre-wrap; }
        .match { font-weight: bold; color: var(--vscode-terminal-ansiBrightYellow); background: rgba(255, 255, 0, 0.05); }
        .context { opacity: 0.5; font-style: italic; }
        .sep { border-bottom: 1px dashed var(--vscode-panel-border); margin: 4px 0; opacity: 0.3; text-align: center; font-size: 10px; }
    </style>
</head>
<body>
    <div id="header">
        <div id="controls">
            <input type="text" id="filter" placeholder="e.g. con -C2 or error -A5" spellcheck="false" />
            <label class="checkbox-container">
                <input type="checkbox" id="wrap-toggle" ${initialWrap ? 'checked' : ''} /> Wrap
            </label>
            <label class="checkbox-container">
                <input type="checkbox" id="autoscroll-toggle" ${initialAutoScroll ? 'checked' : ''} /> Auto-scroll
            </label>
            <button id="clear">Clear</button>
        </div>
        <div id="debug-info">
            <span id="parsed-query">Showing all lines</span>
            <span id="stats">Lines: 0</span>
        </div>
    </div>
    <div id="output"><div id="inner"></div></div>
    <script>
        const vscode = acquireVsCodeApi();
        const outputDiv = document.getElementById('output');
        const innerDiv = document.getElementById('inner');
        const filterInput = document.getElementById('filter');
        const wrapToggle = document.getElementById('wrap-toggle');
        const autoScrollToggle = document.getElementById('autoscroll-toggle');
        const querySpan = document.getElementById('parsed-query');
        const statsSpan = document.getElementById('stats');

        const RANGE_CHUNK = ${RANGE_CHUNK};
        const RAM_TAIL = ${RAM_TAIL};
        const OVERSCAN = 20;
        const CACHE_HARD_LIMIT = 600;
        const CACHE_SOFT_LIMIT = 400;

        let total = 0;
        let firstAvailable = 0;
        let partial = '';
        let rowHeight = 17;
        let rowHeightMeasured = false;

        let filterState = { p: '', b: 0, a: 0 };
        let filterResult = null;
        let filterRequestSeq = 0;
        let pendingFilterRequestId = 0;
        let filterRequestTimer = null;

        let nextReq = 1;
        const rangeCache = new Map();
        const inflightChunks = new Set();

        let renderScheduled = false;
        let lastInnerHeight = -1;
        let lastMode = '';
        let lastFilterResultId = 0;
        let filterResultId = 0;
        const rowCache = new Map();
        const flowRowOrder = [];

        function log(msg) { vscode.postMessage({ type: 'log', data: msg }); }

        vscode.postMessage({ type: 'ready' });

        function applyWrapClass() {
            if (wrapToggle.checked) outputDiv.classList.add('wrap');
            else outputDiv.classList.remove('wrap');
        }
        applyWrapClass();

        wrapToggle.onchange = () => {
            applyWrapClass();
            vscode.postMessage({ type: 'set-wrap', value: wrapToggle.checked });
            scheduleRender();
        };

        autoScrollToggle.onchange = () => {
            vscode.postMessage({ type: 'set-autoscroll', value: autoScrollToggle.checked });
            if (autoScrollToggle.checked) {
                const max = Math.max(0, outputDiv.scrollHeight - outputDiv.clientHeight);
                outputDiv.scrollTop = max;
            }
        };

        filterInput.oninput = () => {
            if (filterRequestTimer) clearTimeout(filterRequestTimer);
            filterRequestTimer = setTimeout(requestMatches, 200);
        };

        document.getElementById('clear').onclick = () => {
            rangeCache.clear();
            inflightChunks.clear();
            filterResult = null;
            vscode.postMessage({ type: 'clear' });
        };

        outputDiv.addEventListener('scroll', () => scheduleRender());
        window.addEventListener('resize', () => scheduleRender());

        function parseQuery(input) {
            let b = 0, a = 0, p = input;
            const flags = [
                { re: /-A\\s*(\\d+)/i, f: v => a = v },
                { re: /-B\\s*(\\d+)/i, f: v => b = v },
                { re: /-C\\s*(\\d+)/i, f: v => b = a = v }
            ];
            for (const flag of flags) {
                let m;
                while ((m = p.match(flag.re))) {
                    flag.f(parseInt(m[1]));
                    p = p.replace(m[0], '');
                }
            }
            p = p.trim();
            return { p, b, a };
        }

        function requestMatches() {
            const val = filterInput.value;
            const parsed = parseQuery(val);
            filterState = parsed;
            if (!parsed.p) {
                if (filterResult !== null) {
                    filterResult = null;
                    filterResultId++;
                }
                scheduleRender();
                return;
            }
            pendingFilterRequestId = ++filterRequestSeq;
            vscode.postMessage({
                type: 'request-matches',
                requestId: pendingFilterRequestId,
                pattern: parsed.p,
                before: parsed.b,
                after: parsed.a
            });
        }

        function chunkIdx(absLine) { return Math.floor(absLine / RANGE_CHUNK); }
        function chunkStartOf(idx) { return idx * RANGE_CHUNK; }

        function getLine(absLine) {
            if (absLine < firstAvailable || absLine >= total) return '';
            const ci = chunkIdx(absLine);
            const c = rangeCache.get(ci);
            if (!c) return null;
            const v = c[absLine - chunkStartOf(ci)];
            return v === undefined ? null : v;
        }

        function ensureChunk(ci) {
            if (rangeCache.has(ci) || inflightChunks.has(ci)) return;
            const from = chunkStartOf(ci);
            const to = from + RANGE_CHUNK;
            if (from >= total || to <= firstAvailable) return;
            inflightChunks.add(ci);
            vscode.postMessage({
                type: 'request-range',
                requestId: nextReq++,
                from, to
            });
        }

        function evictCache() {
            if (rangeCache.size <= CACHE_HARD_LIMIT) return;
            const keys = Array.from(rangeCache.keys());
            const toDrop = keys.slice(0, rangeCache.size - CACHE_SOFT_LIMIT);
            for (const k of toDrop) rangeCache.delete(k);
        }

        function buildFilterItems(matches, visible) {
            const matchSet = new Set(matches);
            const items = [];
            let last = -1;
            for (const i of visible) {
                if (last !== -1 && i > last + 1) items.push({ type: 'sep' });
                items.push({ type: 'line', idx: i, isMatch: matchSet.has(i) });
                last = i;
            }
            return items;
        }

        function partialMatches() {
            if (!filterState.p) return true;
            try {
                const re = new RegExp(filterState.p, 'i');
                return re.test(partial);
            } catch { return false; }
        }

        window.addEventListener('message', e => {
            const m = e.data;
            try {
                if (m.type === 'state' || m.type === 'cleared') {
                    const oldTotal = total;
                    total = m.total;
                    firstAvailable = m.firstAvailable;
                    partial = m.partial || '';
                    if (m.type === 'cleared') {
                        rangeCache.clear();
                        inflightChunks.clear();
                        filterResult = null;
                        filterResultId++;
                    } else {
                        // Re-request chunks that may have grown, without dropping
                        // current cache entries (avoids placeholder flash).
                        const tailChunk = chunkIdx(Math.max(0, oldTotal - 1));
                        const newLastChunk = chunkIdx(Math.max(0, total - 1));
                        for (let ci = tailChunk; ci <= newLastChunk; ci++) {
                            inflightChunks.delete(ci);
                            const from = chunkStartOf(ci);
                            const to = from + RANGE_CHUNK;
                            if (from >= total || to <= firstAvailable) continue;
                            inflightChunks.add(ci);
                            vscode.postMessage({
                                type: 'request-range',
                                requestId: nextReq++,
                                from, to
                            });
                        }
                    }
                    for (const k of Array.from(rangeCache.keys())) {
                        if (chunkStartOf(k) + RANGE_CHUNK <= firstAvailable) {
                            rangeCache.delete(k);
                        }
                    }
                    if (filterState.p && (m.type === 'cleared' || total !== oldTotal)) {
                        if (filterRequestTimer) clearTimeout(filterRequestTimer);
                        filterRequestTimer = setTimeout(requestMatches, 250);
                    }
                    scheduleRender();
                } else if (m.type === 'range') {
                    const ci = chunkIdx(m.from);
                    rangeCache.set(ci, m.lines);
                    inflightChunks.delete(ci);
                    evictCache();
                    scheduleRender();
                } else if (m.type === 'matches') {
                    if (m.requestId !== pendingFilterRequestId) return;
                    if (m.pattern !== filterState.p ||
                        m.before !== filterState.b ||
                        m.after !== filterState.a) return;
                    filterResult = {
                        items: buildFilterItems(m.matches, m.visible),
                        matchCount: m.matches.length
                    };
                    filterResultId++;
                    scheduleRender();
                }
            } catch (err) {
                log('Webview error: ' + err.message);
            }
        });

        function scheduleRender() {
            if (renderScheduled) return;
            renderScheduled = true;
            requestAnimationFrame(() => {
                renderScheduled = false;
                try { render(); } catch (err) { log('render error: ' + err.message); }
            });
        }

        function measureRowHeight() {
            if (rowHeightMeasured) return;
            const probe = document.createElement('div');
            probe.className = 'line';
            probe.textContent = 'M';
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            innerDiv.appendChild(probe);
            const h = probe.offsetHeight;
            innerDiv.removeChild(probe);
            if (h > 0) {
                rowHeight = h;
                rowHeightMeasured = true;
            }
        }

        function render() {
            measureRowHeight();
            const { p, b, a } = filterState;
            const matchCount = filterResult ? filterResult.matchCount : 0;
            const newStats = 'Lines: ' + total + (filterResult ? ' (matches: ' + matchCount + ')' : '');
            const newQuery = p
                ? 'Searching for: "' + p + '" [Context: B=' + b + ', A=' + a + ']'
                : 'Showing all lines';
            if (statsSpan.textContent !== newStats) statsSpan.textContent = newStats;
            if (querySpan.textContent !== newQuery) querySpan.textContent = newQuery;

            const savedScroll = outputDiv.scrollTop;
            const wasAtBottom = (outputDiv.scrollHeight - savedScroll - outputDiv.clientHeight) < rowHeight * 3;

            const mode = wrapToggle.checked ? 'flow' : 'virtual';
            let cacheCleared = false;
            if (mode !== lastMode || filterResultId !== lastFilterResultId) {
                rowCache.clear();
                flowRowOrder.length = 0;
                innerDiv.replaceChildren();
                lastInnerHeight = -1;
                lastMode = mode;
                lastFilterResultId = filterResultId;
                cacheCleared = true;
            }

            if (mode === 'flow') {
                renderFlow();
            } else {
                renderVirtual();
            }

            const maxScroll = Math.max(0, outputDiv.scrollHeight - outputDiv.clientHeight);
            if (autoScrollToggle.checked && wasAtBottom) {
                if (Math.abs(outputDiv.scrollTop - maxScroll) > 1) {
                    outputDiv.scrollTop = maxScroll;
                }
            } else if (cacheCleared) {
                const target = Math.min(savedScroll, maxScroll);
                if (Math.abs(outputDiv.scrollTop - target) > 1) {
                    outputDiv.scrollTop = target;
                }
            }
        }

        function rowSpec(r, items, itemCount) {
            if (r >= itemCount) {
                return { key: 'partial', cls: 'line context', text: partial + ' (partial)' };
            }
            if (items) {
                const it = items[r];
                if (it.type === 'sep') {
                    return { key: 'sep:' + r, cls: 'line sep', text: '--' };
                }
                const t = getLine(it.idx);
                if (t === null) {
                    ensureChunk(chunkIdx(it.idx));
                    return { key: 'line:' + it.idx, cls: 'line context', text: ' ', placeholder: true };
                }
                return {
                    key: 'line:' + it.idx,
                    cls: 'line ' + (it.isMatch ? 'match' : 'context'),
                    text: t || ' '
                };
            }
            const idx = firstAvailable + r;
            const t = getLine(idx);
            if (t === null) {
                ensureChunk(chunkIdx(idx));
                return { key: 'line:' + idx, cls: 'line context', text: ' ', placeholder: true };
            }
            return { key: 'line:' + idx, cls: 'line', text: t || ' ' };
        }

        function getOrCreateAbsRow(key) {
            let div = rowCache.get(key);
            if (!div) {
                div = document.createElement('div');
                div.style.position = 'absolute';
                div.style.left = '0';
                div.style.right = '0';
                innerDiv.appendChild(div);
                rowCache.set(key, div);
            }
            return div;
        }

        function updateAbsRow(div, top, cls, text) {
            const topPx = top + 'px';
            if (div.style.top !== topPx) div.style.top = topPx;
            if (div.className !== cls) div.className = cls;
            if (div.textContent !== text) div.textContent = text;
        }

        function renderVirtual() {
            const items = filterResult ? filterResult.items : null;
            const itemCount = items ? items.length : (total - firstAvailable);
            const showPartial = partial && partialMatches();
            const partialRow = showPartial ? 1 : 0;
            const totalRows = itemCount + partialRow;

            const totalHeight = totalRows * rowHeight;
            if (lastInnerHeight !== totalHeight) {
                innerDiv.style.height = totalHeight + 'px';
                lastInnerHeight = totalHeight;
            }

            const scrollTop = outputDiv.scrollTop;
            const viewportH = outputDiv.clientHeight || rowHeight * 20;
            const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
            const last = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportH) / rowHeight) + OVERSCAN);

            if (!items && itemCount > 0) {
                const firstAbs = firstAvailable + first;
                const lastAbs = firstAvailable + Math.min(last, itemCount - 1);
                if (lastAbs >= firstAbs) {
                    for (let ci = chunkIdx(firstAbs); ci <= chunkIdx(lastAbs); ci++) {
                        if (!rangeCache.has(ci)) ensureChunk(ci);
                    }
                }
            }

            const keepKeys = new Set();
            for (let r = first; r <= last; r++) {
                const spec = rowSpec(r, items, itemCount);
                const div = getOrCreateAbsRow(spec.key);
                updateAbsRow(div, r * rowHeight, spec.cls, spec.text);
                keepKeys.add(spec.key);
            }
            for (const [key, div] of rowCache) {
                if (!keepKeys.has(key)) {
                    div.remove();
                    rowCache.delete(key);
                }
            }
        }

        function flowRowKey(r, items) {
            if (items) {
                const it = items[r];
                return it.type === 'sep' ? 'fsep:' + r : 'line:' + it.idx;
            }
            return 'line:' + (firstAvailable + r);
        }

        function flowRowSpec(r, items) {
            if (items) {
                const it = items[r];
                if (it.type === 'sep') {
                    return { cls: 'line sep', text: '--' };
                }
                const t = getLine(it.idx);
                if (t === null) {
                    ensureChunk(chunkIdx(it.idx));
                    return { cls: 'line context', text: ' ' };
                }
                return {
                    cls: 'line ' + (it.isMatch ? 'match' : 'context'),
                    text: t || ' '
                };
            }
            const idx = firstAvailable + r;
            const t = getLine(idx);
            if (t === null) {
                ensureChunk(chunkIdx(idx));
                return { cls: 'line context', text: ' ' };
            }
            return { cls: 'line', text: t || ' ' };
        }

        function renderFlow() {
            const items = filterResult ? filterResult.items : null;
            const itemCount = items ? items.length : (total - firstAvailable);
            const cap = RAM_TAIL;
            const startItem = Math.max(0, itemCount - cap);

            if (items) {
                for (let r = startItem; r < itemCount; r++) {
                    const it = items[r];
                    if (it.type === 'line') {
                        const ci = chunkIdx(it.idx);
                        if (!rangeCache.has(ci)) ensureChunk(ci);
                    }
                }
            } else if (itemCount > 0) {
                const fromAbs = firstAvailable + startItem;
                const toAbs = firstAvailable + itemCount - 1;
                for (let ci = chunkIdx(fromAbs); ci <= chunkIdx(toAbs); ci++) {
                    if (!rangeCache.has(ci)) ensureChunk(ci);
                }
            }

            if (innerDiv.style.height !== 'auto') {
                innerDiv.style.height = 'auto';
                lastInnerHeight = -1;
            }

            // Build desired key list in order
            const desiredKeys = [];
            const desiredSpecs = [];
            if (startItem > 0) {
                desiredKeys.push('truncnote');
                desiredSpecs.push({
                    cls: 'line sep',
                    text: '-- showing last ' + cap + ' of ' + itemCount + ' (wrap mode) --'
                });
            }
            for (let r = startItem; r < itemCount; r++) {
                desiredKeys.push(flowRowKey(r, items));
                desiredSpecs.push(flowRowSpec(r, items));
            }
            if (partial && partialMatches()) {
                desiredKeys.push('partial');
                desiredSpecs.push({ cls: 'line context', text: partial + ' (partial)' });
            }

            // Reconcile flowRowOrder with desiredKeys
            const desiredSet = new Set(desiredKeys);
            // Remove obsolete
            for (let i = flowRowOrder.length - 1; i >= 0; i--) {
                const k = flowRowOrder[i];
                if (!desiredSet.has(k)) {
                    const div = rowCache.get(k);
                    if (div) {
                        div.remove();
                        rowCache.delete(k);
                    }
                    flowRowOrder.splice(i, 1);
                }
            }

            // Walk and align
            let domIdx = 0;
            for (let i = 0; i < desiredKeys.length; i++) {
                const k = desiredKeys[i];
                const spec = desiredSpecs[i];
                let div = rowCache.get(k);
                if (!div) {
                    div = document.createElement('div');
                    rowCache.set(k, div);
                }
                if (div.className !== spec.cls) div.className = spec.cls;
                if (div.textContent !== spec.text) div.textContent = spec.text;
                if (div.style.position) {
                    div.style.position = '';
                    div.style.top = '';
                    div.style.left = '';
                    div.style.right = '';
                }
                const existing = innerDiv.children[domIdx];
                if (existing !== div) {
                    innerDiv.insertBefore(div, existing || null);
                }
                domIdx++;
            }
            // Trim flowRowOrder to match new order
            flowRowOrder.length = 0;
            for (const k of desiredKeys) flowRowOrder.push(k);
        }
    </script>
</body>
</html>`;
}

export function deactivate() {}
