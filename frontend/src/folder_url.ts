export const KEY = "dim-recordings.extraDirs"

let pageDirs: string[] = []

export function readExtraDirs(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]")
        return Array.isArray(saved) ? cleanDirs(saved) : []
    } catch {
        return pageDirs // storage blocked: keep this page's selection
    }
}

export function writeExtraDirs(dirs: string[]) {
    pageDirs = dirs
    try {
        localStorage.setItem(KEY, JSON.stringify(dirs))
    } catch {
        // storage blocked (a private window): the list lasts while this page does
    }
}

/** As the backend's cleanDirs (library.ts) keeps them, so the page can tell when a list answers the one it sent. */
export function cleanDirs(list: unknown[]): string[] {
    const dirs = list.filter((dir): dir is string => typeof dir === "string")
        .map((dir) => dir.trim().replace(/(.)\/+$/, "$1"))
    return [...new Set(dirs.filter(Boolean))].slice(0, 64)
}

/** Include the same selection on links, image requests and the playback websocket. */
export function folderUrl(path: string, dirs?: string[]) {
    if (dirs === undefined && !("document" in globalThis)) return path
    return path + (path.includes("?") ? "&" : "?") + "viewFolders=" +
        encodeURIComponent(JSON.stringify(dirs ?? readExtraDirs()))
}
