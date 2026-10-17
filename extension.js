import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {translate} from './translations.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ModalDialog} from 'resource:///org/gnome/shell/ui/modalDialog.js';

function lines(output) {
    return output.split('\n').map(line => line.trim()).filter(Boolean);
}

function isRebootSensitive(name) {
    return /^(linux($|-)|nvidia($|-)|nvidia-open($|-)|mesa$|xf86-video-|vulkan-|amd-ucode$|intel-ucode$|systemd$|glibc$|linux-firmware$)/i.test(name);
}

function parseUpdates(output, source) {
    return lines(output).map(line => {
        if (source === 'Flatpak') {
            const [name, branch = '', version = ''] = line.split(/\s+/);
            if (!name)
                return null;
            return {name, installed: '', version: version || branch, source, reboot: false};
        }
        const match = line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/);
        if (!match)
            return null;
        return {name: match[1], installed: match[2], version: match[3], source, reboot: isRebootSensitive(match[1])};
    }).filter(Boolean);
}

function run(argv) {
    return new Promise(resolve => {
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.setenv('LC_ALL', 'C', true);
            const proc = launcher.spawnv(argv);
            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(result);
                    resolve({ok: p.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
                } catch (error) {
                    resolve({ok: false, stdout: '', stderr: error.message});
                }
            });
        } catch (error) {
            resolve({ok: false, stdout: '', stderr: error.message});
        }
    });
}

const DetailsDialog = GObject.registerClass(
class DetailsDialog extends ModalDialog {
    constructor(extension, packages) {
        super();
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'arch-upman-dialog-content',
            x_expand: true,
            y_expand: true,
        });
        content.add_child(new St.Label({
            text: extension._t('UPDATE DETAILS'),
            style_class: 'title-2',
            x_align: Clutter.ActorAlign.START,
        }));

        const scroll = new St.ScrollView({overlay_scrollbars: false, x_expand: true, y_expand: true});
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        scroll.set_child(list);

        for (const source of ['Pacman', 'AUR', 'Flatpak']) {
            const group = packages.filter(pkg => pkg.source === source);
            if (!group.length)
                continue;

            const title = source === 'Pacman'
                ? extension._t('PACMAN — OFFICIAL REPOSITORIES')
                : source.toUpperCase();
            list.add_child(new St.Label({
                text: `${title} (${group.length})`,
                style_class: 'heading',
                x_align: Clutter.ActorAlign.START,
                style: 'margin-top: 14px; margin-bottom: 5px;',
            }));

            for (const pkg of group) {
                const row = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    x_expand: true,
                    style_class: pkg.reboot ? 'arch-upman-reboot-row' : 'arch-upman-package-row',
                });
                const marker = pkg.reboot ? '● ' : '  ';
                row.add_child(new St.Label({
                    text: `${marker}${pkg.name}`,
                    x_align: Clutter.ActorAlign.START,
                    x_expand: true,
                    style: 'font-family: monospace; min-width: 250px;',
                }));
                const versions = pkg.installed && pkg.version
                    ? `${pkg.installed} → ${pkg.version}`
                    : (pkg.version || extension._t('Update available'));
                row.add_child(new St.Label({
                    text: versions,
                    x_align: Clutter.ActorAlign.END,
                    style: 'font-family: monospace;',
                }));
                list.add_child(row);
            }
        }

        if (packages.some(pkg => pkg.reboot)) {
            list.add_child(new St.Label({
                text: `● ${extension._t('A system restart is recommended')}`,
                style_class: 'arch-upman-reboot-legend',
                x_align: Clutter.ActorAlign.START,
                style: 'margin-top: 14px;',
            }));
        }
        list.add_child(new St.Label({
            text: `${extension._t('Total')}: ${packages.length} ${extension._t('updates')}`,
            x_align: Clutter.ActorAlign.START,
            style: 'font-weight: bold; margin-top: 8px;',
        }));
        if (!packages.length) {
            list.add_child(new St.Label({
                text: extension._t('No updates available.'),
                x_align: Clutter.ActorAlign.START,
            }));
        }

        content.add_child(scroll);
        this.contentLayout.add_child(content);
        this.setButtons([{
            label: extension._t('Close'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }]);
    }
});

export default class ArchUpManExtension extends Extension {
    _t(message) {
        const language = this._settings?.get_string('language') ?? 'en';
        return translate(this.path, message, language);
    }

    enable() {
        this._settings = this.getSettings();
        this._packages = [];
        this._lastChecked = null;
        this._checking = false;
        this._updating = false;
        this._signals = [];
        this._timeoutId = null;

        this._button = new PanelMenu.Button(0.0, 'Arch UpMan', false);
        // Use a dedicated CSS class so the panel theme's default horizontal padding is overridden.
        this._button.add_style_class_name('arch-upman-panel-button');
        // Keep a single child in the panel button; the inner box lays out the icon and count.
        this._panelBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 1px;',
        });
        this._panelLabel = new St.Icon({
            icon_name: 'software-update-urgent-symbolic',
            style_class: 'system-status-icon',
        });
        this._updateCountLabel = new St.Label({
            text: '',
            style_class: 'arch-upman-update-count',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._archLogo = new Gio.FileIcon({
            file: Gio.File.new_for_path(`${this.path}/archlinux-logo-gray.svg`),
        });
        this._archLogoBlue = new Gio.FileIcon({
            file: Gio.File.new_for_path(`${this.path}/archlinux-logo-blue.svg`),
        });
        this._panelBox.add_child(this._panelLabel);
        this._panelBox.add_child(this._updateCountLabel);
        this._button.add_child(this._panelBox);
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._applyPanelPosition();

        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'language') {
                this._rebuildMenu();
                return;
            }
            this._restartTimer();
            this._applyIndicatorAppearance();
            this._rebuildMenu();
            this._checkUpdates();
        });
        this._positionSignals = [
            'changed::enable-panel-positioning',
            'changed::panel-position',
            'changed::panel-position-index',
        ].map(signal => this._settings.connect(signal, () => this._applyPanelPosition()));
        this._restartTimer();
        this._rebuildMenu();
        this._checkUpdates();
    }

    disable() {
        if (this._completionCheckId) {
            GLib.Source.remove(this._completionCheckId);
            this._completionCheckId = null;
        }
        if (this._completionFile) {
            try {
                Gio.File.new_for_path(this._completionFile).delete(null);
            } catch (_) {
                // Ignore cleanup errors for the temporary marker.
            }
            this._completionFile = null;
        }
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._settings && this._settingsSignal)
            this._settings.disconnect(this._settingsSignal);
        this._settingsSignal = null;
        if (this._settings && this._positionSignals) {
            for (const signal of this._positionSignals)
                this._settings.disconnect(signal);
        }
        this._positionSignals = null;
        this._button?.destroy();
        this._button = null;
        this._settings = null;
    }

    _applyPanelPosition() {
        if (!this._button || !this._settings)
            return;

        const container = this._button.container;
        if (!container)
            return;

        const enabled = this._settings.get_boolean('enable-panel-positioning');
        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
        const region = enabled ? this._settings.get_string('panel-position') : 'right';
        const target = boxes[region] ?? Main.panel._rightBox;
        const parent = container.get_parent();
        if (parent)
            parent.remove_child(container);

        if (enabled) {
            const requestedIndex = this._settings.get_int('panel-position-index');
            const index = Math.max(0, Math.min(requestedIndex, target.get_n_children()));
            target.insert_child_at_index(container, index);
        } else {
            target.add_child(container);
        }
    }

    _restartTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (!this._settings.get_boolean('auto-check'))
            return;

        const interval = Math.max(1, this._settings.get_int('check-interval')) * 60;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._checkUpdates();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _makeArchIcon(color) {
        try {
            const [, contents] = GLib.file_get_contents(`${this.path}/archlinux-logo-gray.svg`);
            const svg = new TextDecoder().decode(contents).replace(/#999999/gi, color);
            const bytes = GLib.Bytes.new(new TextEncoder().encode(svg));
            return Gio.BytesIcon.new(bytes);
        } catch (error) {
            console.error(`[Arch UpMan] Could not create colored Arch logo: ${error.message}`);
            return new Gio.FileIcon({file: Gio.File.new_for_path(`${this.path}/archlinux-logo-gray.svg`)});
        }
    }

    _applyIndicatorAppearance() {
        if (!this._settings || !this._panelLabel || !this._updateCountLabel)
            return;
        const count = this._packages.length;
        const iconColor = this._settings.get_string(count > 0 ? 'icon-color-updates' : 'icon-color-no-updates');
        this._panelLabel.set_gicon(this._makeArchIcon(iconColor));
        this._panelLabel.set_style(`icon-size: ${this._settings.get_int('icon-size')}px;`);
        this._panelLabel.opacity = 255;
        this._updateCountLabel.set_style(
            `font-size: ${this._settings.get_int('count-font-size')}px; ` +
            `color: ${this._settings.get_string('count-font-color')}; font-weight: bold; ` +
            'padding-left: 0; padding-right: 0;'
        );
        this._updateCountLabel.x_align = Clutter.ActorAlign.START;
        this._updateCountLabel.set_text(count > 0 ? String(count) : '');
        this._updateCountLabel.visible = count > 0;
    }

    _rebuildMenu() {
        if (!this._button || !this._settings)
            return;

        this._button.menu.removeAll();
        const checkedText = this._lastChecked
            ? GLib.DateTime.new_from_unix_local(this._lastChecked).format(this._t('Last checked: %d/%m/%Y, %H:%M:%S'))
            : this._t('Last checked: not yet');
        const checked = new PopupMenu.PopupMenuItem(checkedText);
        checked.setSensitive(false);
        this._button.menu.addMenuItem(checked);

        const count = this._packages.length;
        const detailText = count === 1
            ? this._t('1 update available')
            : this._t('%d updates available').replace('%d', String(count));
        const detail = new PopupMenu.PopupSubMenuMenuItem(detailText, false);
        detail.setSensitive(!this._checking);

        for (const source of ['Pacman', 'AUR', 'Flatpak']) {
            const group = this._packages.filter(pkg => pkg.source === source);
            if (!group.length)
                continue;

            const title = source === 'Pacman'
                ? this._t('PACMAN — OFFICIAL REPOSITORIES')
                : source.toUpperCase();
            const heading = new PopupMenu.PopupMenuItem(`${title} (${group.length})`);
            heading.setSensitive(false);
            detail.menu.addMenuItem(heading);

            for (const pkg of group) {
                const marker = pkg.reboot ? '● ' : '';
                const versions = pkg.installed && pkg.version
                    ? `${pkg.installed} → ${pkg.version}`
                    : (pkg.version || this._t('Update available'));
                const item = new PopupMenu.PopupMenuItem(`${marker}${pkg.name}    ${versions}`);
                item.setSensitive(false);
                detail.menu.addMenuItem(item);
            }
        }

        if (this._packages.some(pkg => pkg.reboot)) {
            const restart = new PopupMenu.PopupMenuItem(`● ${this._t('A system restart is recommended')}`);
            restart.setSensitive(false);
            detail.menu.addMenuItem(restart);
        }
        const total = new PopupMenu.PopupMenuItem(`${this._t('Total')}: ${count} ${this._t('updates')}`);
        total.setSensitive(false);
        detail.menu.addMenuItem(total);
        this._button.menu.addMenuItem(detail);

        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const check = new PopupMenu.PopupMenuItem(
            this._checking ? this._t('Checking for updates…') : this._t('Check for updates'));
        check.setSensitive(!this._checking && !this._updating);
        check.connect('activate', () => this._checkUpdates());
        this._button.menu.addMenuItem(check);

        const update = new PopupMenu.PopupMenuItem(
            this._updating ? this._t('Updating…') : this._t('Update'));
        update.setSensitive(count > 0 && !this._checking && !this._updating);
        update.connect('activate', () => this._launchUpdate());
        this._button.menu.addMenuItem(update);

        if (this._settings.get_boolean('clean-orphans') ||
            this._settings.get_boolean('clean-pacman-cache') ||
            this._settings.get_boolean('clean-flatpak-unused')) {
            const maintenance = new PopupMenu.PopupMenuItem(this._t('Maintenance…'));
            maintenance.setSensitive(!this._checking && !this._updating);
            maintenance.connect('activate', () => this._launchMaintenance());
            this._button.menu.addMenuItem(maintenance);
        }

        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem(this._t('Preferences'));
        prefs.connect('activate', () => this.openPreferences());
        this._button.menu.addMenuItem(prefs);

        this._applyIndicatorAppearance();
    }

    async _checkUpdates() {
        if (!this._settings || this._checking || this._updating)
            return;

        const enabled = {
            pacman: this._settings.get_boolean('check-pacman'),
            aur: this._settings.get_boolean('check-aur'),
            flatpak: this._settings.get_boolean('check-flatpak'),
        };
        this._checking = true;
        this._rebuildMenu();
        const found = [];

        if (enabled.pacman) {
            const result = await run(['checkupdates']);
            if (result.ok) {
                found.push(...parseUpdates(result.stdout, 'Pacman'));
            } else if (result.stderr.trim() || result.stdout.trim()) {
                this._notifyError('Pacman', result.stderr || result.stdout || this._t('Could not check for updates. Install pacman-contrib if checkupdates is missing.'));
            }
        }

        if (enabled.aur) {
            let helper = null;
            for (const name of ['yay', 'paru']) {
                const result = await run(['/usr/bin/sh', '-lc', `command -v ${name}`]);
                if (result.ok && result.stdout.trim()) {
                    helper = name;
                    break;
                }
            }
            if (helper) {
                const result = await run([helper, '-Qua']);
                if (result.ok)
                    found.push(...parseUpdates(result.stdout, 'AUR'));
                else if (result.stderr.trim() || result.stdout.trim())
                    this._notifyError('AUR', result.stderr || result.stdout || this._t('Could not check AUR updates.'));
            } else {
                this._notifyError('AUR', this._t('No AUR helper found (yay or paru).'));
            }
        }

        if (enabled.flatpak) {
            const [result, installedResult] = await Promise.all([
                run(['flatpak', 'remote-ls', '--updates', '--columns=application,branch,version']),
                run(['flatpak', 'list', '--columns=application,branch,version']),
            ]);
            if (result.ok) {
                const installed = new Map();
                if (installedResult.ok) {
                    for (const line of lines(installedResult.stdout)) {
                        const [name, branch = '', version = ''] = line.split(/\s+/);
                        if (!name)
                            continue;
                        const key = `${name}\t${branch}`;
                        if (!installed.has(key))
                            installed.set(key, version || branch);
                        const previous = installed.get(name);
                        if (!previous)
                            installed.set(name, version || branch);
                    }
                }
                const flatpakUpdates = result.stdout.split('\n').filter(line => line.trim()).map(line => {
                    const [name, branch = '', version = ''] = line.trim().split(/\s+/);
                    const next = version || branch;
                    const current = installed.get(`${name}\t${branch}`) || installed.get(name) || '';
                    return {name, installed: current !== next ? current : '', version: next, source: 'Flatpak', reboot: false};
                });
                found.push(...flatpakUpdates);
            } else if (result.stderr.trim() || result.stdout.trim()) {
                this._notifyError('Flatpak', result.stderr || result.stdout || this._t('Could not check Flatpak updates.'));
            }
        }

        this._packages = found;
        this._lastChecked = Math.floor(GLib.get_real_time() / 1000000);
        this._checking = false;
        this._rebuildMenu();
    }

    _notifyError(source, message) {
        Main.notify('Arch UpMan', `${source}: ${message.trim()}`);
    }

    _buildTerminalArgv(commands, completionFile) {
        const template = this._settings.get_string('terminal-command').trim();
        if (!template.includes('{command}')) {
            this._notifyError('Arch UpMan', this._t('The terminal command must contain {command}.'));
            return null;
        }

        const command = `${commands.join(' && ')}; status=$?; touch ${GLib.shell_quote(completionFile)}; printf "%s\\n\\n%s\\n" "${this._t('Arch UpMan — process finished with exit code %s.').replace('%s', '$status')}" "${this._t('Press Enter to close this terminal…')}"; read -r`;
        const fullCommand = template.replace('{command}', GLib.shell_quote(command));
        try {
            const [ok, argv] = GLib.shell_parse_argv(fullCommand);
            if (!ok || !argv?.length)
                throw new Error(this._t('Invalid terminal command.'));
            return argv;
        } catch (error) {
            this._notifyError('Arch UpMan', error.message);
            return null;
        }
    }

    _launchCommands(commands) {
        if (!commands.length) {
            Main.notify('Arch UpMan', this._t('No tasks are enabled.'));
            return;
        }
        const completionFile = `${GLib.get_tmp_dir()}/arch-upman-complete-${GLib.uuid_string_random()}`;
        const argv = this._buildTerminalArgv(commands, completionFile);
        if (!argv)
            return;

        this._completionFile = completionFile;
        this._completionCheckId = null;
        this._updating = true;
        this._rebuildMenu();
        // Closing before and after rebuilding releases the Shell popup's keyboard grab.
        this._button?.menu?.close();

        // Refresh as soon as the update command finishes, even while its terminal remains open.
        this._completionCheckId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._completionFile || !GLib.file_test(this._completionFile, GLib.FileTest.EXISTS))
                return GLib.SOURCE_CONTINUE;

            try {
                Gio.File.new_for_path(this._completionFile).delete(null);
            } catch (_) {
                // The completion marker may already have been removed.
            }
            this._completionFile = null;
            this._completionCheckId = null;
            this._updating = false;
            this._rebuildMenu();
            this._checkUpdates();
            return GLib.SOURCE_REMOVE;
        });

        // Spawn on the next main-loop turn, after GNOME Shell has released the popup grab.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
                process.wait_check_async(null, (proc, result) => {
                    try {
                        proc.wait_check_finish(result);
                    } catch (error) {
                        this._notifyError('Arch UpMan', error.message);
                    }
                    if (this._completionCheckId) {
                        GLib.Source.remove(this._completionCheckId);
                        this._completionCheckId = null;
                    }
                    if (this._completionFile) {
                        try {
                            Gio.File.new_for_path(this._completionFile).delete(null);
                        } catch (_) {
                            // The marker may already have been removed by the completion watcher.
                        }
                        this._completionFile = null;
                    }
                    if (this._updating) {
                        this._updating = false;
                        this._rebuildMenu();
                        this._checkUpdates();
                    }
                });
            } catch (error) {
                if (this._completionCheckId) {
                    GLib.Source.remove(this._completionCheckId);
                    this._completionCheckId = null;
                }
                if (this._completionFile) {
                    try {
                        Gio.File.new_for_path(this._completionFile).delete(null);
                    } catch (_) {
                        // Ignore cleanup errors for the temporary marker.
                    }
                    this._completionFile = null;
                }
                this._updating = false;
                this._rebuildMenu();
                this._notifyError('Arch UpMan', error.message);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _launchUpdate() {
        if (this._updating || !this._settings)
            return;

        const pacmanEnabled = this._settings.get_boolean('check-pacman');
        const aurEnabled = this._settings.get_boolean('check-aur');
        const flatpakEnabled = this._settings.get_boolean('check-flatpak');
        const t = key => GLib.shell_quote(this._t(key));
        const commands = [];

        if (pacmanEnabled || aurEnabled || flatpakEnabled) {
            const script = [
                'export LC_ALL=C',
                'has_updates=0',
                'printf "\\n==================================================\\n%s\\n" ' + t('AVAILABLE UPDATES'),
            ];

            if (pacmanEnabled) {
                script.push(
                    'printf "\\n%s\\n" ' + t('PACMAN'),
                    'pacman_preview=$(checkupdates 2>&1); pacman_status=$?',
                    'if [ "$pacman_status" -eq 0 ] && [ -n "$pacman_preview" ]; then printf "%s\\n" "$pacman_preview"; has_updates=1; elif [ "$pacman_status" -eq 2 ] || { [ "$pacman_status" -eq 0 ] && [ -z "$pacman_preview" ]; }; then printf "%s\\n" ' + t('No updates available.' ) + '; else printf "%s\\n%s\\n" ' + t('Could not check Pacman updates:') + ' "$pacman_preview"; preview_error=1; fi'
                );
            }

            if (aurEnabled) {
                script.push(
                    'printf "\\n%s\\n" ' + t('AUR'),
                    'if command -v yay >/dev/null 2>&1; then aur_preview=$(yay -Qua 2>&1); aur_status=$?; elif command -v paru >/dev/null 2>&1; then aur_preview=$(paru -Qua 2>&1); aur_status=$?; else aur_preview=' + t('No AUR helper found (yay or paru).') + '; aur_status=127; fi',
                    'if [ "$aur_status" -eq 0 ] || { [ "$aur_status" -eq 1 ] && [ -z "$aur_preview" ]; }; then if [ -n "$aur_preview" ]; then printf "%s\\n" "$aur_preview"; has_updates=1; else printf "%s\\n" ' + t('No updates available.') + '; fi; else printf "%s\\n%s\\n" ' + t('Could not check AUR updates:') + ' "$aur_preview"; preview_error=1; fi'
                );
            }

            if (flatpakEnabled) {
                script.push(
                    'printf "\\n%s\\n" ' + t('FLATPAK'),
                    'flatpak_preview=$(flatpak remote-ls --updates --columns=application,branch,version 2>&1); flatpak_status=$?',
                    'if [ "$flatpak_status" -eq 0 ]; then if [ -n "$flatpak_preview" ]; then printf "%s\\n" "$flatpak_preview"; has_updates=1; else printf "%s\\n" ' + t('No updates available.') + '; fi; else printf "%s\\n%s\\n" ' + t('Could not check Flatpak updates:') + ' "$flatpak_preview"; preview_error=1; fi'
                );
            }

            script.push(
                'if [ "${preview_error:-0}" -eq 1 ]; then printf "\\n%s\\n" ' + t('Update check failed. No updates were started; resolve the errors above and try again.') + '; else',
                '  if [ "$has_updates" -eq 1 ]; then',
                '    printf "\\n%s\\n" ' + t('Start installing the updates listed above? [Y/n]'),
                '    read -r answer',
                '    answer=${answer:-y}',
                '    case "$answer" in y|Y|yes|YES|s|S|sim|SIM)',
                '      printf "\\n%s\\n\\n" ' + t('Starting updates…'),
            );

            if (pacmanEnabled && aurEnabled) {
                script.push('      if command -v yay >/dev/null 2>&1; then printf "\\n%s\\n\\n" ' + t('At the AUR helper prompt “Packages to exclude”, press Enter without typing anything to continue without excluding packages.') + '; yay -Syu; elif command -v paru >/dev/null 2>&1; then printf "\\n%s\\n\\n" ' + t('At the AUR helper prompt “Packages to exclude”, press Enter without typing anything to continue without excluding packages.') + '; paru -Syu; else sudo pacman -Syu; fi');
            } else if (pacmanEnabled) {
                script.push('      sudo pacman -Syu');
            } else if (aurEnabled) {
                script.push('      if command -v yay >/dev/null 2>&1; then printf "\\n%s\\n\\n" ' + t('At the AUR helper prompt “Packages to exclude”, press Enter without typing anything to continue without excluding packages.') + '; yay -Sua; elif command -v paru >/dev/null 2>&1; then printf "\\n%s\\n\\n" ' + t('At the AUR helper prompt “Packages to exclude”, press Enter without typing anything to continue without excluding packages.') + '; paru -Sua; else printf "%s\\n" ' + t('No AUR helper found (yay or paru).') + '; false; fi');
            }

            if (flatpakEnabled)
                script.push('      flatpak update');

            script.push(
                '      ;;',
                '      *) printf "\\n%s\\n" ' + t('Update cancelled. No updates were installed.') + ';;',
                '    esac',
                '  else printf "\\n%s\\n" ' + t('No updates available for the selected sources.') + '; fi',
                'fi'
            );
            commands.push(script.join('\n'));
        }

        this._launchCommands(commands);
    }

    _launchMaintenance() {
        if (this._updating || !this._settings)
            return;

        const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
        const message = key => shellQuote(this._t(key));
        const commands = [];

        if (this._settings.get_boolean('clean-orphans')) {
            commands.push([
                'export LC_ALL=C',
                'printf "\\n==================================================\\n\\n"',
                'printf "%s\\n\\n" ' + message('ORPHAN PACKAGES — INCLUDING AUR DEPENDENCIES'),
                'printf "%s\\n" ' + message('Packages marked as dependencies that are no longer required by any installed package.'),
                'orphans_output=$(pacman -Qtdq 2>&1); orphan_status=$?',
                'if [ "$orphan_status" -ne 0 ] && [ -n "$orphans_output" ]; then printf "%s\\n%s\\n" ' + message('Could not query orphan packages:') + ' "$orphans_output"; false; fi',
                'orphans=(); if [ -n "$orphans_output" ]; then mapfile -t orphans <<< "$orphans_output"; fi',
                'if [ -z "$orphans_output" ]; then printf "\\n%s\\n\\n%s\\n" ' + message('Count: 0 packages') + ' ' + message('No orphan packages to remove.') + '; else',
                '  printf ' + shellQuote('\\n' + this._t('Count: %s package(s)') + '\\n\\n') + ' "${#orphans[@]}"',
                '  for p in "${orphans[@]}"; do [ -n "$p" ] || continue; info=$(pacman -Q "$p" 2>/dev/null || printf "%s (%s)" "$p" ' + message('version unavailable') + '); if pacman -Qm "$p" >/dev/null 2>&1; then source_label=' + message('AUR/external') + '; else source_label=' + message('official repository') + '; fi; printf "  • %s  [%s]\\n" "$info" "$source_label"; done',
                'fi'
            ].join('\n'));
        }

        if (this._settings.get_boolean('clean-pacman-cache')) {
            commands.push([
                'export LC_ALL=C',
                'printf "\\n==================================================\\n\\n"',
                'printf "%s\\n\\n" ' + message('PACMAN PACKAGE CACHE'),
                'printf "%s\\n" ' + message('Older package versions eligible for removal; the three newest versions per package will be kept.'),
                'if ! command -v paccache >/dev/null 2>&1; then printf "%s\\n" ' + message('paccache was not found (pacman-contrib package).') + '; false; fi',
                'cache_preview=$(paccache -d -v -v 2>&1); cache_status=$?',
                'if [ "$cache_status" -ne 0 ]; then printf "%s\\n%s\\n" ' + message('Could not inspect the cache:') + ' "$cache_preview"; false; fi',
                'if printf "%s\\n" "$cache_preview" | grep -qi "no candidate packages found for pruning"; then printf "\\n%s\\n\\n%s\\n" ' + message('Count: 0 package files') + ' ' + message('No cache files are eligible for removal.') + '; else',
                '  cache_files=$(printf "%s\\n" "$cache_preview" | grep -E "\\.pkg\\.tar\\.(zst|xz|gz|bz2|lzo|lrz|lzip|Z)(\\.sig)?$" || true)',
                '  if [ -n "$cache_files" ]; then cache_count=$(printf "%s\\n" "$cache_files" | wc -l | tr -d " "); printf ' + shellQuote('\\n' + this._t('Count: %s package file(s)') + '\\n\\n') + ' "$cache_count"; printf "%s\\n" "$cache_files" | sed "s/^/  • /"; else printf "%s\\n" ' + message('Eligible cache files reported by paccache:') + '; printf "%s\\n" "$cache_preview"; fi',
                'fi'
            ].join('\n'));
        }

        if (this._settings.get_boolean('clean-flatpak-unused')) {
            commands.push([
                'export LC_ALL=C',
                'printf "\\n==================================================\\n\\n"',
                'printf "%s\\n\\n" ' + message('UNUSED FLATPAK DEPENDENCIES'),
                'printf "%s\\n" ' + message('Flatpak checks for runtimes and components that are no longer required. Pinned components are preserved.'),
                'flatpak_preview=$(printf "n\\n" | flatpak uninstall --unused 2>&1); flatpak_status=$?',
                'if [ "$flatpak_status" -ne 0 ]; then printf ' + shellQuote(this._t('Flatpak query exited with status %s:') + '\n') + ' "$flatpak_status"; printf "%s\\n" "$flatpak_preview"; false; fi',
                'if printf "%s\\n" "$flatpak_preview" | grep -Eqi "nothing to uninstall|nothing unused|no unused"; then printf "\\n%s\\n\\n%s\\n" ' + message('Count: 0 components') + ' ' + message('No unused Flatpak dependencies to remove.') + '; pinned_refs=$(printf "%s\\n" "$flatpak_preview" | grep -Eo "runtime/[^[:space:]]+" | sort -u || true); if [ -n "$pinned_refs" ]; then printf "\\n%s\\n" ' + message('Pinned components that will be preserved:') + '; printf "%s\\n" "$pinned_refs" | sed "s/^/  • /"; fi; else',
                '  flatpak_refs=$(printf "%s\\n" "$flatpak_preview" | grep -E "^[[:space:]]*(app|runtime)/" || true)',
                '  if [ -n "$flatpak_refs" ]; then flatpak_count=$(printf "%s\\n" "$flatpak_refs" | wc -l | tr -d " "); printf ' + shellQuote('\\n' + this._t('Count: %s component(s)') + '\\n\\n') + ' "$flatpak_count"; printf "%s\\n" "$flatpak_refs" | sed "s/^/  • /"; else printf "%s\\n" ' + message('Flatpak preview:') + '; printf "%s\\n" "$flatpak_preview"; fi',
                'fi'
            ].join('\n'));
        }

        commands.push([
            'export LC_ALL=C',
            'printf "\\n==================================================\\n\\n"',
            'printf "%s\\n\\n" ' + message('MAINTENANCE SUMMARY'),
            'printf "%s\\n" ' + message('The preview above did not remove any items.'),
            'printf "\\n%s " ' + message('Run cleanup for the enabled categories? [y/N]'),
            'read -r answer',
            'case "$answer" in y|Y|yes|YES|s|S|sim|SIM)',
            '  printf "%s\\n" ' + message('Starting cleanup...'),
            '  if ' + (this._settings.get_boolean('clean-orphans') ? 'true' : 'false') + '; then if [ -n "$orphans_output" ]; then mapfile -t orphan_array <<< "$orphans_output"; sudo pacman -Rns -- "${orphan_array[@]}"; else printf "%s\\n" ' + message('Orphan packages: nothing to remove; skipping this step.') + '; fi; fi',
            '  if ' + (this._settings.get_boolean('clean-pacman-cache') ? 'true' : 'false') + '; then if printf "%s\\n" "$cache_preview" | grep -qi "no candidate packages found for pruning"; then printf "%s\\n" ' + message('Pacman cache: nothing to remove; skipping this step.') + '; elif command -v paccache >/dev/null 2>&1; then sudo paccache -r; else printf "%s\\n" ' + message('Pacman cache: paccache is not installed; skipping this step.') + '; fi; fi',
            '  if ' + (this._settings.get_boolean('clean-flatpak-unused') ? 'true' : 'false') + '; then if printf "%s\\n" "$flatpak_preview" | grep -Eqi "nothing to uninstall|nothing unused|no unused"; then printf "%s\\n" ' + message('Flatpak: nothing to remove; skipping this step.') + '; else flatpak uninstall --unused --assumeyes; fi; fi',
            '  ;;',
            '  *) printf "%s\\n" ' + message('Cleanup cancelled. No items were removed.') + '; ;;',
            'esac'
        ].join('\n'));
        this._launchCommands(commands);
    }
}
