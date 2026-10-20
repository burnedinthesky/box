// ── Utilities ──────────────────────────────────────────────
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const showToast = (msg, duration = 2200) => {
	const t = document.getElementById("toast");
	t.textContent = msg;
	t.classList.add("show");
	clearTimeout(t._tid);
	t._tid = setTimeout(() => t.classList.remove("show"), duration);
};

// ── Thread slider ──────────────────────────────────────────
const threadSlider = document.getElementById("threadCount");
const threadVal = document.getElementById("threadVal");
threadSlider.addEventListener("input", () => {
	threadVal.textContent = threadSlider.value;
});
const getThreads = () => parseInt(threadSlider.value, 10);
const getDlThreads = getThreads;

// ── Chunked upload ─────────────────────────────────────────
const apiJson = async (url, options) => {
	const response = await fetch(url, options);
	const body = await response.json();
	if (!response.ok) throw new Error(body.error || "Upload failed.");
	return body;
};

const uploadFileChunked = async (file, onProgress) => {
	const session = await apiJson("/upload/init", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type })
	});
	if (session.done) {
		onProgress(1);
		return session;
	}
	const totalChunks = Math.ceil(file.size / session.partSize);
	const parts = new Array(totalChunks);
	let uploaded = 0;
	let nextChunk = 0;
	let failed = false;

	const uploadChunk = async index => {
		const blob = file.slice(index * session.partSize, Math.min((index + 1) * session.partSize, file.size));
		for (let attempt = 0; ; attempt++) {
			try {
				parts[index] = await apiJson(`/upload/chunk?id=${encodeURIComponent(session.id)}&partNumber=${index + 1}`, {
					method: "PUT",
					body: blob
				});
				break;
			} catch (error) {
				if (attempt >= 2) throw error;
				await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
			}
		}
		uploaded++;
		onProgress(uploaded / totalChunks);
	};

	const worker = async () => {
		while (!failed && nextChunk < totalChunks) {
			try {
				await uploadChunk(nextChunk++);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(getThreads(), totalChunks) }, worker));
	return apiJson("/upload/assemble", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: session.id, parts })
	});
};

const uploadFiles = async files => {
	const area = document.getElementById("uploadArea");
	area.innerHTML = "";
	const items = [];

	for (const file of files) {
		const el = document.createElement("div");
		el.className = "upload-item";
		el.innerHTML = `
                        <div class="upload-item-header">
                            <span class="upload-item-name">${esc(file.name)}</span>
                            <span class="upload-item-pct">0%</span>
                        </div>
                        <div class="progress-bar-wrap"><div class="progress-bar"></div></div>`;
		area.appendChild(el);
		items.push({ el, file });
	}

	await Promise.allSettled(
		items.map(({ el, file }) => {
			const bar = el.querySelector(".progress-bar");
			const pct = el.querySelector(".upload-item-pct");
			return uploadFileChunked(file, p => {
				const v = Math.round(p * 100);
				bar.style.width = v + "%";
				pct.textContent = v + "%";
			})
				.then(() => {
					el.remove();
				})
				.catch(error => {
					pct.textContent = "Failed";
					el.querySelector(".upload-item-name").textContent = `${file.name}: ${error.message}`;
					showToast(error.message, 5000);
				});
		})
	);

	loadFileList();
};

// ── File list ──────────────────────────────────────────────
const formatExt = ext => (ext.length > 4 ? ext.slice(0, 4) : ext);

const loadFileList = () => {
	fetch("/list")
		.then(r => r.json())
		.then(files => {
			const fileList = document.getElementById("fileList");
			files.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));

			if (files.length === 0) {
				fileList.innerHTML = `<p style="margin:auto;color:var(--muted);font-size:0.9rem">No files yet</p>`;
				return;
			}

			fileList.innerHTML = files
				.map(
					file => `
                            <div class="file" data-file="${esc(file.key)}" data-name="${esc(file.file)}" role="button" tabindex="0" aria-label="Download ${esc(file.file)}">
                                <div class="type ${esc(file.extension)}">${esc(formatExt(file.extension))}</div>
                                <div class="text">
                                    <h3>${esc(file.file)}</h3>
                                    <p>${esc(file.size)}&nbsp;&nbsp;${new Date(file.uploadDate).toLocaleString()}</p>
                                </div>
                                <button class="action-btn copy-btn" data-file="${esc(file.key)}" data-name="${esc(file.file)}" title="Copy URL">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                    Copy URL
                                </button>
                                <div class="dl-progress"></div>
                            </div>`
				)
				.join("");

			// Bind copy buttons
			fileList.querySelectorAll(".copy-btn").forEach(btn => {
				btn.addEventListener("click", e => {
					e.stopPropagation();
					const name = btn.dataset.file;
					const url = `${location.origin}/box?file=${encodeURIComponent(name)}`;
					navigator.clipboard.writeText(url).then(() => showToast("URL copied!"));
				});
			});

			// Row click → download
			fileList.querySelectorAll(".file").forEach(row => {
				row.addEventListener("click", () => dl(row.dataset.file, row.dataset.name, row));
				row.addEventListener("keydown", e => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						dl(row.dataset.file, row.dataset.name, row);
					}
				});
			});
		})
		.catch(err => console.error("Error fetching files:", err));
};
loadFileList();

// ── Download with multi-thread (Range requests) ────────────
const dl = (key, filename, rowEl) => {
	const progressEl = rowEl?.querySelector(".dl-progress");
	const url = `/box?file=${encodeURIComponent(key)}`;
	const threads = getDlThreads();

	// First, HEAD request to get file size
	fetch(url, { method: "HEAD" })
		.then(async headRes => {
			if (!headRes.ok) throw new Error("File expired or unavailable.");
			const contentType = headRes.headers.get("content-type") || "";
			if (contentType.includes("text/html")) {
				window.location.href = url;
				return;
			}

			const contentLength = headRes.headers.get("content-length");
			const total = contentLength ? parseInt(contentLength, 10) : null;

			// Fall back to single-stream if size unknown or file too small
			if (!total || total < threads * 1024 || threads === 1) {
				return fetch(url).then(async response => {
					if (!response.ok) throw new Error("Download failed.");
					const reader = response.body.getReader();
					const chunks = [];
					let received = 0;

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						chunks.push(value);
						received += value.length;
						if (progressEl) {
							progressEl.style.width = Math.round((received / (total || received)) * 100) + "%";
						}
					}

					if (progressEl) {
						progressEl.style.width = "100%";
						setTimeout(() => {
							progressEl.style.width = "0%";
						}, 600);
					}

					const blob = new Blob(chunks);
					const objUrl = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = objUrl;
					a.download = filename;
					a.click();
					URL.revokeObjectURL(objUrl);
				});
				return;
			}

			// Multi-thread: split into chunks and fetch in parallel
			const chunkSize = Math.ceil(total / threads);
			const buffers = new Array(threads);
			let received = 0;

			const fetchChunk = async i => {
				const start = i * chunkSize;
				const end = Math.min(start + chunkSize - 1, total - 1);
				const res = await fetch(url, {
					headers: { Range: `bytes=${start}-${end}` }
				});
				if (res.status !== 206) throw new Error("Range download failed. Please retry.");
				const reader = res.body.getReader();
				const parts = [];
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					parts.push(value);
					received += value.length;
					if (progressEl) {
						progressEl.style.width = Math.round((received / total) * 100) + "%";
					}
				}
				// Merge parts into a single Uint8Array
				const size = parts.reduce((s, v) => s + v.length, 0);
				const merged = new Uint8Array(size);
				let off = 0;
				for (const v of parts) {
					merged.set(v, off);
					off += v.length;
				}
				buffers[i] = merged;
			};

			await Promise.all(Array.from({ length: threads }, (_, i) => fetchChunk(i)));

			if (progressEl) {
				progressEl.style.width = "100%";
				setTimeout(() => {
					progressEl.style.width = "0%";
				}, 600);
			}

			// Merge all chunks in order into a single Blob
			const blob = new Blob(buffers);
			const objUrl = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = objUrl;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(objUrl);
		})
		.catch(error => {
			if (progressEl) progressEl.style.width = "0%";
			showToast(error.message, 5000);
			loadFileList();
		});
};

// ── File input change → chunked upload ─────────────────────
document.getElementById("file").addEventListener("change", event => {
	const files = Array.from(event.target.files);
	if (files.length) uploadFiles(files);
	event.target.value = "";
});

// ── Drag and drop ──────────────────────────────────────────
const dragOverEl = document.getElementById("dragOver");

document.addEventListener("dragover", event => {
	event.preventDefault();
	dragOverEl.style.opacity = "1";
});

document.addEventListener("dragleave", event => {
	if (event.relatedTarget === null) dragOverEl.style.opacity = "0";
});

document.addEventListener("drop", event => {
	event.preventDefault();
	dragOverEl.style.opacity = "0";
	const files = Array.from(event.dataTransfer.files);
	if (files.length) uploadFiles(files);
});

// Space/Enter on drag label
document.getElementById("drag").addEventListener("keydown", e => {
	if (e.key === " " || e.key === "Enter") {
		e.preventDefault();
		document.getElementById("file").click();
	}
});
