import { ProxyUtils } from "@/core/proxy-utils";
import { parseExternalConfig } from "@/core/proxy-utils/producers/utils";

export default {
    async fetch(request, env) {
        const method = request.method.toUpperCase();
        const pathname = new URL(request.url).pathname;
        const secret = env.SECRET || "secret";

        if (
            !(method === "POST" && pathname === `/${secret}/api/proxy/parse`) &&
            !(method === "GET" && (pathname === `/${secret}/sub` || pathname === `/${secret}/version`))
        ) {
            return new Response(null, { status: 403 });
        }

        if (method === "GET" && pathname === `/${secret}/version`) {
            return new Response("subconverter v0.9.0 backend\n", {
                status: 200,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
        }

        try {
            return await env.MiniSubConvert.get(env.MiniSubConvert.idFromName("minisubconvert")).fetch(request);
        } catch {
            return new Response(null, { status: 500 });
        }
    },
};
export class MiniSubConvert {
    async fetch(request) {
        const method = request.method.toUpperCase();

        try {
            if (method === "POST") {
                const { data, client } = JSON.parse((await request.text()) || "{}");
                const proxies = ProxyUtils.parse(data);
                const par_res = ProxyUtils.produce(proxies, client);
                console.log(`parsed ${proxies.length} nodes, target client: ${client || "-"}`);

                return new Response(
                    JSON.stringify({
                        status: "success",
                        data: { par_res },
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json; charset=utf-8" },
                    },
                );
            }

            if (method === "GET") {
                const searchParams = new URL(request.url).searchParams;
                const target = searchParams.get("target");
                const rawUrls = searchParams.get("url");
                const configUrl = searchParams.get("config");

                if (!target || !rawUrls) {
                    return new Response("missing target or url", { status: 400 });
                }

                const client = target;
                let externalConfig = {};
                if (configUrl) {
                    const configResponse = await fetch(configUrl);
                    if (!configResponse.ok) {
                        return new Response("failed to fetch external config", { status: 502 });
                    }
                    externalConfig = parseExternalConfig(await configResponse.text());
                }
                const proxies = (
                    await Promise.all(
                        rawUrls
                            .split("|")
                            .map((item) => item.trim())
                            .filter(Boolean)
                            .map((subscribeUrl) => fetch(subscribeUrl).then((response) => response.text())),
                    )
                ).flatMap((subContent) => ProxyUtils.parse(subContent));
                const result = ProxyUtils.produce(proxies, client, undefined, { externalConfig });
                console.log(`parsed ${proxies.length} nodes, target client: ${client || "-"}`);

                return new Response(result, {
                    status: 200,
                    headers: { "Content-Type": "text/plain; charset=utf-8" },
                });
            }

            return new Response(null, { status: 403 });
        } catch {
            return new Response(null, { status: 500 });
        }
    }
}
