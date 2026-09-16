// mihomo / Clash 的「订阅信息」（流量、到期时间）来自上游订阅的响应头。
// 转换器自己生成 body，因此必须显式把这些头转发出去，客户端才显示流量统计。

// 这两个头在多源时取第一个提供者即可
export const PROFILE_HEADERS = ["profile-update-interval", "profile-web-page-url"];

// 把多个订阅源的流量信息合并：已用/总流量相加，到期取最晚的一个。
// 单源时原样保留（包括 upload=0 这类合法零值）。
export function mergeSubscriptionUserInfo(headersList) {
    const parsed = headersList
        .map((headers) => headers?.get("subscription-userinfo"))
        .filter(Boolean)
        .map((raw) => {
            const fields = {};
            for (const part of raw.split(";")) {
                const [key, value] = part.split("=").map((item) => item?.trim());
                if (key && value !== undefined && value !== "") {
                    fields[key.toLowerCase()] = value;
                }
            }
            return fields;
        })
        .filter((fields) => Object.keys(fields).length > 0);

    if (parsed.length === 0) return null;
    if (parsed.length === 1) {
        return Object.entries(parsed[0])
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
    }

    const merged = {};

    for (const key of ["upload", "download", "total"]) {
        const values = parsed
            .map((fields) => fields[key])
            .filter((value) => value !== undefined)
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value));
        if (values.length > 0) {
            merged[key] = values.reduce((sum, value) => sum + value, 0);
        }
    }

    const expires = parsed
        .map((fields) => Number(fields.expire))
        .filter((value) => Number.isFinite(value) && value > 0);
    if (expires.length > 0) merged.expire = Math.max(...expires);

    if (Object.keys(merged).length === 0) return null;
    return Object.entries(merged)
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
}

// 部分订阅面板（如 MiSub）给第三方转换器返回的是「节点回调 URL」：
// 形如 ?base64=&callback_token=external，它只输出节点、不输出 Subscription-Userinfo，
// 导致客户端看不到流量统计。
// 同一个面板的 ?target=nodes 分支输出完全等价的节点内容，但会附带流量头，
// 且保留 callback_token 可继续跳过访问计数/通知，因此改写成该形式再请求。
export function rewriteSourceForProfileHeaders(source) {
    let url;
    try {
        url = new URL(source);
    } catch {
        return source;
    }
    if (!url.searchParams.has("callback_token")) return source;
    if (url.searchParams.get("target") === "nodes") return source;

    url.searchParams.delete("base64");
    url.searchParams.set("target", "nodes");
    return url.toString();
}

function toHeaderName(name) {
    return name.replace(/(^|-)([a-z])/g, (_, separator, char) => separator + char.toUpperCase());
}

// 客户端按 Content-Type 决定怎么解析订阅。全部返回 text/plain 会让
// Clash Verge / Stash 这类严格校验的客户端拒绝 YAML/JSON 响应。
// uri / v2ray 输出的是节点链接和 base64 正文，仍是纯文本，不能标成 JSON。
const TARGET_CONTENT_TYPES = [
    [/^(clash|meta|clashmeta|clash\.meta|mihomo|stash)$/i, "application/x-yaml; charset=utf-8"],
    [/^(singbox|sing-box|egern|egern-mac|json)$/i, "application/json; charset=utf-8"],
];
const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

export function contentTypeForTarget(target) {
    const name = String(target || "").trim();
    for (const [pattern, contentType] of TARGET_CONTENT_TYPES) {
        if (pattern.test(name)) return contentType;
    }
    return DEFAULT_CONTENT_TYPE;
}

export function collectForwardedHeaders(headersList) {
    const forwarded = {};

    const userInfo = mergeSubscriptionUserInfo(headersList);
    if (userInfo) forwarded["Subscription-Userinfo"] = userInfo;

    for (const name of PROFILE_HEADERS) {
        for (const headers of headersList) {
            const value = headers?.get(name);
            if (value) {
                forwarded[toHeaderName(name)] = value;
                break;
            }
        }
    }

    return forwarded;
}
