# Debug Console Grep

A VS Code extension that provides a dedicated console for filtering debug output using grep-like syntax.

## Features

- **Real-time Filtering**: Filter debug output as it arrives.
- **Context Support**: Use standard grep flags like `-A`, `-B`, and `-C` to see context lines around matches.
- **Regex Support**: Full regular expression support for powerful searching.
- **Persistent View**: Keep your filtered view separate from the main debug console.

## Usage

1. Open the Command Palette (**Cmd+Shift+P** or **Ctrl+Shift+P**).
2. Run the command **"Open Grep Console"**.
3. Start a debug session.
4. Type your filter in the input box (e.g., `error -C 2`).
