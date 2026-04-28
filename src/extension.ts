import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;

    const openCommand = vscode.commands.registerCommand('debug-console-grep.open', () => {
        if (panel) {
            panel.reveal(vscode.ViewColumn.Two);
        } else {
            const initialWrap = context.globalState.get<boolean>('grep-console-wrap', false);
            const initialAutoScroll = context.globalState.get<boolean>('grep-console-autoscroll', true);
            panel = vscode.window.createWebviewPanel(
                'grepConsole',
                'Grep Console',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            panel.webview.html = getWebviewContent(initialWrap, initialAutoScroll);
            
            panel.onDidDispose(() => {
                panel = undefined;
            }, null, context.subscriptions);

            panel.webview.onDidReceiveMessage(m => {
                if (m.type === 'log') {
                    console.log('Webview Log:', m.data);
                } else if (m.type === 'ready') {
                    console.log('Webview is ready');
                } else if (m.type === 'set-wrap') {
                    context.globalState.update('grep-console-wrap', m.value);
                } else if (m.type === 'set-autoscroll') {
                    context.globalState.update('grep-console-autoscroll', m.value);
                }
            });
        }
    });

    context.subscriptions.push(openCommand);

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscode.DebugSession) {
            return {
                onDidSendMessage: (message) => {
                    if (message.type === 'event' && message.event === 'output') {
                        const output = message.body?.output || message.body?.text;
                        if (output && panel) {
                            panel.webview.postMessage({ 
                                type: 'output', 
                                data: output 
                            });
                        }
                    }
                }
            };
        }
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
        #output { flex: 1; overflow-y: auto; padding: 8px; font-family: var(--vscode-editor-font-family), monospace; white-space: pre; font-size: 12px; }
        #output.wrap { white-space: pre-wrap; }
        .line { border-bottom: 1px solid rgba(128, 128, 128, 0.05); line-height: 1.4; contain: layout style; will-change: contents; }
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
    <div id="output"></div>
    <script>
        const vscode = acquireVsCodeApi();
        const outputDiv = document.getElementById('output');
        
        const filterInput = document.getElementById('filter');
        const wrapToggle = document.getElementById('wrap-toggle');
        const autoScrollToggle = document.getElementById('autoscroll-toggle');
        const querySpan = document.getElementById('parsed-query');
        const statsSpan = document.getElementById('stats');
        
        let allLines = [];
        let buffer = '';
        let renderPending = false;
        let linesRemovedSinceLastRender = 0;
        let lastFilterState = { p: '', b: 0, a: 0 };
        const MAX_LINES = 5000;

        const updateWrap = () => {
            if (wrapToggle.checked) {
                outputDiv.classList.add('wrap');
            } else {
                outputDiv.classList.remove('wrap');
            }
            vscode.postMessage({ type: 'set-wrap', value: wrapToggle.checked });
            scheduleRender(true);
        };
        wrapToggle.onchange = updateWrap;

        autoScrollToggle.onchange = () => {
            vscode.postMessage({ type: 'set-autoscroll', value: autoScrollToggle.checked });
        };

        function stripAnsi(text) {
            if (typeof text !== 'string') return text;
            // eslint-disable-next-line no-control-regex
            return text.replace(/[\\x1b\\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        }

        function log(msg) { vscode.postMessage({ type: 'log', data: msg }); }
        
        vscode.postMessage({ type: 'ready' });

        window.addEventListener('message', e => {
            try {
                if (e.data.type === 'output') {
                    const incoming = e.data.data || '';
                    buffer += incoming;
                    const parts = buffer.split(/\\r?\\n/);
                    if (parts.length > 1) {
                        buffer = parts.pop();
                        const newLines = parts.map(l => stripAnsi(l));
                        
                        const removed = Math.max(0, (allLines.length + newLines.length) - MAX_LINES);
                        if (removed > 0) {
                            linesRemovedSinceLastRender += removed;
                        }

                        for (let i = 0; i < newLines.length; i++) {
                            allLines.push(newLines[i]);
                        }

                        if (allLines.length > MAX_LINES) {
                            allLines.splice(0, allLines.length - MAX_LINES);
                        }
                        scheduleRender();
                    }
                }
            } catch (err) {
                log('Webview Error: ' + err.message);
            }
        });

        document.getElementById('clear').onclick = () => {
            allLines = [];
            buffer = '';
            linesRemovedSinceLastRender = 0;
            outputDiv.innerHTML = '';
            scheduleRender(true);
        };

        filterInput.oninput = () => scheduleRender(true);

        let needsFullRender = false;
        function scheduleRender(full = false) {
            if (full) needsFullRender = true;
            if (renderPending) return;
            renderPending = true;
            requestAnimationFrame(() => {
                try {
                    render(needsFullRender);
                } catch (e) {
                    log('Error during render: ' + e.message);
                } finally {
                    renderPending = false;
                    needsFullRender = false;
                }
            });
        }

        function parse(input) {
            let b=0, a=0, p=input;
            const flags = [
                { re: /-A\\s*(\\d+)/i, f: (v) => a = v },
                { re: /-B\\s*(\\d+)/i, f: (v) => b = v },
                { re: /-C\\s*(\\d+)/i, f: (v) => b = a = v }
            ];
            
            flags.forEach(flag => {
                let m;
                while (m = p.match(flag.re)) {
                    flag.f(parseInt(m[1]));
                    p = p.replace(m[0], '');
                }
            });
            
            p = p.trim();
            return { p, b, a };
        }

        function createLineElement(text, isContext) {
            const d = document.createElement('div');
            d.className = 'line' + (isContext ? ' context' : ' match');
            d.textContent = text || ' ';
            return d;
        }

        function render(forceFull = false) {
            const val = filterInput.value;
            const { p, b, a } = parse(val);
            
            const filterChanged = forceFull || p !== lastFilterState.p || b !== lastFilterState.b || a !== lastFilterState.a;
            
            // If we have a filter, we must do a full render to ensure context is correct
            const isIncrementalPossible = !filterChanged && !p;
            
            lastFilterState = { p, b, a };
            querySpan.textContent = p ? 'Searching for: "' + p + '" [Context: B=' + b + ', A=' + a + ']' : 'Showing all lines';
            statsSpan.textContent = 'Lines: ' + allLines.length;

            if (isIncrementalPossible) {
                const removed = linesRemovedSinceLastRender;
                linesRemovedSinceLastRender = 0;

                let heightOfRemoved = 0;
                if (removed > 0 && outputDiv.children.length > 0) {
                    const stayIndex = Math.min(removed, outputDiv.children.length);
                    const firstLine = outputDiv.children[0];
                    if (stayIndex < outputDiv.children.length) {
                        heightOfRemoved = outputDiv.children[stayIndex].offsetTop - firstLine.offsetTop;
                    } else {
                        const lastChild = outputDiv.lastChild;
                        if (lastChild) heightOfRemoved = lastChild.offsetTop + lastChild.offsetHeight - firstLine.offsetTop;
                    }
                    
                    for (let i = 0; i < removed; i++) {
                        if (outputDiv.firstChild) outputDiv.removeChild(outputDiv.firstChild);
                    }
                }

                const previousScrollTop = outputDiv.scrollTop;
                const isAtBottom = (outputDiv.scrollHeight - outputDiv.scrollTop - outputDiv.clientHeight) < 30;

                const currentDomCount = outputDiv.children.length;
                const fragment = document.createDocumentFragment();
                for (let i = currentDomCount; i < allLines.length; i++) {
                    fragment.appendChild(createLineElement(allLines[i], false));
                }
                outputDiv.appendChild(fragment);

                if (autoScrollToggle.checked && isAtBottom) {
                    outputDiv.scrollTop = outputDiv.scrollHeight;
                } else {
                    outputDiv.scrollTop = previousScrollTop - heightOfRemoved;
                }
            } else {
                // Full render for filtered view or filter change
                const removed = linesRemovedSinceLastRender;
                linesRemovedSinceLastRender = 0;

                let heightOfRemovedVisible = 0;
                if (removed > 0 && !autoScrollToggle.checked && outputDiv.children.length > 0) {
                    const stayIndex = Math.min(removed, outputDiv.children.length);
                    const firstLine = outputDiv.children[0];
                    if (stayIndex < outputDiv.children.length) {
                        heightOfRemovedVisible = outputDiv.children[stayIndex].offsetTop - firstLine.offsetTop;
                    }
                }

                const previousScrollTop = outputDiv.scrollTop;
                const isAtBottom = (outputDiv.scrollHeight - outputDiv.scrollTop - outputDiv.clientHeight) < 30;

                const fragment = document.createDocumentFragment();
                const cleanBuffer = stripAnsi(buffer);

                if (!p) {
                    allLines.forEach(l => fragment.appendChild(createLineElement(l, false)));
                    if (cleanBuffer) fragment.appendChild(createLineElement(cleanBuffer + ' (partial)', true));
                } else {
                    let re; try { re = new RegExp(p, 'i'); } catch {}
                    const isM = l => re ? re.test(l) : l.toLowerCase().includes(p.toLowerCase());
                    const matches = new Set();
                    const visible = new Set();
                    
                    allLines.forEach((l, i) => {
                        if (isM(l)) {
                            matches.add(i);
                            for (let j = Math.max(0, i - b); j <= Math.min(allLines.length - 1, i + a); j++) {
                                visible.add(j);
                            }
                        }
                    });

                    const sorted = Array.from(visible).sort((x, y) => x - y);
                    let last = -1;
                    sorted.forEach(i => {
                        if (last !== -1 && i > last + 1) {
                            const s = document.createElement('div');
                            s.className = 'sep'; s.textContent = '--';
                            fragment.appendChild(s);
                        }
                        fragment.appendChild(createLineElement(allLines[i], !matches.has(i)));
                        last = i;
                    });
                    if (isM(cleanBuffer)) fragment.appendChild(createLineElement(cleanBuffer + ' (partial)', false));
                }

                outputDiv.innerHTML = '';
                outputDiv.appendChild(fragment);

                if (autoScrollToggle.checked && isAtBottom) {
                    outputDiv.scrollTop = outputDiv.scrollHeight;
                } else {
                    outputDiv.scrollTop = previousScrollTop - heightOfRemovedVisible;
                }
            }
        }

        updateWrap();
    </script>
</body>
</html>`;
}

export function deactivate() {}
