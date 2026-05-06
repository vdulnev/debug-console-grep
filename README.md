# Debug Console Grep

A VS Code extension that provides a dedicated console for filtering debug output using grep-like syntax.

## Features

- **Real-time Filtering**: Filter debug output as it arrives.
- **Context Support**: Use standard grep flags `-A N`, `-B N`, and `-C N` to show lines after, before, or around each match.
- **Boolean Operators**: Combine terms with `AND` and `OR` (uppercase). `AND` binds tighter than `OR`, so `foo AND bar OR baz` means `(foo AND bar) OR baz`.
- **Literal Substring Matching**: Filter terms are matched as literal, case-insensitive substrings — no need to escape `[`, `]`, `.`, `(`, etc. when searching log lines like `[INFO]` or `(error)`.
- **Line Wrapping Toggle**: Toggle long-line wrapping in the output view.
- **Auto-scroll Toggle**: Pin the view to the latest output, or disable it to inspect history without interruption.
- **Clear**: Wipe the buffered output with the **Clear** button.
- **Persistent View**: Keep your filtered view separate from the main debug console; wrap and auto-scroll preferences persist across sessions.

## Usage

1. Open the Command Palette (**Cmd+Shift+P** or **Ctrl+Shift+P**).
2. Run the command **"Open Grep Console"**.
3. Start a debug session.
4. Type your filter in the input box.

### Filter examples

- `error` — lines containing `error` (case-insensitive).
- `error -C2` — matches plus 2 lines of context before and after.
- `connect -A5` — matches plus 5 lines after.
- `foo AND bar` — lines containing both `foo` and `bar`.
- `warn OR fail` — lines containing either `warn` or `fail`.
- `foo AND bar OR baz -B1` — `(foo AND bar) OR baz`, with 1 line of leading context.
