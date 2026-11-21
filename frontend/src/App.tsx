// Hash routes: `#/` the library, `#/transfer` the library with the transfer dialog open (Desktop's "Transfer
// recordings" notification opens this), `#/replay/<id>` the Replayer (views/Replay.tsx).
import { lazy, Suspense, useEffect, useState } from "react"
import { Button, EmptyState, ErrorBoundary } from "dimos-react"
import { Library } from "./views/Library.tsx"
import { useExtraDirs } from "./extra_dirs.ts"
import { folderUrl } from "./folder_url.ts"

// the Replayer (three.js) loads only when a recording is opened in it
const Replay = lazy(() => import("./views/Replay.tsx").then((module) => ({ default: module.Replay })))

export type Route = { view: "library"; transfer?: boolean } | {
    view: "replay"
    id: string
}

export function parseRoute(hash: string): Route {
    const match = hash.match(/^#\/replay\/(.+)$/)
    if (match) {
        let id = match[1]
        try {
            id = decodeURIComponent(id)
        } catch {
            // not percent-encoding (a link cut short): the id as written, which the Replayer says it can't open
        }
        return { view: "replay", id }
    }
    return /^#\/transfer\/?$/.test(hash) ? { view: "library", transfer: true } : { view: "library" }
}

export function go(route: Route) {
    location.hash = route.view === "replay"
        ? `#/replay/${encodeURIComponent(route.id)}`
        : route.transfer
        ? "#/transfer"
        : "#/"
}

export function App() {
    const [route, setRoute] = useState(parseRoute(location.hash))
    const [extraDirs, setExtraDirs] = useExtraDirs()
    useEffect(() => {
        if (!extraDirs.length) return
        const watch = new EventSource(folderUrl("api/extra-dirs/watch", extraDirs))
        return () => watch.close()
    }, [extraDirs])
    useEffect(() => {
        const update = () => setRoute(parseRoute(location.hash))
        addEventListener("hashchange", update)
        return () => removeEventListener("hashchange", update)
    }, [])
    // a view that throws says so, and the next route starts clean (React would otherwise unmount the app)
    return (
        <ErrorBoundary
            key={JSON.stringify(route)}
            fallback={({ error }) => (
                <EmptyState
                    layer
                    icon="warn"
                    tone="warn"
                    title="Something went wrong"
                    message={error instanceof Error ? error.message : String(error)}
                    actions={
                        <Button
                            variant="primary"
                            onClick={() => go({ view: "library" })}
                        >
                            Back to the recordings
                        </Button>
                    }
                />
            )}
        >
            {route.view === "replay"
                ? (
                    <Suspense fallback={null}>
                        <Replay id={route.id} />
                    </Suspense>
                )
                : <Library transfer={!!route.transfer} extraDirs={extraDirs} setExtraDirs={setExtraDirs} />}
        </ErrorBoundary>
    )
}
