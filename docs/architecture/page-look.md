# The page's look

**Scope:** how the page is styled: tokens, the glass layers, how the chat scrolls under the header and composer, and the accent colors.
**Source:** the `<style>` block in `index.html`; `applyTheme` and the bar-height observer in `renderer.js`. The saved theme is in [storage.md](storage.md).

## Tokens

All styling is built on one token set in `:root`, written as `light-dark()` pairs that follow the system's light or dark mode. Keep the resolved `color-scheme` rule as it is, because `renderer.js` passes it to the sandboxed reply frames.

## Glass

The translucent layers use `--glass` / `--glass-strong`, `--glass-line`, `--glass-shadow` and `--blur`.
- **With their own blur:** `header::before`, the composer, the toast, the popovers (`#modelpop`, `#morepop`, the `.selpop` lists and the reasoning levels), dialogs, and the chat list when it's a phone overlay.
- **Glass fill without a blur:** the header pills, the attachment chips and a rich reply's expand button. They sit on an already-blurred layer, or a blur would cost GPU time for no visible change. Don't stack blurs.
- **Prefix:** always write `-webkit-backdrop-filter` beside `backdrop-filter`, because iOS 17 needs it.
- **Dropdowns:** every `<select>` except the model's goes through `glassSelect` in `renderer.js`, so all dropdowns share the model picker's look (`.modelbtn` on the pills, `.mopt` rows). It works the same on every platform, iOS included.
  - The `<select>` stays, hidden, as the source of truth. Code still sets its options, `.value` and `disabled`, and listens for `change`. A `MutationObserver` keeps the visible `.selbtn` label in step with option and `disabled` changes. Setting `.value` fires no event, so code that sets it then calls `refreshSel(sel)`, the way `renderModelBtn()` follows the model's.
  - The list is a `popover` (`.selpop`), so it sits in the top layer and a dialog can't clip it. It also stays a child of the dialog, so it isn't made inert. It's positioned from the button's rect, opens upward when there's more room above, follows its field on resize (the phone keyboard), and closes when something around it scrolls. A pick fires bubbling `input` and `change` events, like a real select. Escape and `closeTopLayer()` close the list before the dialog.
  - The pills are `<div>`s, not `<label>`s, and `-webkit-tap-highlight-color` is transparent on `:root`, so Android doesn't flash a highlight box when one is tapped.
- **Reasoning levels:** the composer's brain button (`#reasoning`) is the `popovertarget` of `#reasonpop`, a `.selpop` that opens above it, placed by the same `placePop` as the dropdown lists. Each level is one line: its description is cut with an ellipsis and repeated in the row's `title`. Picking a level saves it and closes the popup.

## The chat scrolls under the header and composer

- **Header:** `<header>` is `position: absolute` over `#scroll`, with z-index 20.
  - Don't put it inside the scroller: the scroller would clip its popovers, and the sticky composer would paint over them.
  - It reaches behind the phone's status bar: `body` has no top safe-area padding, and the header adds `env(safe-area-inset-top)` to its own top padding so its glass runs to the screen edge. The desktop chat list adds the inset to its top margin instead. Capacitor's SystemBars plugin passes the insets to CSS on Android WebView 140+; older WebViews are padded natively and show the window background behind the status bar.
  - Its blur is on `header::before`, not on the header itself. A blurred header would stop the popovers inside it from blurring the chat, and would become the containing block of the phone's fixed `#modelpop`.
- **Composer:** `<footer>` is `position: sticky; bottom: 0` inside `#scroll`, so it keeps its own space. It fades into `--bg` below the composer, so the hint stays readable.
- **Bar heights:** a `ResizeObserver` in `renderer.js` (watching the border box, since the header's padding carries the status-bar inset) writes the header's and footer's heights to `--head-h` and `--foot-h` on `#scroll`. These set `padding-top` (so the first message starts below the header) and `scroll-padding` (so focus and paging don't land under either bar). The header is taller on phones, where it wraps into two rows.

## Accent

`applyTheme` sets `--a1` and `--a2`, and `--grad` blends them. With the Gradient switch off, `--a2` equals `--a1`, so every `var(--grad)` paints one flat color. Switches use `--a1` directly. Selected items (the open chat, the model row Enter would pick, the settings tab, the reasoning level) get a 14% accent tint. A hovered item gets the neutral `--fill`, so the two never look the same.

## Motion

Everything springs in with a slight overshoot that settles, and eases out faster. The tokens are in `:root`:
- `--spring` for things appearing.
- `--ease` for fades and exits.
- `--sheet` for panels and anything that moves layout, such as the sidebar.
- `--t-fast` (120ms), `--t-mid` (220ms) and `--t-slow` (320ms), plus `--t-panel` (380ms) for the chat list and its scrim.

**Showing and hiding.** Popovers (`[hidden]`), dialogs (`showModal` / `close`), the sidebar (`.nohist`), the reasoning block (`.row.open`), the drop overlay and the settings panes still hide with `display: none`. They animate both ways like this:
- The resting rule lists `display` (and `overlay` for dialogs) in `transition` with `allow-discrete`, so the element stays displayed until its exit transition ends.
- An `@starting-style` block gives the values to enter from.
- The `[hidden] { display: none !important }` rule still works, because transitions outrank `!important` in the cascade.
- While they fade out, `#modelpop` and `#morepop` are still displayed, so `renderer.js` makes them `inert` whenever they're `hidden`, and Tab can't land in them.
- The chat list's open or closed state is set as `renderer.js` loads, not after settings arrive. `.app.boot` (in the markup, removed two frames later) turns its transitions off, so launch doesn't slide it in and out.
- `interpolate-size: allow-keywords` lets the reasoning block's height animate to `auto`.
- Where a WebView lacks any of these, the element snaps instead. Nothing breaks.

**Messages.** New rows run `rise` (assistant) or `rise-user` (user). `renderChat` draws a whole chat at once, so it finishes those entrances right away. `openChat` then fades the log in once; redraws in place (edits, version arrows, Regenerate) don't fade. `reply.done` gives the bubble a short fade when the streamed text becomes the formatted reply.

**Press feedback.** Buttons, chips, menu rows and list items scale down slightly while pressed and spring back. They share one `transition` list near the end of the `<style>` block. Add a new control there, or it loses its other transitions.

**Reduced motion.** The `prefers-reduced-motion: reduce` rule turns off every CSS animation and transition. Animations started from script (`fade` in `renderer.js`) check the same media query themselves.
