# Book Mode

Book Mode is an Obsidian plugin that opens the active note in a paginated reader with a book-like spread.

## What it does

- Opens the current markdown note in a dedicated reading view
- Shows two pages side by side on wider panes
- Falls back to one page when the view is narrow
- Moves through the note with left and right buttons or arrow keys
- Adds an optional cover page and remembers your place inside the view state

## Commands

- `Book Mode: Open current note in book mode`
- `Book Mode: Next page spread`
- `Book Mode: Previous page spread`

## Notes on pagination

Obsidian's default markdown preview is scroll-based, so Book Mode uses custom pagination. This first version measures rendered markdown block-by-block and fills each page until it overflows. It works well for regular prose notes and simple mixed markdown. Very large images, long tables, or oversized code blocks may still overflow a page.

## Development

```bash
npm install
npm run build
```

The compiled plugin output is `main.js`, plus the checked-in `manifest.json` and `styles.css`.

## Install locally

Copy these files into your vault's plugin folder:

- `main.js`
- `manifest.json`
- `styles.css`

Target directory:

```text
.obsidian/plugins/book-mode/
```
