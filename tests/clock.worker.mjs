import handler, { cleanup } from "../dist/index.js";
const actualNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => actualNow() + offset;
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/__advance") {
			offset = Number(url.searchParams.get("ms"));
			return new Response("ok");
		}
		if (url.pathname === "/__cleanup") {
			await cleanup(env);
			return new Response("ok");
		}
		return handler.fetch(request, env);
	}
};
