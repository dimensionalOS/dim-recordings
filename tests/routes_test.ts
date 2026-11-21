// The HTTP API end to end (no Desktop): list, summary, note, rename, duplicate, delete, the agent manifest.
import { assert, assertEquals } from "@std/assert"
import { join } from "node:path"
import { handle } from "../backend/http.ts"
import { buildRoutes, INFO } from "../backend/routes.ts"
import { makeServices } from "../backend/services.ts"
import { lcmTf, range, tempDir, writeDb, writeMcap } from "./fixtures.ts"

async function app() {
    const dir = await tempDir()
    writeDb(join(dir, "a.db"), [
        {
            name: "tf",
            payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
            times: range(1_780_000_000, 10, 0.5),
            blob: () => lcmTf("map", "odom"),
        },
    ])
    const services = makeServices({
        recordingsDir: dir,
        dataDir: await tempDir(),
        desktopUrl: "",
        appName: "dim-recordings",
    })
    const routes = buildRoutes(services)
    const call = async (method: string, path: string, body?: unknown) => {
        const response = await handle(
            new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
            routes,
            INFO,
        )
        return { status: response!.status, body: await response!.json() }
    }
    return { dir, call, services }
}

Deno.test("api: list → summary → note → rename → duplicate → delete", async () => {
    const { dir, call } = await app()
    let list = await call("GET", "api/recordings?sort=size&order=asc")
    assertEquals(list.status, 200)
    assertEquals(list.body.sections[0].recordings.map((r: { id: string }) => r.id), ["a.db"])
    const one = await call("GET", "api/recordings/a.db")
    assertEquals(one.body.inspection.tf.edges[0].child, "odom")
    // once read, a row carries how many warnings its summary has (the list's flag)
    list = await call("GET", "api/recordings")
    assertEquals(list.body.sections[0].recordings[0].warnings, one.body.inspection.warnings.length)
    assertEquals(one.body.opens[0].target, "replayer") // Foxglove too when this machine has it (disabled for a .db)
    assertEquals((await call("PUT", "api/recordings/a.db/note", { text: "hello" })).status, 200)
    const renamed = await call("POST", "api/recordings/a.db/rename", { name: "b" })
    assertEquals(renamed.body.id, "b.db")
    list = await call("GET", "api/recordings")
    assertEquals(
        list.body.sections.flatMap((s: { recordings: { note: string }[] }) => s.recordings.map((r) => r.note)),
        ["hello"],
    )
    assertEquals((await call("POST", "api/recordings/b.db/duplicate", {})).body.id, "b copy.db")
    assertEquals((await call("DELETE", "api/recordings/b%20copy.db")).status, 200)
    assertEquals((await call("GET", "api/recordings/a.db")).status, 404)
    assertEquals((await call("POST", "api/recordings/b.db/convert", { to: "zip" })).status, 400)
    assertEquals((await call("POST", "api/recordings/..%2Fx.db/rename", { name: "y" })).status, 404)
    assert(await Deno.stat(join(dir, "b.db")))
})

Deno.test("api: an extra folder sent with the list: its rows, their actions by id, its status", async () => {
    const { call } = await app()
    const extra = await tempDir()
    await Deno.copyFile(join((await app()).dir, "a.db"), join(extra, "far.db"))
    const query = encodeURIComponent(JSON.stringify([extra, "/no/such/dir"]))
    const list = await call("GET", `api/recordings?extraDirs=${query}`)
    assertEquals(list.body.extraDirs.map((d: { count: number | null }) => d.count), [1, null])
    const far = list.body.sections.flatMap((s: { recordings: { id: string; root?: string }[] }) => s.recordings)
        .find((r: { root?: string }) => r.root === extra)
    assert(far.id.startsWith(".extra/"))
    const id = encodeURIComponent(far.id)
    assertEquals((await call("GET", `api/recordings/${id}`)).body.inspection.tf.edges[0].child, "odom")
    assertEquals((await call("PUT", `api/recordings/${id}/note`, { text: "far away" })).status, 200)
    const renamed = await call("POST", `api/recordings/${id}/rename`, { name: "near" })
    assertEquals(renamed.body.id, far.id.replace("far.db", "near.db"))
    assertEquals((await call("GET", `api/recordings/${encodeURIComponent(renamed.body.id)}`)).body.note, "far away")
    // the list without the param keeps the folders; the settings call replaces them
    assertEquals((await call("GET", "api/recordings")).body.extraDirs.length, 2)
    const set = await call("PUT", "api/extra-dirs", { dirs: [] })
    assertEquals(set.body.extraDirs, [])
    assertEquals((await call("GET", `api/recordings/${encodeURIComponent(renamed.body.id)}`)).status, 404)
})

Deno.test("api: openapi.json lists every route", async () => {
    const { call } = await app()
    const doc = await call("GET", "openapi.json")
    assertEquals(doc.body.openapi, "3.1.0")
    const operations = Object.values(doc.body.paths).flatMap((item) => Object.values(item as object))
    assert(operations.length >= 15)
    assert(
        operations.every((o: { summary?: string; description?: string }) => (o.summary ?? o.description)!.length > 10),
    )
})

Deno.test("api: a converter that cannot start leaves no running job", async () => {
    const { dir, call } = await app()
    const previous = Deno.env.get("DIM_RECORDINGS_DTK")
    Deno.env.set("DIM_RECORDINGS_DTK", join(dir, "missing-converter"))
    try {
        const refused = await call("POST", "api/recordings/a.db/convert", { to: "mcap" })
        assertEquals((await call("GET", "api/jobs")).body.jobs, [])
        assertEquals(refused.status, 500)
        assert(refused.body.error.includes("missing-converter"))
        assertEquals((await call("POST", "api/recordings/a.db/convert", { to: "db" })).status, 400)
    } finally {
        if (previous === undefined) Deno.env.delete("DIM_RECORDINGS_DTK")
        else Deno.env.set("DIM_RECORDINGS_DTK", previous)
    }
})

Deno.test("api: overlapping exports to one output return 409 until the first job finishes", async () => {
    const { dir, call } = await app()
    await writeMcap(join(dir, "A.mcap"), [])
    const script = join(dir, "converter.sh")
    await Deno.writeTextFile(
        script,
        `while [ ! -f "$0.go" ]; do sleep 0.02; done
echo "$3" > "$3.tmp"
echo "$3.tmp"
`,
    )
    const convert = (id: string) => call("POST", `api/recordings/${id}/convert`, { to: "rrd" })
    const finished = async (id: string) => {
        for (let i = 0; i < 200; i++) {
            const { body } = await call("GET", `api/jobs/${id}`)
            if (body.finished != null) return body
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error(`job ${id} did not finish`)
    }
    const previous = Deno.env.get("DIM_RECORDINGS_DTK")
    Deno.env.set("DIM_RECORDINGS_DTK", `sh ${script}`)
    try {
        const first = await convert("a.db")
        assertEquals(first.status, 200)
        const duplicate = await convert("a.db")
        const sibling = await convert("A.mcap")
        await Deno.writeTextFile(`${script}.go`, "")
        assertEquals((await finished(first.body.id)).state, "done")
        for (const reply of [duplicate, sibling]) {
            assertEquals(reply.status, 409)
            assert(reply.body.error.toLowerCase().includes("a.rrd"))
        }
        const retry = await convert("A.mcap")
        assertEquals(retry.status, 200)
        const result = await finished(retry.body.id)
        assertEquals(result.state, "done")
        assertEquals((await Deno.readTextFile(result.result)).trim(), join(dir, "A.mcap"))
    } finally {
        await Deno.writeTextFile(`${script}.go`, "")
        if (previous === undefined) Deno.env.delete("DIM_RECORDINGS_DTK")
        else Deno.env.set("DIM_RECORDINGS_DTK", previous)
    }
})
