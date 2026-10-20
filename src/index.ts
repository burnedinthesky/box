interface Env {
	UPLOADS: R2Bucket;
	ASSETS: Fetcher;
}

interface UploadSession {
	key: string;
	uploadId: string;
	filename: string;
	size: number;
	createdAt: number;
}

export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const PART_SIZE = 8 * 1024 * 1024;
const FILE_PREFIX = "uploads/";
const SESSION_PREFIX = "sessions/";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const expired = (uploaded: Date, now = Date.now()) => now - uploaded.getTime() >= RETENTION_MS;

class HttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

async function readJson<T>(request: Request): Promise<T> {
	try {
		return await request.json<T>();
	} catch {
		throw new HttpError(400, "Invalid JSON.");
	}
}

async function sessionFor(env: Env, id: string): Promise<UploadSession> {
	if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "Invalid upload session.");
	const object = await env.UPLOADS.get(SESSION_PREFIX + id);
	if (!object || expired(object.uploaded)) throw new HttpError(404, "Upload session expired or missing.");
	return object.json<UploadSession>();
}

async function listFiles(env: Env) {
	const files = [];
	let cursor: string | undefined;
	do {
		const page = await env.UPLOADS.list({ prefix: FILE_PREFIX, include: ["customMetadata"], cursor });
		for (const object of page.objects) {
			if (expired(object.uploaded)) continue;
			const filename = object.customMetadata?.filename || object.key.split("/").pop()!;
			const kb = object.size / 1024;
			files.push({
				key: object.key,
				file: filename,
				extension: filename.includes(".") ? filename.split(".").pop()! : "",
				size: kb < 1024 ? kb.toFixed(2) + " KB" : (kb / 1024).toFixed(2) + " MB",
				uploadDate: object.uploaded.toISOString(),
				expiresAt: new Date(object.uploaded.getTime() + RETENTION_MS).toISOString()
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return json(files);
}

async function download(request: Request, env: Env, url: URL): Promise<Response> {
	const key = url.searchParams.get("file");
	if (!key?.startsWith(FILE_PREFIX)) throw new HttpError(404, "File not found.");
	const head = await env.UPLOADS.head(key);
	if (!head || expired(head.uploaded)) throw new HttpError(404, "File expired or not found.");
	const filename = head.customMetadata?.filename || key.split("/").pop()!;
	const headers = new Headers({
		"Content-Type": head.httpMetadata?.contentType || "application/octet-stream",
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16))}`,
		"Accept-Ranges": "bytes",
		"Content-Length": String(head.size),
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		ETag: head.httpEtag,
		"Last-Modified": head.uploaded.toUTCString()
	});
	if (request.method === "HEAD") return new Response(null, { headers });
	let range: R2Range | undefined;
	const rangeHeader = request.headers.get("Range");
	const ifRange = request.headers.get("If-Range");
	if (rangeHeader && (!ifRange || ifRange === head.httpEtag || ifRange === head.uploaded.toUTCString())) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
		if (!match || (!match[1] && !match[2]) || head.size === 0) {
			headers.set("Content-Range", `bytes */${head.size}`);
			headers.set("Content-Length", "0");
			return new Response(null, { status: 416, headers });
		}
		const start = match[1] ? Number(match[1]) : Math.max(0, head.size - Number(match[2]));
		const end = match[1] && match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= head.size) {
			headers.set("Content-Range", `bytes */${head.size}`);
			headers.set("Content-Length", "0");
			return new Response(null, { status: 416, headers });
		}
		range = { offset: start, length: end - start + 1 };
		headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
		headers.set("Content-Length", String(end - start + 1));
	}
	const object = await env.UPLOADS.get(key, { range, onlyIf: { etagMatches: head.etag } });
	if (!object) throw new HttpError(404, "File not found.");
	if (!("body" in object)) throw new HttpError(412, "File changed; retry download.");
	return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function beginUpload(request: Request, env: Env) {
	const body = await readJson<{ filename: string; size: number; contentType?: string }>(request);
	if (typeof body.filename !== "string" || !body.filename.trim() || body.filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(body.filename)) {
		throw new HttpError(400, "Invalid filename (maximum 255 characters; no slashes or control characters).");
	}
	if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > PART_SIZE * 10000) throw new HttpError(400, "Invalid file size (maximum 78.125 GiB).");
	const id = crypto.randomUUID();
	const key = FILE_PREFIX + id + "/" + body.filename;
	const options = {
		httpMetadata: { contentType: body.contentType || "application/octet-stream" },
		customMetadata: { filename: body.filename }
	};
	if (body.size === 0) {
		await env.UPLOADS.put(key, new Uint8Array(), options);
		return json({ ok: true, done: true, key, filename: body.filename });
	}
	const multipart = await env.UPLOADS.createMultipartUpload(key, options);
	const session: UploadSession = { key, uploadId: multipart.uploadId, filename: body.filename, size: body.size, createdAt: Date.now() };
	try {
		await env.UPLOADS.put(SESSION_PREFIX + id, JSON.stringify(session));
	} catch (error) {
		await multipart.abort();
		throw error;
	}
	return json({ id, partSize: PART_SIZE });
}

async function uploadPart(request: Request, env: Env, url: URL) {
	const session = await sessionFor(env, url.searchParams.get("id") || "");
	const partNumber = Number(url.searchParams.get("partNumber"));
	const count = Math.ceil(session.size / PART_SIZE);
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) throw new HttpError(400, "Invalid part number.");
	const expectedSize = Math.min(PART_SIZE, session.size - (partNumber - 1) * PART_SIZE);
	if (Number(request.headers.get("Content-Length")) !== expectedSize || !request.body) throw new HttpError(400, "Unexpected chunk size.");
	const multipart = env.UPLOADS.resumeMultipartUpload(session.key, session.uploadId);
	return json(await multipart.uploadPart(partNumber, request.body));
}

async function completeUpload(request: Request, env: Env) {
	const { id, parts } = await readJson<{ id: string; parts: R2UploadedPart[] }>(request);
	const session = await sessionFor(env, id || "");
	const count = Math.ceil(session.size / PART_SIZE);
	if (!Array.isArray(parts) || parts.length !== count || parts.some((part, i) => !part || part.partNumber !== i + 1 || typeof part.etag !== "string" || !part.etag)) {
		throw new HttpError(400, "Missing or invalid upload parts.");
	}
	const multipart = env.UPLOADS.resumeMultipartUpload(session.key, session.uploadId);
	const object = await multipart.complete(parts);
	await env.UPLOADS.delete(SESSION_PREFIX + id);
	return json({ ok: true, key: object.key, filename: session.filename });
}

export async function cleanup(env: Env, now = Date.now()) {
	for (const prefix of [FILE_PREFIX, SESSION_PREFIX]) {
		let cursor: string | undefined;
		do {
			const page = await env.UPLOADS.list({ prefix, cursor });
			const keys = [];
			for (const object of page.objects) {
				if (!expired(object.uploaded, now)) continue;
				if (prefix === SESSION_PREFIX) {
					const stored = await env.UPLOADS.get(object.key);
					if (stored) {
						const session = await stored.json<UploadSession>();
						try {
							await env.UPLOADS.resumeMultipartUpload(session.key, session.uploadId).abort();
						} catch (error) {
							// An already completed/aborted multipart upload has nothing left to clean up.
							if (!/not found|does not exist|NoSuchUpload|10024/i.test(String(error))) throw error;
						}
					}
				}
				keys.push(object.key);
			}
			if (keys.length) await env.UPLOADS.delete(keys);
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (request.method === "POST" || request.method === "PUT") {
				const origin = request.headers.get("Origin");
				if (origin && origin !== url.origin) throw new HttpError(403, "Cross-origin uploads are not allowed.");
			}
			if (url.pathname === "/list" && request.method === "GET") return await listFiles(env);
			if (url.pathname === "/box" && ["GET", "HEAD"].includes(request.method)) return await download(request, env, url);
			if (url.pathname === "/upload/init" && request.method === "POST") return await beginUpload(request, env);
			if (url.pathname === "/upload/chunk" && request.method === "PUT") return await uploadPart(request, env, url);
			if (url.pathname === "/upload/assemble" && request.method === "POST") return await completeUpload(request, env);
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof HttpError) return json({ error: error.message }, error.status);
			console.error("Request failed", error);
			return json({ error: "Request failed. Please retry." }, 500);
		}
	},
	async scheduled(_controller, env) {
		await cleanup(env);
	}
} satisfies ExportedHandler<Env>;
