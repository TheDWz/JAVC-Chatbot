# The page's look

**Scope:** how the page is styled: tokens, the glass layers, how the chat scrolls under the header and composer, and the accent colors.
**Source:** the `<style>` block in `index.html`; `applyTheme` and the bar-height observer in `renderer.js`. The saved theme is in [storage.md](storage.md).

## Tokens

All styling is built on one token set in `:root`, written as `light-dark()` pairs that follow the system's light or dark mode. Keep the resolved `color-scheme` rule as it is, because `renderer.js` passes it to the sandboxed reply frames.

## Glass

The translucent layers use `--glass` / `--glass-strong`, `--glass-line`, `--glass-shadow` and `--blur`.
- **With their own blur:** `header::before`, the composer, the toast, the popovers (`#modelpop`, `#morepop`), the reasoning panel (`#side`), dialogs, and the chat list when it's a phone overlay.
- **Glass fill without a blur:** the header pills, the attachment chips and a rich reply's expand button. They sit on an already-blurred layer, or a blur would cost GPU time for no visible change. Don't stack blurs.
- **Prefix:** always write `-webkit-backdrop-filter` beside `backdrop-filter`, because iOS 17 needs it.
- **Select lists:** native select lists on the desktop take their background from `option`, so `.pill option` and `.input option` stay opaque.

## The chat scrolls under the header and composer

- **Header:** `<header>` is `position: absolute` over `#scroll`, with z-index 20.
  - Don't put it inside the scroller: the scroller would clip its popovers, and the sticky composer would paint over them.
  - Its blur is on `header::before`, not on the header itself. A blurred header would stop the popovers inside it from blurring the chat, and would become the containing block of the phone's fixed `#modelpop`.
- **Composer:** `<footer>` is `position: sticky; bottom: 0` inside `#scroll`, so it keeps its own space. It fades into `--bg` below the composer, so the hint stays readable.
- **Bar heights:** a `ResizeObserver` in `renderer.js` writes the header's and footer's heights to `--head-h` and `--foot-h` on `#scroll`. These set `padding-top` (so the first message starts below the header) and `scroll-padding` (so focus and paging don't land under either bar). The header is taller on phones, where it wraps into two rows.

## Accent

`applyTheme` sets `--a1` and `--a2`, and `--grad` blends them. With the Gradient switch off, `--a2` equals `--a1`, so every `var(--grad)` paints one flat color. Switches use `--a1` directly. Selected items (the open chat, the model row Enter would pick, the settings tab, the reasoning level) get a 14% accent tint. A hovered item gets the neutral `--fill`, so the two never look the same.
