import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const mf = new Miniflare({
	modules: true,
	modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
	scriptPath: "tests/clock.worker.mjs",
	compatibilityDate: "2026-07-30",
	r2Buckets: ["UPLOADS"]
});
after(() => mf.dispose());
const request = (path, options) => mf.dispatchFetch("http://localhost" + path, options);
const post = (path, body) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function upload(filename, data) {
	const init = await post("/upload/init", { filename, size: data.length });
	assert.equal(init.status, 200, await init.clone().text());
	const session = await init.json();
	if (session.done) return session;
	const chunks = Array.from({ length: Math.ceil(data.length / session.partSize) }, (_, i) => data.subarray(i * session.partSize, (i + 1) * session.partSize));
	const parts = await Promise.all(
		chunks.map(async (body, i) => {
			const res = await request(`/upload/chunk?id=${session.id}&partNumber=${i + 1}`, { method: "PUT", headers: { "Content-Length": String(body.length) }, body });
			assert.equal(res.status, 200, await res.clone().text());
			return res.json();
		})
	);
	const completed = await post("/upload/assemble", { id: session.id, parts });
	assert.equal(completed.status, 200, await completed.clone().text());
	return completed.json();
}

test("multipart uploads, duplicate/unicode names, ranges, validation, and 24-hour expiry", async () => {
	const data = new Uint8Array(8 * 1024 * 1024 + 123);
	for (let i = 0; i < data.length; i++) data[i] = i % 251;
	const filename = '測試 "file".bin';
	const first = await upload(filename, data);
	const second = await upload(filename, new Uint8Array());
	assert.notEqual(first.key, second.key);
	const list = await (await request("/list")).json();
	assert.equal(list.length, 2);
	assert.equal(list[0].file, filename);
	const path = `/box?file=${encodeURIComponent(first.key)}`;
	const head = await request(path, { method: "HEAD" });
	assert.equal(head.headers.get("Content-Length"), String(data.length));
	assert.equal(head.headers.get("Accept-Ranges"), "bytes");
	assert.match(head.headers.get("Content-Disposition"), /^attachment;/);
	const downloaded = await request(path);
	assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), data);
	for (const [header, start, end] of [
		["bytes=100-199", 100, 200],
		["bytes=-50", data.length - 50, data.length],
		["bytes=8388600-", 8388600, data.length]
	]) {
		const res = await request(path, { headers: { Range: header } });
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("Content-Range"), `bytes ${start}-${end - 1}/${data.length}`);
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data.subarray(start, end));
	}
	assert.equal((await request(path, { headers: { Range: "bytes=99999999-" } })).status, 416);
	assert.equal((await request(path, { headers: { Range: "bytes=0-1,4-5" } })).status, 416);
	assert.equal((await post("/upload/init", { filename: "../bad", size: 1 })).status, 400);
	assert.equal((await post("/upload/init", { filename: "a", size: -1 })).status, 400);
	assert.equal((await request("/upload/init", { method: "POST", body: "not json" })).status, 400);
	assert.equal((await request("/upload/init", { method: "POST", headers: { Origin: "https://other.example" }, body: "{}" })).status, 403);
	const incomplete = await (await post("/upload/init", { filename: "incomplete.bin", size: 1 })).json();
	assert.equal((await post("/upload/assemble", { id: incomplete.id, parts: [] })).status, 400);
	assert.equal((await request(`/upload/chunk?id=${incomplete.id}&partNumber=2`, { method: "PUT", body: "a" })).status, 400);
	await request("/__advance?ms=" + (24 * 60 * 60 * 1000 - 10000));
	assert.equal((await request(path, { method: "HEAD" })).status, 200);
	await request("/__advance?ms=" + (24 * 60 * 60 * 1000 + 1000));
	assert.deepEqual(await (await request("/list")).json(), []);
	assert.equal((await request(path)).status, 404);
	assert.equal((await request(path, { method: "HEAD" })).status, 404);
	assert.equal((await request("/__cleanup")).status, 200);
	const bucket = await mf.getR2Bucket("UPLOADS");
	assert.deepEqual((await bucket.list()).objects, []);
});
