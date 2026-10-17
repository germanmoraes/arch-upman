import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {listTranslations, translate} from './translations.js';

export default class ArchUpManPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const language = settings.get_string('language');
        const _ = text => translate(this.path, text, language);
        const page = new Adw.PreferencesPage();
        window.add(page);

        const languageGroup = new Adw.PreferencesGroup({title: _('Language')});
        page.add(languageGroup);
        const availableLanguages = listTranslations(this.path);
        const languageIds = ['system', ...availableLanguages.map(item => item.id)];
        const languageNames = [_('System Default'), ...availableLanguages.map(item => item.name)];
        const languageModel = Gtk.StringList.new(languageNames);
        const languageRow = new Adw.ComboRow({
            title: _('Language'),
            subtitle: _('Choose the interface language. System Default follows the GNOME language.'),
            model: languageModel,
        });
        const currentLanguage = settings.get_string('language');
        const selectedLanguage = languageIds.indexOf(currentLanguage);
        languageRow.set_selected(selectedLanguage >= 0 ? selectedLanguage : 0);
        languageRow.connect('notify::selected', row => {
            const selected = row.get_selected();
            if (selected >= 0 && selected < languageIds.length)
                settings.set_string('language', languageIds[selected]);
        });
        languageGroup.add(languageRow);

        const sources = new Adw.PreferencesGroup({title: _('Update sources')});
        page.add(sources);
        for (const [key, title, subtitle] of [
            ['check-pacman', 'Pacman', _('Official Arch Linux repositories')],
            ['check-aur', 'AUR', _('Check using yay or paru')],
            ['check-flatpak', 'Flatpak', _('Flatpak applications and runtimes')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            sources.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        const positionGroup = new Adw.PreferencesGroup({
            title: _('Panel position'),
            description: _('Choose where Arch UpMan appears and its order among panel indicators.'),
        });
        page.add(positionGroup);

        const enablePosition = new Adw.SwitchRow({
            title: _('Enable panel positioning'),
            subtitle: _('Allow choosing the panel region and horizontal order.'),
        });
        positionGroup.add(enablePosition);
        settings.bind('enable-panel-positioning', enablePosition, 'active', Gio.SettingsBindFlags.DEFAULT);

        const positionValues = ['left', 'center', 'right'];
        const positionModel = Gtk.StringList.new([_('Left'), _('Center'), _('Right')]);
        const positionRow = new Adw.ComboRow({
            title: _('Panel region'),
            subtitle: _('Left, center or right section of the top panel.'),
            model: positionModel,
        });
        positionRow.set_selected(Math.max(0, positionValues.indexOf(settings.get_string('panel-position'))));
        positionRow.connect('notify::selected', row => {
            settings.set_string('panel-position', positionValues[row.get_selected()] ?? 'right');
        });
        settings.bind('enable-panel-positioning', positionRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        positionGroup.add(positionRow);

        const indexRow = new Adw.ActionRow({
            title: _('Order within the section'),
            subtitle: _('Lower numbers appear earlier; 0 places it first.'),
        });
        const positionIndex = Gtk.SpinButton.new_with_range(0, 100, 1);
        positionIndex.set_valign(Gtk.Align.CENTER);
        positionIndex.set_value(settings.get_int('panel-position-index'));
        positionIndex.connect('value-changed', () => settings.set_int('panel-position-index', positionIndex.get_value_as_int()));
        settings.bind('enable-panel-positioning', indexRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        indexRow.add_suffix(positionIndex);
        positionGroup.add(indexRow);

        const appearance = new Adw.PreferencesGroup({
            title: _('Panel indicator appearance'),
            description: _('Customize the Arch logo and update count shown in the top panel.'),
        });
        page.add(appearance);

        const addColorSetting = (key, title, subtitle) => {
            const row = new Adw.ActionRow({title: _(title), subtitle: _(subtitle)});
            const dialog = new Gtk.ColorDialog({with_alpha: false});
            const colorButton = new Gtk.ColorDialogButton({dialog});
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(settings.get_string(key)))
                rgba.parse('#ffffff');
            colorButton.set_rgba(rgba);
            colorButton.connect('notify::rgba', () => {
                const color = colorButton.get_rgba();
                const hex = value => Math.max(0, Math.min(255, Math.round(value * 255)))
                    .toString(16).padStart(2, '0');
                settings.set_string(key, `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`);
            });
            row.add_suffix(colorButton);
            appearance.add(row);
        };

        addColorSetting('icon-color-updates', 'Icon color — updates available', 'Color of the Arch logo when updates are available.');
        addColorSetting('icon-color-no-updates', 'Icon color — no updates', 'Color of the Arch logo when no updates are available.');

        const addSizeSetting = (key, title, subtitle, min, max) => {
            const row = new Adw.ActionRow({title: _(title), subtitle: _(subtitle)});
            const spin = Gtk.SpinButton.new_with_range(min, max, 1);
            spin.set_valign(Gtk.Align.CENTER);
            spin.set_value(settings.get_int(key));
            spin.connect('value-changed', () => settings.set_int(key, spin.get_value_as_int()));
            row.add_suffix(spin);
            appearance.add(row);
        };
        addSizeSetting('icon-size', 'Icon size', 'Arch logo size in pixels (8–32).', 8, 32);
        addSizeSetting('count-font-size', 'Update count font size', 'Number size in pixels (8–24).', 8, 24);
        addColorSetting('count-font-color', 'Update count font color', 'Color of the update count text.');

        const schedule = new Adw.PreferencesGroup({title: _('Automatic checks')});
        page.add(schedule);
        const auto = new Adw.SwitchRow({
            title: _('Check automatically'),
            subtitle: _('When the extension starts and periodically'),
        });
        schedule.add(auto);
        settings.bind('auto-check', auto, 'active', Gio.SettingsBindFlags.DEFAULT);

        const intervalRow = new Adw.ActionRow({
            title: _('Check interval'),
            subtitle: _('Minutes (1–60)'),
        });
        const interval = Gtk.SpinButton.new_with_range(1, 60, 1);
        interval.set_valign(Gtk.Align.CENTER);
        interval.set_value(settings.get_int('check-interval'));
        interval.connect('value-changed', () => settings.set_int('check-interval', interval.get_value_as_int()));
        intervalRow.add_suffix(interval);
        schedule.add(intervalRow);

        const cleanup = new Adw.PreferencesGroup({
            title: _('Maintenance'),
            description: _('These actions are not run during normal updates. Review the terminal output before confirming any removal.'),
        });
        page.add(cleanup);
        for (const [key, title, subtitle] of [
            ['clean-orphans', _('Clean orphan packages'), _('Lists the packages and asks before removing them with Pacman')],
            ['clean-pacman-cache', _('Clean Pacman package cache'), _('Shows a preview and asks before removing older cached versions; keeps the latest three by default')],
            ['clean-flatpak-unused', _('Remove unused Flatpak components'), _('Flatpak displays what it proposes to remove and asks for confirmation')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            cleanup.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        const terminal = new Adw.PreferencesGroup({
            title: _('Terminal'),
            description: _('The command must contain {command}. Example: kgx -- bash -lc {command}'),
        });
        page.add(terminal);
        const terminalRow = new Adw.EntryRow({title: _('Terminal command')});
        terminalRow.set_text(settings.get_string('terminal-command'));
        terminalRow.connect('changed', () => settings.set_string('terminal-command', terminalRow.get_text()));
        terminal.add(terminalRow);
    }
}
