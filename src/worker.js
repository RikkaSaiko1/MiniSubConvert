import { ProxyUtils } from "./core/proxy-utils";
import { parseExternalConfig } from "./core/proxy-utils/producers/utils";
import { collectForwardedHeaders } from "./core/subscription-headers";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response) {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
}

// url 参数可以同时接受「订阅地址」和「节点链接」：
// - http(s):// 的是订阅地址，需要先请求再解析；
// - trojan://、vless://、ss:// 等本身就是节点内容，必须直接解析，
//   否则 fetch() 会因不支持的协议抛错，导致整个请求 500。
function isSubscriptionUrl(source) {
    return /^https?:\/\//i.test(source);
}

async function resolveSource(source) {
    if (!isSubscriptionUrl(source)) return { content: source, headers: null };

    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(
            `failed to fetch subscription: ${source} -> HTTP ${response.status}`,
        );
    }
    return { content: await response.text(), headers: response.headers };
}

function errorResponse(scope, error) {
    const message = (error && error.message) || String(error);
    console.error(`${scope} failed: ${(error && error.stack) || message}`);
    return new Response(`internal error: ${message}\n`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
}

export default {
    async fetch(request, env) {
        const method = request.method.toUpperCase();
        const pathname = new URL(request.url).pathname;
        const secret = env.SECRET || "secret";

        if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

        if (
            !(method === "POST" && (pathname === `/${secret}/api/proxy/parse` || pathname === "/api/proxy/parse")) &&
            !(method === "GET" && (
                pathname === `/${secret}` ||
                pathname === `/${secret}/` ||
                pathname === `/${secret}/sub` ||
                pathname === "/sub" ||
                pathname === `/${secret}/version`
                || pathname === "/version"
            ))
        ) {
            return withCors(new Response(null, { status: 403 }));
        }

        if (method === "GET" && (
            pathname === `/${secret}` ||
            pathname === `/${secret}/` ||
            pathname === `/${secret}/version` ||
            pathname === "/version"
        )) {
            return withCors(new Response("subconverter v0.9.0 backend\n", {
                status: 200,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            }));
        }

        try {
            const response = await env.MiniSubConvert.get(env.MiniSubConvert.idFromName("minisubconvert")).fetch(request);
            return withCors(response);
        } catch (error) {
            return withCors(errorResponse("durable object dispatch", error));
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
                const sources = await Promise.all(
                    rawUrls
                        .split("|")
                        .map((item) => item.trim())
                        .filter(Boolean)
                        .map((source) => resolveSource(source)),
                );
                const proxies = sources.flatMap((source) =>
                    ProxyUtils.parse(source.content),
                );
                const result = ProxyUtils.produce(proxies, client, undefined, { externalConfig });
                console.log(`parsed ${proxies.length} nodes, target client: ${client || "-"}`);

                return new Response(result, {
                    status: 200,
                    headers: {
                        "Content-Type": "text/plain; charset=utf-8",
                        ...collectForwardedHeaders(
                            sources.map((source) => source.headers),
                        ),
                    },
                });
            }

            return new Response(null, { status: 403 });
        } catch (error) {
            return errorResponse(`${method} ${new URL(request.url).pathname}`, error);
        }
    }
}
