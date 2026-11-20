// A recording can be renamed from either menu while its Inspector is still saving a note.
import { assertEquals, assertRejects } from "@std/assert"
import { api } from "../frontend/src/api.ts"

Deno.test("page api: rename waits for the newest edit, even if an older save is refused", async () => {
    const writes: string[] = []
    const first = Promise.withResolvers<Response>()
    const last = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    const status: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (path, init) => {
        if (init?.method === "PUT") {
            const { text } = JSON.parse(String(init.body))
            writes.push(text)
            if (text === "first") return first.promise
            started.resolve()
            return last.promise
        }
        writes.push(String(path))
        return Promise.resolve(Response.json({ id: "new.db" }))
    }
    try {
        // A rename during the typing delay starts the save. A newer edit queued while it is in flight wins.
        api.setNote("run.db", "first", (value) => status.push(value))
        assertEquals(writes, [])
        const renamed = api.rename("run.db", "new")
        assertEquals(writes, ["first"])
        api.setNote("run.db", "latest", (value) => status.push(value))
        await api.rename("other.db", "another") // independent recordings need not wait
        first.resolve(Response.json({ error: "old write failed" }, { status: 503 }))
        await started.promise
        assertEquals(writes, ["first", "api/recordings/other.db/rename", "latest"])
        last.resolve(Response.json({ ok: true }))
        assertEquals(await renamed, { id: "new.db" })
        assertEquals(writes.at(-1), "api/recordings/run.db/rename")
        assertEquals(status.at(-1), "saved")
    } finally {
        first.resolve(Response.json({}))
        last.resolve(Response.json({}))
        globalThis.fetch = realFetch
    }
})

Deno.test("page api: a refused note keeps its name and draft until the write succeeds", async () => {
    const calls: string[] = []
    const status: string[] = []
    let refused = true
    const realFetch = globalThis.fetch
    globalThis.fetch = (path, init) => {
        calls.push(`${path} ${init?.body}`)
        return Promise.resolve(refused ? Response.json({ error: "write failed" }, { status: 503 }) : Response.json({}))
    }
    try {
        api.setNote("a.db", "", (value) => status.push(value)) // clearing a note is an edit too
        await assertRejects(() => api.rename("a.db", "b"), Error, "write failed")
        assertEquals(calls, ['api/recordings/a.db/note {"text":""}'])
        assertEquals(status.at(-1), "failed – waiting for reconnect")
        refused = false
        await api.rename("a.db", "b")
        assertEquals(calls.slice(1), [
            'api/recordings/a.db/note {"text":""}',
            'api/recordings/a.db/rename {"name":"b"}',
        ])
        assertEquals(status.at(-1), "saved")
    } finally {
        globalThis.fetch = realFetch
    }
})

Deno.test("page api: refreshing a note shows the other editor's save once the local draft is written", async () => {
    const recording = { id: "shared.db", note: "first note" }
    const written = Promise.withResolvers<Response>()
    const realFetch = globalThis.fetch
    globalThis.fetch = () => written.promise
    try {
        const save = api.setNote(recording.id, "")
        assertEquals(api.noteText(recording), "") // refreshing while clearing the note keeps the edit
        written.resolve(Response.json({ ok: true }))
        await save
        const refreshed = { ...recording, note: "second editor's note" }
        assertEquals(api.noteText(refreshed), refreshed.note)
    } finally {
        written.resolve(Response.json({ ok: true }))
        globalThis.fetch = realFetch
    }
})
