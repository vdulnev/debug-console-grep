import * as assert from 'assert';
import { LogStore } from '../logStore';

suite('LogStore', () => {
    let store: LogStore;

    setup(() => {
        store = new LogStore();
    });

    teardown(async () => {
        await store.dispose();
    });

    test('appendOutput buffers partial line without newline', () => {
        const had = store.appendOutput('hello');
        assert.strictEqual(had, false);
        const s = store.getState();
        assert.strictEqual(s.total, 0);
        assert.strictEqual(s.partial, 'hello');
    });

    test('appendOutput emits complete lines', () => {
        const had = store.appendOutput('a\nb\nc');
        assert.strictEqual(had, true);
        const s = store.getState();
        assert.strictEqual(s.total, 2);
        assert.strictEqual(s.partial, 'c');
    });

    test('getRange returns lines from RAM', async () => {
        store.appendOutput('line1\nline2\nline3\n');
        const r = await store.getRange(0, 3);
        assert.strictEqual(r.from, 0);
        assert.deepStrictEqual(r.lines, ['line1', 'line2', 'line3']);
    });

    test('getRange pads with empty strings outside available range', async () => {
        store.appendOutput('a\nb\n');
        const r = await store.getRange(0, 5);
        assert.strictEqual(r.lines.length, 5);
        assert.strictEqual(r.lines[0], 'a');
        assert.strictEqual(r.lines[1], 'b');
        assert.strictEqual(r.lines[2], '');
        assert.strictEqual(r.lines[3], '');
        assert.strictEqual(r.lines[4], '');
    });

    test('findMatches returns match indices', async () => {
        store.appendOutput('foo error\nbar\nbaz error\n');
        const r = await store.findMatches('error', 0, 0);
        assert.deepStrictEqual(r.matches, [0, 2]);
        assert.deepStrictEqual(r.visible, [0, 2]);
    });

    test('findMatches uses incremental cache for repeated patterns', async () => {
        store.appendOutput('foo error\nbar\nbaz error\n');
        const r1 = await store.findMatches('error', 0, 0);
        assert.deepStrictEqual(r1.matches, [0, 2]);
        store.appendOutput('quux\nerror again\n');
        const r2 = await store.findMatches('error', 0, 0);
        assert.deepStrictEqual(r2.matches, [0, 2, 4]);
    });

    test('findMatches expands visible window with context flags', async () => {
        store.appendOutput('a\nb\nERR\nc\nd\n');
        const r = await store.findMatches('ERR', 1, 1);
        assert.deepStrictEqual(r.matches, [2]);
        assert.deepStrictEqual(r.visible, [1, 2, 3]);
    });

    test('findMatches merges overlapping context windows', async () => {
        store.appendOutput('a\nERR1\nb\nERR2\nc\n');
        const r = await store.findMatches('ERR', 1, 1);
        assert.deepStrictEqual(r.matches, [1, 3]);
        assert.deepStrictEqual(r.visible, [0, 1, 2, 3, 4]);
    });

    test('findMatches handles invalid regex gracefully', async () => {
        store.appendOutput('hello\n');
        const r = await store.findMatches('[invalid', 0, 0);
        assert.deepStrictEqual(r.matches, []);
        assert.deepStrictEqual(r.visible, []);
    });

    test('findMatches works with context flags and pattern cache', async () => {
        store.appendOutput('line1\nline2\nmatch\nline4\nline5\n');
        const r1 = await store.findMatches('match', 1, 1);
        assert.deepStrictEqual(r1.matches, [2]);
        assert.deepStrictEqual(r1.visible, [1, 2, 3]);

        store.appendOutput('line6\nmatch2\nline8\n');
        const r2 = await store.findMatches('match', 1, 1);
        assert.deepStrictEqual(r2.matches, [2, 6]);
        assert.deepStrictEqual(r2.visible, [1, 2, 3, 5, 6, 7]);
    });

    test('findMatches handles large context flags without crashing', async () => {
        store.appendOutput('match\n'.repeat(10));
        const r = await store.findMatches('match', 100, 100);
        assert.strictEqual(r.matches.length, 10);
        assert.strictEqual(r.visible.length, 10); // All lines are matches, so no extra visible lines
        assert.deepStrictEqual(r.visible, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    test('clear resets state', async () => {
        store.appendOutput('hello\nworld\n');
        await store.clear();
        const s = store.getState();
        assert.strictEqual(s.total, 0);
        assert.strictEqual(s.firstAvailable, 0);
        assert.strictEqual(s.partial, '');
    });

    test('strips ANSI escape sequences', async () => {
        store.appendOutput('\x1b[31merror\x1b[0m\n');
        const r = await store.getRange(0, 1);
        assert.strictEqual(r.lines[0], 'error');
    });

    test('getRange survives a flush triggered by large input', async () => {
        // Force a flush by writing > 64 KiB
        const big = ('x'.repeat(100) + '\n').repeat(700);
        store.appendOutput(big);
        const r = await store.getRange(0, 5);
        assert.strictEqual(r.lines.length, 5);
        for (const line of r.lines) {
            assert.strictEqual(line.length, 100);
        }
    });

    test('handles \\r\\n line endings', () => {
        store.appendOutput('a\r\nb\r\nc');
        const s = store.getState();
        assert.strictEqual(s.total, 2);
        assert.strictEqual(s.partial, 'c');
    });
});
