// The page's calls to the backend (frontend/src/api.ts): the order a recording's note saves and its rename go in.
import { assertEquals } from "@std/assert"
import { api } from "../frontend/src/api.ts"

Deno.test("page api: a rename waits for the recording's note save still on its way", async () => {
    const sent: string[] = []
    let answer = () => {}
    const realFetch = globalThis.fetch
    globalThis.fetch = ((path: string, init: RequestInit) => {
        sent.push(`${init.method} ${path}`)
        return new Promise<Response>((resolve) => answer = () => resolve(Response.json({ id: "b.db" })))
    }) as typeof fetch
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
    try {
        const saved = api.setNote("a.db", "the newest edit")
        const renamed = api.rename("a.db", "b.db")
        await turn()
        // sent at once, the rename got there first and the save found no a.db: the edit was lost
        assertEquals(sent, ["PUT api/recordings/a.db/note"])
        answer()
        await saved
        await turn()
        assertEquals(sent, ["PUT api/recordings/a.db/note", "POST api/recordings/a.db/rename"])
        answer()
        assertEquals(await renamed, { id: "b.db" })
    } finally {
        globalThis.fetch = realFetch
    }
})
