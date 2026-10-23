# OpenMidi

Free and open-source, web-based lighting controller for the **PartyKeys** MIDI keyboard.

## Features

- **Two lighting modes**
  - **Always on**: every key shows its color, and a key turns white while you press it.
  - **Light on press**: keys stay dark and show their color only while pressed.
- **Per-key colors**: turn on *Paint keys*, then click or drag across the on-screen keyboard. Right-click a key to pick up its color.
- **Hex colors**: type any hex code (`#FF2E63`, `ff2e63` or `f26`) and press *Set whole keyboard to this color* (or Enter) to make the keyboard a single color.
- **Presets**: load a built-in preset with one click, save your own, and import or export them as JSON.
- Brightness control, octave-shift tracking and hot-plug reconnect.

## Running it

Web MIDI with SysEx only works in **Chrome or Edge** (desktop or Android), and only on `https://` or `localhost`.

- **GitHub Pages**: enable Pages for this repo and open the site.
- **Locally**: serve the folder, then open http://localhost:8000:

  ```bash
  python -m http.server 8000
  ```

Plug in the keyboard, click **Connect**, and allow MIDI access when the browser asks.

## Protocols

OpenMidi follows the [PartyKeys lighting protocol](https://protocol.partykeys.org/#verified-lighting) and picks a profile from the device name:

| Device | Profile | Colors |
|---|---|---|
| PartyKeys 36 over USB | Direct RGB (`CMD 0x15`, mode `0F 01`) | Full 24-bit RGB |
| PartyStudio / SAM5704 speaker relay | Palette (`CMD 0x71`, mode `0F 05`, at most 3 pairs per frame, 8 ms pacing) | Snapped to the 12 firmware palette colors plus white |

You can switch the profile from the drop-down next to the device picker. Lighting never uses Note On messages, so it can't echo back as fake key presses.

## Files

```
index.html        UI markup
css/style.css     Styles
js/partykeys.js   Lighting driver (SysEx framing, pacing, color helpers)
js/presets.js     Built-in presets and preset storage
js/app.js         App logic: keyboard, modes, colors, presets, MIDI I/O
```

No build step and no dependencies.

## License

MIT
