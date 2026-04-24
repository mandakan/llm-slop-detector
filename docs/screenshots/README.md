# Screenshot capture pages

Clean test pages designed for capturing store-listing screenshots. These are
not shipped to any deployment target -- serve them locally while the unpacked
extension is loaded.

## Capture recipe

```sh
cd docs/screenshots
python3 -m http.server 8765
```

Then in Arc/Chrome (with the unpacked extension loaded):

- Light browser theme, no other extensions showing, bookmarks bar off
- One tab
- Zoom 100%
- Window sized to ~1400x900 so the captured inner area is close to 1280x800
- Cmd+Shift+4 then Space on macOS to capture a single window cleanly

## Pages

- `compose.html` -- email compose mock with a sloppy draft. Capture:
  1. **Hero**: the compose with inline marks visible, badge in the corner
     (no popover open).
  2. **Popover**: click the badge; capture with the popover open and the
     Fix-all button visible.
- `article.html` -- blog post with a full article of slop prose. Capture:
  3. **Read-only scan**: open the popup, click "Scan this page", capture
     with wavy underlines in the article body and the results panel
     visible in the bottom-right.
- `fix-all.html` -- before/after panels demonstrating char fixes. Capture:
  4. **Fix-all**: the Before panel with marks and the Fix-all button in
     the popover, next to the After panel (clean).
- Options page (no mock -- open `chrome-extension://<id>/options.html` from
  the extension directly). Capture:
  5. **Options + privacy**: scroll so the pack toggles and privacy bullet
     list are both visible.

## Crop / export

- Crop to 1280x800 for Chrome Web Store
- For AMO also accept: 1200x900 or the original capture size
- Save as PNG (no JPEG; stores prefer lossless for text-heavy shots)
