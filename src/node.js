import { createServer } from "node:http";
import { ProxyUtils } from "@/core/proxy-utils";
import { parseExternalConfig } from "@/core/proxy-utils/producers/utils";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

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
        const configUrl = url.searchParams.get("config");

        if (!target || !rawUrls) {
            writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("missing target or url");
            log("400");
            return;
        }

        let externalConfig = {};
        if (configUrl) {
            const configResponse = await fetch(configUrl);
            if (!configResponse.ok) {
                writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("failed to fetch external config");
                log("502");
                return;
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
        const result = ProxyUtils.produce(proxies, target, undefined, { externalConfig });

        writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(result);
        log("200", `parsed ${proxies.length} nodes, target client: ${target || "-"}`);
    } catch {
        writeHead(500);
        res.end();
        log("500");
    }
}).listen(Number(process.env.PORT) || 3000, process.env.HOST || "0.0.0.0", () => {
    console.log(`Server is running at http://${process.env.HOST || "0.0.0.0"}:${Number(process.env.PORT) || 3000}`);
});
