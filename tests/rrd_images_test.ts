// Read the pinned writer's RRF2 Arrow message. The fixture has just one image stream, so its Arrow IPC payload
// contains both JPEG codestreams. Decode their frame headers independently of dtk.
import { assert, assertEquals } from "@std/assert"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
// deno-lint-ignore no-import-prefix
import lz4 from "npm:lz4js@0.2.0"
import { DTK_URL, Jobs } from "../backend/recordings/convert.ts"
import { compressedSize } from "../backend/recordings/thumbnails.ts"
import { encode } from "../backend/replay/lcm.ts"
import { tempDir, writeDb } from "./fixtures.ts"

function arrowPayload(bytes: Uint8Array) {
    const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
    let at = 12
    while (file.getBigUint64(at, true) !== 2n) at += 16 + Number(file.getBigUint64(at + 8, true))
    at += 16
    function integer() {
        let value = 0
        for (let shift = 0; shift < 32; shift += 7) {
            const byte = bytes[at++]
            value += (byte & 127) * 2 ** shift
            if (byte < 128) return value
        }
        throw new Error("invalid RRD integer")
    }
    let size = 0
    while (at < bytes.length) {
        const tag = integer()
        const n = integer()
        if (tag === 24) size = n // ArrowMsg.uncompressed_size
        if (tag === 42) { // ArrowMsg.payload
            const ipc = Buffer.alloc(size)
            lz4.decompressBlock(bytes.subarray(at, at + n), ipc, 0, n, 0)
            return ipc
        }
        if ((tag & 7) === 2) at += n
    }
    throw new Error("missing RRD payload")
}

// 4 by 4 JPEG; the first frame must survive a change of encoding in the same stream.
const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAQABAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=",
    "base64",
)

for (const [encoding, override] of [["mono8", false], ["mono16", false], ["mono8", true], ["mono16", true]] as const) {
    Deno.test(`Rerun export: a JPEG followed by ${encoding} (${override ? "configured" : "default"} converter)`, async () => {
        const root = await tempDir()
        const path = join(root, "camera.db")
        const pixels = new Uint8Array(encoding === "mono8" ? 4 : 8).fill(42)
        writeDb(path, [{
            name: "image",
            payload: "dimos.msgs.sensor_msgs.Image.Image",
            times: [1, 2],
            blob: (i) => {
                const data = i ? pixels : jpeg
                return encode("sensor_msgs.Image", {
                    data,
                    data_length: data.length,
                    width: i ? 2 : 4,
                    height: i ? 2 : 4,
                    encoding: i ? encoding : "jpeg",
                    step: i ? pixels.length / 2 : 0,
                })
            },
        }])
        const db = new DatabaseSync(path)
        for (const axis of ["x", "y", "z", "qx", "qy", "qz", "qw"]) db.exec(`ALTER TABLE image ADD pose_${axis} REAL`)
        db.close()
        const output = join(root, "camera.rrd")
        await Deno.writeTextFile(output, "previous export")
        const jobs = new Jobs()
        const done = Promise.withResolvers<void>()
        jobs.onChange = (job) => {
            if (job.finished !== null) done.resolve()
        }
        const previous = Deno.env.get("DIM_RECORDINGS_DTK")
        try {
            if (override) Deno.env.set("DIM_RECORDINGS_DTK", `${Deno.execPath()} run -A --no-config ${DTK_URL}`)
            else Deno.env.delete("DIM_RECORDINGS_DTK")
            const job = jobs.convert({ path, id: "camera.db", format: "db", streams: 1, messages: 2 }, "rrd")
            await done.promise
            const result = jobs.get(job.id)!
            if (encoding === "mono16") {
                assertEquals(result.state, "failed")
                assert(result.error?.includes("JPEG"))
                assertEquals(await Deno.readTextFile(output), "previous export")
            } else {
                assertEquals(result.state, "done", result.error ?? "")
                const ipc = arrowPayload(await Deno.readFile(output))
                const first = ipc.indexOf(jpeg)
                assert(first >= 0)
                const second = ipc.indexOf(Buffer.from([255, 216, 255]), first + jpeg.length)
                assert(second >= 0, "missing JPEG for the second frame")
                assertEquals(compressedSize(ipc.subarray(second)), { width: 2, height: 2 })
            }
        } finally {
            if (previous !== undefined) Deno.env.set("DIM_RECORDINGS_DTK", previous)
            else Deno.env.delete("DIM_RECORDINGS_DTK")
            await Deno.remove(root, { recursive: true })
        }
    })
}
