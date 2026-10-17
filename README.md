# Arch UpMan

Arch UpMan is a GNOME Shell extension for checking available updates on Arch Linux from official Pacman repositories, AUR helpers, and Flatpak. It provides an update indicator, grouped update details, configurable checks, and optional interactive maintenance tasks.

## Features

- Checks official repository updates with `checkupdates` from `pacman-contrib`.
- Checks AUR updates through `yay` or `paru` when either helper is installed.
- Checks Flatpak updates when Flatpak is installed and enabled in preferences.
- Configurable automatic checking interval and update sources.
- Update count and Arch Linux glyph in the GNOME top panel, with configurable appearance.
- Optional panel region/order controls.
- Update details grouped by source and a heuristic restart recommendation.
- Update installation is started only after selecting **Update**.
- Optional maintenance workflow for orphan packages, Pacman cache, and unused Flatpak components. It displays a preview and asks for confirmation before cleanup.
- Configurable terminal command template; defaults to GNOME Console (`kgx`).
- Language selector with system-language detection, English source strings, and discoverable community translation catalogs.

## Requirements

- GNOME Shell 51 (the current metadata targets Shell 51).
- Arch Linux with `pacman`.
- `pacman-contrib` for `checkupdates`.
- `yay` or `paru` for AUR update checks (optional).
- Flatpak for Flatpak update checks (optional).
- A Nerd Font containing the Arch Linux glyph for the panel logo.
- `kgx` (GNOME Console) by default, or another terminal configured in Preferences.

## Local installation / testing

For a local development install, copy the extension directory to:

`~/.local/share/gnome-shell/extensions/arch-upman@germanmoraes.github.io`

Compile the GSettings schema and enable the extension:

```sh
glib-compile-schemas ~/.local/share/gnome-shell/extensions/arch-upman@germanmoraes.github.io/schemas
gnome-extensions enable arch-upman@germanmoraes.github.io
```

On Wayland, logging out and back in may be necessary after installing or changing an extension.

## Packaging

From this repository directory, create a distributable ZIP with GNOME's packaging command:

```sh
gnome-extensions pack . --out-dir "$HOME/Downloads" \
  --gettext-domain=arch-upman \
  --extra-source=archlinux-logo-gray.svg \
  --extra-source=archlinux-logo-blue.svg \
  --extra-source=translations.js \
  --extra-source=locale/pt_BR.json
```

The generated file is `arch-upman@germanmoraes.github.io.shell-extension.zip`. The pack command includes the GSettings XML schema and flattens the extra translation files into the package root, as expected by `translations.js`.

Before submitting a release, validate JavaScript and JSON syntax, compile the schema, inspect the archive with `unzip -t`, and test the packaged extension in a live GNOME Shell session. GNOME Extensions currently targets Shell 51 in `metadata.json`; update this list only after compatibility testing.

## Translations

The original interface strings are written in English. The Preferences language selector always offers **System Default** and **English**, and discovers additional languages from JSON files in `locale/`.

To add a translation, create a locale JSON file with a native-language name and a translations object mapping each original English string to its translation. The filename (without the .json extension) becomes the language ID shown in Preferences. Include translations.js and each catalog in the gnome-extensions pack command using --extra-source=translations.js and --extra-source=locale/<locale>.json; GNOME’s packer flattens extra-source files into the extension root, which the loader also scans. Restart the extension after adding or changing catalogs. Missing strings fall back to English.

The initial Brazilian Portuguese catalog is `locale/pt_BR.json`. Contributions should preserve format placeholders such as `%d`, `{command}`, and date-format directives.

## Current limitations

- The metadata currently targets GNOME Shell 51 only.
- Restart recommendations are heuristic, not a guarantee that a restart is required.
- Maintenance commands can remove packages or components; review the preview carefully and confirm only if appropriate.
- All extension-authored interface messages and maintenance prompts use the English source strings and selectable translation catalog. External package-manager output is requested in English for predictable parsing.

## License

Arch UpMan is distributed under the **GNU General Public License, version 3 or (at your option) any later version**. The full license text is provided in [LICENSE](LICENSE).

Copyright (C) 2026 Germano Fröhlich Moraes.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but **without any warranty**; without even the implied warranty of merchantability or fitness for a particular purpose. See the LICENSE file for details.
