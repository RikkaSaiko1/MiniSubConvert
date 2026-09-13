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

function toHeaderName(name) {
    return name.replace(/(^|-)([a-z])/g, (_, separator, char) => separator + char.toUpperCase());
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
