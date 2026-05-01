(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const outputDiv = document.getElementById('output');
    const innerDiv = document.getElementById('inner');
    const filterInput = document.getElementById('filter');
    const wrapToggle = document.getElementById('wrap-toggle');
    const autoScrollToggle = document.getElementById('autoscroll-toggle');
    const querySpan = document.getElementById('parsed-query');
    const statsSpan = document.getElementById('stats');
    const clearButton = document.getElementById('clear');

    const RANGE_CHUNK = parseInt(document.body.dataset.rangeChunk, 10) || 256;
    const RAM_TAIL = parseInt(document.body.dataset.ramTail, 10) || 5000;
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
    let inputTimer = null;
    let streamTimer = null;

    let nextReq = 1;
    const rangeCache = new Map();
    const inflightChunks = new Set();

    let renderScheduled = false;
    let lastInnerHeight = -1;
    let lastMode = '';
    let filterResultId = 0;
    let lastFilterResultId = 0;
    const rowCache = new Map();
    const flowRowOrder = [];

    function log(msg) {
        vscode.postMessage({ type: 'log', data: String(msg) });
    }

    function applyWrapClass() {
        outputDiv.classList.toggle('wrap', wrapToggle.checked);
    }

    function parseQuery(input) {
        let b = 0;
        let a = 0;
        let p = ' ' + input;
        const FLAG_RE = /(\s)-([ABC])\s*(\d+)/i;
        let m;
        while ((m = p.match(FLAG_RE)) !== null) {
            const v = parseInt(m[3], 10);
            const f = m[2].toUpperCase();
            if (f === 'A') {
                a = v;
            } else if (f === 'B') {
                b = v;
            } else {
                b = v;
                a = v;
            }
            p = p.replace(m[0], m[1]);
        }
        return { p: p.trim(), b: b, a: a };
    }

    function chunkIdx(absLine) {
        return Math.floor(absLine / RANGE_CHUNK);
    }

    function chunkStartOf(idx) {
        return idx * RANGE_CHUNK;
    }

    function getLine(absLine) {
        if (absLine < firstAvailable || absLine >= total) {
            return '';
        }
        const ci = chunkIdx(absLine);
        const c = rangeCache.get(ci);
        if (!c) {
            return null;
        }
        const v = c[absLine - chunkStartOf(ci)];
        return v === undefined ? null : v;
    }

    function ensureChunk(ci) {
        if (rangeCache.has(ci) || inflightChunks.has(ci)) {
            return;
        }
        const from = chunkStartOf(ci);
        const to = from + RANGE_CHUNK;
        if (from >= total || to <= firstAvailable) {
            return;
        }
        inflightChunks.add(ci);
        vscode.postMessage({
            type: 'request-range',
            requestId: nextReq++,
            from: from,
            to: to,
        });
    }

    function evictCache() {
        if (rangeCache.size <= CACHE_HARD_LIMIT) {
            return;
        }
        const keys = Array.from(rangeCache.keys());
        const toDrop = keys.slice(0, rangeCache.size - CACHE_SOFT_LIMIT);
        for (const k of toDrop) {
            rangeCache.delete(k);
        }
    }

    function buildFilterItems(matches, visible) {
        const matchSet = new Set(matches);
        const items = [];
        let last = -1;
        for (const i of visible) {
            if (last !== -1 && i > last + 1) {
                items.push({ type: 'sep' });
            }
            items.push({
                type: 'line',
                idx: i,
                isMatch: matchSet.has(i),
            });
            last = i;
        }
        return items;
    }

    function partialMatches() {
        if (!filterState.p) {
            return true;
        }
        try {
            const re = new RegExp(filterState.p, 'i');
            return re.test(partial);
        } catch (err) {
            return false;
        }
    }

    function requestMatches() {
        const parsed = parseQuery(filterInput.value);
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
            after: parsed.a,
        });
    }

    function handleStateUpdate(m) {
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
            const tailChunk = chunkIdx(Math.max(0, oldTotal - 1));
            const newLastChunk = chunkIdx(Math.max(0, total - 1));
            for (let ci = tailChunk; ci <= newLastChunk; ci++) {
                inflightChunks.delete(ci);
                const from = chunkStartOf(ci);
                const to = from + RANGE_CHUNK;
                if (from >= total || to <= firstAvailable) {
                    continue;
                }
                inflightChunks.add(ci);
                vscode.postMessage({
                    type: 'request-range',
                    requestId: nextReq++,
                    from: from,
                    to: to,
                });
            }
        }
        for (const k of Array.from(rangeCache.keys())) {
            if (chunkStartOf(k) + RANGE_CHUNK <= firstAvailable) {
                rangeCache.delete(k);
            }
        }
        if (
            filterState.p &&
            (m.type === 'cleared' || total !== oldTotal)
        ) {
            if (m.type === 'cleared') {
                if (streamTimer) {
                    clearTimeout(streamTimer);
                    streamTimer = null;
                }
                requestMatches();
            } else if (!streamTimer) {
                streamTimer = setTimeout(function () {
                    streamTimer = null;
                    requestMatches();
                }, 250);
            }
        }
        scheduleRender();
    }

    function scheduleRender() {
        if (renderScheduled) {
            return;
        }
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            try {
                render();
            } catch (err) {
                log('render error: ' + err.message);
            }
        });
    }

    function measureRowHeight() {
        if (rowHeightMeasured) {
            return;
        }
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
        const p = filterState.p;
        const b = filterState.b;
        const a = filterState.a;
        const matchCount = filterResult ? filterResult.matchCount : 0;
        const newStats =
            'Lines: ' +
            total +
            (filterResult ? ' (matches: ' + matchCount + ')' : '');
        const newQuery = p
            ? 'Searching for: "' + p + '" [Context: B=' + b + ', A=' + a + ']'
            : 'Showing all lines';
        if (statsSpan.textContent !== newStats) {
            statsSpan.textContent = newStats;
        }
        if (querySpan.textContent !== newQuery) {
            querySpan.textContent = newQuery;
        }

        const savedScroll = outputDiv.scrollTop;
        const wasAtBottom =
            outputDiv.scrollHeight - savedScroll - outputDiv.clientHeight <
            rowHeight * 3;

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

        const maxScroll = Math.max(
            0,
            outputDiv.scrollHeight - outputDiv.clientHeight,
        );
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
            return {
                key: 'partial',
                cls: 'line context',
                text: partial + ' (partial)',
            };
        }
        if (items) {
            const it = items[r];
            if (it.type === 'sep') {
                return { key: 'sep:' + r, cls: 'line sep', text: '--' };
            }
            const t = getLine(it.idx);
            if (t === null) {
                ensureChunk(chunkIdx(it.idx));
                return {
                    key: 'line:' + it.idx,
                    cls: 'line context',
                    text: ' ',
                };
            }
            return {
                key: 'line:' + it.idx,
                cls: 'line ' + (it.isMatch ? 'match' : 'context'),
                text: t || ' ',
            };
        }
        const idx = firstAvailable + r;
        const t = getLine(idx);
        if (t === null) {
            ensureChunk(chunkIdx(idx));
            return { key: 'line:' + idx, cls: 'line context', text: ' ' };
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
        if (div.style.top !== topPx) {
            div.style.top = topPx;
        }
        if (div.className !== cls) {
            div.className = cls;
        }
        if (div.textContent !== text) {
            div.textContent = text;
        }
    }

    function renderVirtual() {
        const items = filterResult ? filterResult.items : null;
        const itemCount = items ? items.length : total - firstAvailable;
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
        const first = Math.max(
            0,
            Math.floor(scrollTop / rowHeight) - OVERSCAN,
        );
        const last = Math.min(
            totalRows - 1,
            Math.ceil((scrollTop + viewportH) / rowHeight) + OVERSCAN,
        );

        if (!items && itemCount > 0) {
            const firstAbs = firstAvailable + first;
            const lastAbs = firstAvailable + Math.min(last, itemCount - 1);
            if (lastAbs >= firstAbs) {
                for (
                    let ci = chunkIdx(firstAbs);
                    ci <= chunkIdx(lastAbs);
                    ci++
                ) {
                    if (!rangeCache.has(ci)) {
                        ensureChunk(ci);
                    }
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
                text: t || ' ',
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
        const itemCount = items ? items.length : total - firstAvailable;
        const cap = RAM_TAIL;
        const startItem = Math.max(0, itemCount - cap);

        if (items) {
            for (let r = startItem; r < itemCount; r++) {
                const it = items[r];
                if (it.type === 'line') {
                    const ci = chunkIdx(it.idx);
                    if (!rangeCache.has(ci)) {
                        ensureChunk(ci);
                    }
                }
            }
        } else if (itemCount > 0) {
            const fromAbs = firstAvailable + startItem;
            const toAbs = firstAvailable + itemCount - 1;
            for (let ci = chunkIdx(fromAbs); ci <= chunkIdx(toAbs); ci++) {
                if (!rangeCache.has(ci)) {
                    ensureChunk(ci);
                }
            }
        }

        if (innerDiv.style.height !== 'auto') {
            innerDiv.style.height = 'auto';
            lastInnerHeight = -1;
        }

        const desiredKeys = [];
        const desiredSpecs = [];
        if (startItem > 0) {
            desiredKeys.push('truncnote');
            desiredSpecs.push({
                cls: 'line sep',
                text:
                    '-- showing last ' +
                    cap +
                    ' of ' +
                    itemCount +
                    ' (wrap mode) --',
            });
        }
        for (let r = startItem; r < itemCount; r++) {
            desiredKeys.push(flowRowKey(r, items));
            desiredSpecs.push(flowRowSpec(r, items));
        }
        if (partial && partialMatches()) {
            desiredKeys.push('partial');
            desiredSpecs.push({
                cls: 'line context',
                text: partial + ' (partial)',
            });
        }

        const desiredSet = new Set(desiredKeys);
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

        let domIdx = 0;
        for (let i = 0; i < desiredKeys.length; i++) {
            const k = desiredKeys[i];
            const spec = desiredSpecs[i];
            let div = rowCache.get(k);
            if (!div) {
                div = document.createElement('div');
                rowCache.set(k, div);
            }
            if (div.className !== spec.cls) {
                div.className = spec.cls;
            }
            if (div.textContent !== spec.text) {
                div.textContent = spec.text;
            }
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
        flowRowOrder.length = 0;
        for (const k of desiredKeys) {
            flowRowOrder.push(k);
        }
    }

    applyWrapClass();

    wrapToggle.onchange = function () {
        applyWrapClass();
        vscode.postMessage({ type: 'set-wrap', value: wrapToggle.checked });
        scheduleRender();
    };

    autoScrollToggle.onchange = function () {
        vscode.postMessage({
            type: 'set-autoscroll',
            value: autoScrollToggle.checked,
        });
        if (autoScrollToggle.checked) {
            const max = Math.max(
                0,
                outputDiv.scrollHeight - outputDiv.clientHeight,
            );
            outputDiv.scrollTop = max;
        }
    };

    filterInput.oninput = function () {
        if (inputTimer) {
            clearTimeout(inputTimer);
        }
        inputTimer = setTimeout(function () {
            inputTimer = null;
            requestMatches();
        }, 200);
    };

    clearButton.onclick = function () {
        rangeCache.clear();
        inflightChunks.clear();
        filterResult = null;
        vscode.postMessage({ type: 'clear' });
    };

    outputDiv.addEventListener('scroll', function () {
        scheduleRender();
    });
    window.addEventListener('resize', function () {
        scheduleRender();
    });

    window.addEventListener('message', function (e) {
        const m = e.data;
        try {
            if (m.type === 'state' || m.type === 'cleared') {
                handleStateUpdate(m);
            } else if (m.type === 'range') {
                const ci = chunkIdx(m.from);
                rangeCache.set(ci, m.lines);
                inflightChunks.delete(ci);
                evictCache();
                scheduleRender();
            } else if (m.type === 'matches') {
                if (m.requestId !== pendingFilterRequestId) {
                    return;
                }
                if (
                    m.pattern !== filterState.p ||
                    m.before !== filterState.b ||
                    m.after !== filterState.a
                ) {
                    return;
                }
                filterResult = {
                    items: buildFilterItems(m.matches, m.visible),
                    matchCount: m.matches.length,
                };
                filterResultId++;
                scheduleRender();
            }
        } catch (err) {
            log('Webview error: ' + err.message);
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
