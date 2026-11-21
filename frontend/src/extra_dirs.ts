// Settings and the library share this browser's saved folders.
import { useEffect, useState } from "react"
import { cleanDirs, KEY, readExtraDirs, writeExtraDirs } from "./folder_url.ts"

/** The list, kept in step with this app's other windows. */
export function useExtraDirs(): [string[], (dirs: string[]) => void] {
    const [dirs, setDirs] = useState(readExtraDirs)
    useEffect(() => {
        const update = (event: StorageEvent) => {
            if (event.key === KEY) {
                setDirs(readExtraDirs())
            }
        }
        addEventListener("storage", update)
        return () => removeEventListener("storage", update)
    }, [])
    const set = (next: string[]) => {
        const clean = cleanDirs(next)
        writeExtraDirs(clean)
        setDirs(clean)
    }
    return [dirs, set]
}

/** "…/robot runs" → "robot runs" */
export const folderName = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() || dir
