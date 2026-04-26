import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;

    const openCommand = vscode.commands.registerCommand('debug-console-grep.open', () => {
        if (panel) {
            panel.reveal(vscode.ViewColumn.Two);
        } else {
            panel = vscode.window.createWebviewPanel(
                'grepConsole',
                'Grep Console',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            panel.webview.html = getWebviewContent();
            
            panel.onDidDispose(() => {
                panel = undefined;
            }, null, context.subscriptions);

            panel.webview.onDidReceiveMessage(m => {
                if (m.type === 'log') {
                    console.log('Webview Log:', m.data);
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
                        const output = message.body.output;
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

function getWebviewContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: var(--vscode-editor-font-family), sans-serif; padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; background: var(--vscode-editor-background); color: var(--vscode-foreground); overflow: hidden; }
        #header { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); flex-shrink: 0; }
        #controls { display: flex; gap: 8px; }
        input { flex: 1; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); outline: none; }
        input:focus { border-color: var(--vscode-focusBorder); }
        button { padding: 4px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        #debug-info { font-size: 10px; opacity: 0.6; margin-top: 4px; height: 1.2em; display: flex; justify-content: space-between; }
        #output { flex: 1; overflow-y: auto; padding: 8px; font-family: var(--vscode-editor-font-family), monospace; white-space: pre-wrap; font-size: 12px; }
        .line { border-bottom: 1px solid rgba(128, 128, 128, 0.05); line-height: 1.4; }
        .match { font-weight: bold; color: var(--vscode-terminal-ansiBrightYellow); background: rgba(255, 255, 0, 0.05); }
        .context { opacity: 0.5; font-style: italic; }
        .sep { border-bottom: 1px dashed var(--vscode-panel-border); margin: 4px 0; opacity: 0.3; text-align: center; font-size: 10px; }
    </style>
</head>
<body>
    <div id="header">
        <div id="controls">
            <input type="text" id="filter" placeholder="e.g. con -C2 or error -A5" spellcheck="false" />
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
        const querySpan = document.getElementById('parsed-query');
        const statsSpan = document.getElementById('stats');
        
        let allLines = [];
        let buffer = '';
        let renderPending = false;

        function log(msg) { vscode.postMessage({ type: 'log', data: msg }); }

        window.addEventListener('message', e => {
            if (e.data.type === 'output') {
                buffer += e.data.data;
                const parts = buffer.split(/\\r?\\n/);
                if (parts.length > 1) {
                    buffer = parts.pop();
                    parts.forEach(l => allLines.push(l));
                    scheduleRender();
                }
            }
        });

        document.getElementById('clear').onclick = () => {
            allLines = [];
            buffer = '';
            outputDiv.innerHTML = '';
            scheduleRender();
        };

        filterInput.oninput = scheduleRender;

        function scheduleRender() {
            if (renderPending) return;
            renderPending = true;
            requestAnimationFrame(() => {
                try {
                    render();
                } catch (e) {
                    log('Error during render: ' + e.message);
                } finally {
                    renderPending = false;
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

        function render() {
            const val = filterInput.value;
            const { p, b, a } = parse(val);
            
            querySpan.textContent = p ? \`Searching for: "\${p}" [Context: B=\${b}, A=\${a}]\` : 'Showing all lines';
            statsSpan.textContent = 'Lines: ' + allLines.length;

            outputDiv.innerHTML = '';
            if (!p) {
                allLines.forEach(l => add(l));
                if (buffer) add(buffer + ' (partial)', true);
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
                        outputDiv.appendChild(s);
                    }
                    add(allLines[i], !matches.has(i));
                    last = i;
                });

                if (isM(buffer)) add(buffer + ' (partial)', false);
            }
            
            outputDiv.scrollTop = outputDiv.scrollHeight;
        }

        function add(text, isC) {
            const d = document.createElement('div');
            d.className = 'line' + (isC ? ' context' : ' match');
            d.textContent = text || ' ';
            outputDiv.appendChild(d);
        }
    </script>
</body>
</html>`;
}

export function deactivate() {}
