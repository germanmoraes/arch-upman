import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const _catalogCache = new Map();

function normalizeLocale(locale) {
    return String(locale ?? '')
        .split('.')[0]
        .split('@')[0]
        .replaceAll('-', '_');
}

function readCatalogDirectory(directoryPath, catalogs, rootDirectory = false) {
    const directory = Gio.File.new_for_path(directoryPath);
    if (!directory.query_exists(null))
        return;

    try {
        const enumerator = directory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const filename = info.get_name();
            if (info.get_file_type() !== Gio.FileType.REGULAR ||
                !filename.endsWith('.json') ||
                (rootDirectory && filename === 'metadata.json'))
                continue;

            const locale = filename.slice(0, -5);
            try {
                const [, bytes] = GLib.file_get_contents(`${directoryPath}/${filename}`);
                const catalog = JSON.parse(new TextDecoder().decode(bytes));
                if (catalog && typeof catalog.name === 'string' &&
                    catalog.translations && typeof catalog.translations === 'object') {
                    catalogs.set(locale, catalog);
                } else {
                    console.error(`[Arch UpMan] Invalid translation catalog: ${filename}`);
                }
            } catch (error) {
                console.error(`[Arch UpMan] Could not load translation ${filename}: ${error.message}`);
            }
        }
        enumerator.close(null);
    } catch (error) {
        console.error(`[Arch UpMan] Could not list translation directory ${directoryPath}: ${error.message}`);
    }
}

function loadCatalogs(extensionPath) {
    if (_catalogCache.has(extensionPath))
        return _catalogCache.get(extensionPath);

    const catalogs = new Map();

    // GNOME's packer flattens extra-source files into the extension root.
    // Scan the root first, then locale/, so source catalogs take precedence in development.
    readCatalogDirectory(extensionPath, catalogs, true);
    readCatalogDirectory(`${extensionPath}/locale`, catalogs);

    _catalogCache.set(extensionPath, catalogs);
    return catalogs;
}

function findCatalog(catalogs, locale) {
    const normalized = normalizeLocale(locale);
    if (!normalized)
        return null;

    if (catalogs.has(normalized))
        return catalogs.get(normalized);

    const language = normalized.split('_')[0];
    for (const [id, catalog] of catalogs) {
        if (id.toLowerCase() === language.toLowerCase())
            return catalog;
    }
    return null;
}

export function listTranslations(extensionPath) {
    const languages = [{id: 'en', name: 'English'}];
    for (const [id, catalog] of loadCatalogs(extensionPath)) {
        languages.push({id, name: catalog.name});
    }
    return languages.sort((a, b) => a.id === 'en' ? -1 : b.id === 'en' ? 1 : a.name.localeCompare(b.name));
}

export function translate(extensionPath, message, preference = 'system') {
    const catalogs = loadCatalogs(extensionPath);
    let catalog = null;

    if (preference === 'system') {
        for (const locale of GLib.get_language_names()) {
            catalog = findCatalog(catalogs, locale);
            if (catalog)
                break;
        }
    } else if (preference !== 'en') {
        catalog = findCatalog(catalogs, preference);
    }

    return catalog?.translations?.[message] ?? message;
}
