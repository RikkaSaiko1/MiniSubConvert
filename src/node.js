import { createServer } from "node:http";
import { ProxyUtils } from "./core/proxy-utils";
import { resolveExternalConfig } from "./core/proxy-utils/producers/utils";
import { collectForwardedHeaders, contentTypeForTarget, rewriteSourceForProfileHeaders } from "./core/subscription-headers";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

// url 参数可以同时接受「订阅地址」和「节点链接」：
// - http(s):// 的是订阅地址，需要先请求再解析；
// - trojan://、vless://、ss:// 等本身就是节点内容，必须直接解析，
//   否则 fetch() 会因不支持的协议抛错，导致整个请求 500。
function isSubscriptionUrl(source) {
    return /^https?:\/\//i.test(source);
}

async function fetchSource(source) {
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(
            `failed to fetch subscription: ${source} -> HTTP ${response.status}`,
        );
    }
    return { content: await response.text(), headers: response.headers };
}

async function resolveSource(source) {
    if (!isSubscriptionUrl(source)) return { content: source, headers: null };

    const rewritten = rewriteSourceForProfileHeaders(source);
    if (rewritten === source) return fetchSource(source);

    // 改写后拿流量头；若改写版拿不到 userinfo 或请求失败，退回原始 URL，
    // 保证节点内容不因改写而丢失。
    try {
        const rewrittenResult = await fetchSource(rewritten);
        if (rewrittenResult.headers?.get("subscription-userinfo")) {
            return rewrittenResult;
        }
    } catch {
        /* 改写失败则走原始 URL */
    }
    return fetchSource(source);
}


createServer(async (req, res) => {
    const method = (req.method || "").toUpperCase();
    const route = req.url || "";
    const url = new URL(route, "http://localhost");
    const pathname = url.pathname;
    const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket.remoteAddress || "-";
    const secret = process.env.SECRET || "secret";
    const log = (response, extra = "") => console.log(`[${new Date().toISOString()}] ${method} ${ip} ${response} ${route} ${extra ? ` ${extra}` : ""}`);
    if (method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    const writeHead = (status, headers = {}) => res.writeHead(status, { ...corsHeaders, ...headers });

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
        writeHead(403);
        res.end();
        log("403");
        return;
    }

    try {
        if (method === "GET" && (
            pathname === `/${secret}` ||
            pathname === `/${secret}/` ||
            pathname === `/${secret}/version` ||
            pathname === "/version"
        )) {
            writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("subconverter v0.9.0 backend\n");
            log("200");
            return;
        }

        if (method === "POST") {
            let raw = "";
            for await (const chunk of req) raw += chunk;
            const { data, client } = JSON.parse(raw || "{}");
            const proxies = ProxyUtils.parse(data);
            const par_res = ProxyUtils.produce(proxies, client);
            writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ status: "success", data: { par_res } }));
            log("200", `parsed ${proxies.length} nodes, target client: ${client || "-"}`);
            return;
        }

        const target = url.searchParams.get("target");
        const rawUrls = url.searchParams.get("url");
        const config = url.searchParams.get("config");

        if (!target || !rawUrls) {
            writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("missing target or url");
            log("400");
            return;
        }

        let externalConfig = {};
        if (config) {
            try {
                externalConfig = await resolveExternalConfig(config);
            } catch (error) {
                const message = (error && error.message) || String(error);
                writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`failed to fetch external config: ${message}`);
                log("502");
                return;
            }
        }

        const sources = await Promise.all(
            rawUrls
                .split("|")
                .map((item) => item.trim())
                .filter(Boolean)
                .map((source) => resolveSource(source)),
        );

        const proxies = sources
            .flatMap((source) => ProxyUtils.parse(source.content));
        const result = ProxyUtils.produce(proxies, target, undefined, { externalConfig });

        writeHead(200, {
            "Content-Type": contentTypeForTarget(target),
            ...collectForwardedHeaders(sources.map((source) => source.headers)),
        });
        res.end(result);
        log("200", `parsed ${proxies.length} nodes, target client: ${target || "-"}`);
    } catch (error) {
        const message = (error && error.message) || String(error);
        console.error(`${method} ${pathname} failed: ${(error && error.stack) || message}`);
        writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`internal error: ${message}\n`);
        log("500");
    }
}).listen(Number(process.env.PORT) || 3000, process.env.HOST || "0.0.0.0", () => {
    console.log(`Server is running at http://${process.env.HOST || "0.0.0.0"}:${Number(process.env.PORT) || 3000}`);
});
