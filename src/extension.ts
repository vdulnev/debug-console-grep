import * as vscode from 'vscode';
import { LogStore, RAM_TAIL, RANGE_CHUNK } from './logStore';
import type { HostMsg, WebviewMsg } from './messages';

const STATE_DEBOUNCE_MS = 30;

export function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    let store: LogStore | undefined;
    let stateUpdatePending = false;

    const post = (m: HostMsg) => {
        panel?.webview.postMessage(m);
    };

    const postState = () => {
        if (!panel || !store || stateUpdatePending) {
            return;
        }
        stateUpdatePending = true;
        setTimeout(() => {
            stateUpdatePending = false;
            if (panel && store) {
                post({ type: 'state', ...store.getState() });
            }
        }, STATE_DEBOUNCE_MS);
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
                false,
            );
            const initialAutoScroll = context.globalState.get<boolean>(
                'grep-console-autoscroll',
                true,
            );
            panel = vscode.window.createWebviewPanel(
                'grepConsole',
                'Grep Console',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'media'),
                    ],
                },
            );
            store = new LogStore();
            panel.webview.html = renderHtml(
                panel.webview,
                context.extensionUri,
                initialWrap,
                initialAutoScroll,
            );

            panel.onDidDispose(
                () => {
                    const s = store;
                    store = undefined;
                    panel = undefined;
                    void s?.dispose();
                },
                null,
                context.subscriptions,
            );

            panel.webview.onDidReceiveMessage(async (raw: WebviewMsg) => {
                if (!store || !panel) {
                    return;
                }
                try {
                    await handleMessage(raw, store, post, context);
                } catch (err) {
                    console.error('grep-console message error:', err);
                }
            });
        },
    );

    context.subscriptions.push(openCommand);

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker() {
            return {
                onDidSendMessage: (message) => {
                    if (
                        !store ||
                        message.type !== 'event' ||
                        message.event !== 'output'
                    ) {
                        return;
                    }
                    const body = message.body;
                    if (!body || body.category === 'telemetry') {
                        return;
                    }
                    const output: string | undefined = body.output;
                    if (output && store.appendOutput(output)) {
                        postState();
                    }
                },
            };
        },
    });
    context.subscriptions.push(tracker);
}

async function handleMessage(
    msg: WebviewMsg,
    store: LogStore,
    post: (m: HostMsg) => void,
    context: vscode.ExtensionContext,
): Promise<void> {
    switch (msg.type) {
        case 'log':
            console.log('Webview:', msg.data);
            return;
        case 'ready':
            post({ type: 'state', ...store.getState() });
            return;
        case 'set-wrap':
            await context.globalState.update('grep-console-wrap', msg.value);
            return;
        case 'set-autoscroll':
            await context.globalState.update(
                'grep-console-autoscroll',
                msg.value,
            );
            return;
        case 'request-range': {
            const res = await store.getRange(msg.from, msg.to);
            post({
                type: 'range',
                requestId: msg.requestId,
                from: res.from,
                lines: res.lines,
            });
            return;
        }
        case 'request-matches': {
            const res = await store.findMatches(
                msg.pattern,
                msg.before,
                msg.after,
            );
            post({
                type: 'matches',
                requestId: msg.requestId,
                pattern: msg.pattern,
                before: msg.before,
                after: msg.after,
                matches: res.matches,
                visible: res.visible,
            });
            return;
        }
        case 'clear':
            await store.clear();
            post({ type: 'cleared', ...store.getState() });
            return;
    }
}

export function deactivate() {
    // no-op; panel disposal handles cleanup
}

function renderHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    initialWrap: boolean,
    initialAutoScroll: boolean,
): string {
    const mediaUri = vscode.Uri.joinPath(extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(mediaUri, 'grep.js'),
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(mediaUri, 'grep.css'),
    );
    const nonce = makeNonce();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link rel="stylesheet" href="${styleUri}">
    <title>Grep Console</title>
</head>
<body data-range-chunk="${RANGE_CHUNK}" data-ram-tail="${RAM_TAIL}">
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
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
