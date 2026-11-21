// deno-lint-ignore-file no-import-prefix
// dtk's RRD writer labels every Image as JPEG. Give it JPEG frames, keeping existing ones byte-for-byte.
// Only recordings needing a change get a temporary SQLite snapshot; the source is always read-only.
import { Database } from "jsr:@db/sqlite@0.12"
import { basename, join } from "node:path"

const [dtk, input, scratch, executable, ...args] = Deno.args
const moduleOf = (name: string) => import(new URL(name, dtk).href)
const { sensor_msgs } = await import("jsr:@dimos/msgs@0.1.4")
const { default: lz4 } = await import("https://esm.sh/lz4js@0.2.0")
const { codecOf, DECODABLE, decide, frameSize, RecodePool } = await moduleOf("tools/image_recode/recode.js")

// Iterate actual rows, including a change of encoding midway through one stream. Keep one frame in memory.
function* imagesToPrepare(db: Database, writing = false) {
    using streams = db.prepare("SELECT name, config FROM _streams")
    for (const row of streams.iter()) {
        if (JSON.parse(String(row.config)).payload_module?.split(".").pop() !== "Image") continue
        const table = String(row.name).replaceAll('"', '""')
        using update = writing ? db.prepare(`UPDATE "${table}_blob" SET data = ? WHERE id = ?`) : undefined
        using frames = db.prepare(
            `SELECT b.id, b.data FROM "${table}_blob" b JOIN "${table}" m ON m.id = b.id ORDER BY b.id`,
        )
        for (const { id, data } of frames.iter()) {
            const bytes = data as Uint8Array
            const wrapped = bytes[0] === 4 && bytes[1] === 34 && bytes[2] === 77 && bytes[3] === 24
            const image = sensor_msgs.Image.decode(wrapped ? lz4.decompress(bytes) : bytes)
            if (!image.data.length) continue
            const codec = codecOf(image.encoding)
            const jpeg = codec === "jpeg" && !!frameSize("jpeg", image.data)
            if (!jpeg || wrapped) yield { table, id, image, codec, jpeg, update }
        }
    }
}

async function exportRrd() {
    let path: string = /\.mcap$/i.test(input) ? await (await moduleOf("conversions.js")).asFormat(input, "db") : input
    const original = new Database(path, { readonly: true })
    try {
        using revision = original.prepare("PRAGMA data_version")
        const before = revision.value()?.[0]
        const needsCopy = imagesToPrepare(original).some(() => true)
        if (needsCopy) {
            Deno.mkdirSync(scratch, { mode: 0o700 })
            path = join(scratch, basename(path))
            const copy = new Database(path)
            const pool = new RecodePool(1)
            try {
                original.backup(copy)
                copy.exec("BEGIN")
                for (const { table, id, image, codec, jpeg, update } of imagesToPrepare(copy, true)) {
                    if (!jpeg) {
                        const frame = {
                            compressed: DECODABLE.has(codec),
                            codec,
                            encoding: image.encoding,
                            bytes: image.data,
                            width: image.width,
                            height: image.height,
                            step: image.step,
                            bigEndian: image.is_bigendian,
                        }
                        const action = decide(frame, { kind: "jpeg" })
                        if (action.kind !== "jpeg") {
                            throw new Error(`Cannot export ${table} as JPEG: ${action.reason}. Open it in Replayer.`)
                        }
                        const [out] = await pool.run([{ frame, target: "jpeg", quality: action.quality }])
                        if (out.error) throw new Error(`${table}: ${out.error}`)
                        image.data = out.bytes
                        image.data_length = out.bytes.length
                        image.encoding = "jpeg"
                        image.step = 0
                        image.is_bigendian = 0
                    }
                    update!.run(image.encode(), id)
                }
                copy.exec("COMMIT")
            } finally {
                pool.close()
                copy.close()
            }
        }
        const abort = new AbortController()
        const cancel = () => abort.abort()
        const command = new Deno.Command(executable, {
            args: [...args, "data", "to_rrd", path, "--force", "--no-open"],
            signal: abort.signal,
            stdin: "null",
            stdout: "inherit",
            stderr: "inherit",
        })
        Deno.addSignalListener("SIGTERM", cancel)
        try {
            const status = await command.spawn().status
            if (!status.success) {
                Deno.exitCode = status.code || 1
                return
            }
        } finally {
            Deno.removeSignalListener("SIGTERM", cancel)
        }
        if (!needsCopy && before !== revision.value()?.[0]) {
            throw new Error("The recording changed during export. Try again when recording stops.")
        }
    } finally {
        original.close()
    }
}

try {
    await exportRrd()
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exitCode = 1
}
