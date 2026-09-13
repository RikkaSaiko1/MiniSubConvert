import _ from 'lodash';
import YAML from '../../../utils/yaml';
import { isIPv4, isIPv6 } from '../../../utils';
import { normalizeClashYaml } from '../preprocessors';
import $ from '../../app';

export class Result {
    constructor(proxy) {
        this.proxy = proxy;
        this.output = [];
    }

    append(data) {
        if (typeof data === 'undefined') {
            throw new Error('required field is missing');
        }
        this.output.push(data);
    }

    appendIfPresent(data, attr) {
        if (isPresent(this.proxy, attr)) {
            this.append(data);
        }
    }

    toString() {
        return this.output.join('');
    }
}

export function isPresent(obj, attr) {
    const data = _.get(obj, attr);
    return typeof data !== 'undefined' && data !== null;
}

export function isShadowsocksOverTls(proxy) {
    const normalizedNetwork =
        typeof proxy?.network === 'string'
            ? proxy.network.trim().toLowerCase()
            : proxy?.network;
    return (
        proxy?.type === 'ss' &&
        proxy?.tls === true &&
        !isPresent(proxy, 'plugin') &&
        (!isPresent(proxy, 'network') || normalizedNetwork === 'tcp')
    );
}

export function normalizePluginMuxValue(mux) {
    if (typeof mux === 'boolean') return Number(mux);
    if (typeof mux === 'string') {
        const normalized = mux.trim().toLowerCase();
        if (normalized === 'true') return 1;
        if (normalized === 'false') return 0;
        if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
    }
    return mux;
}

export function normalizePluginMuxBooleanValue(mux) {
    return Boolean(normalizePluginMuxValue(mux));
}

export function supportsShadowsocksV2rayPluginMode(proxy, supportedModes) {
    if (proxy?.type !== 'ss' || proxy?.plugin !== 'v2ray-plugin') return true;

    const normalizedMode =
        typeof proxy?.['plugin-opts']?.mode === 'string'
            ? proxy['plugin-opts'].mode.trim().toLowerCase()
            : proxy?.['plugin-opts']?.mode;

    return supportedModes.includes(normalizedMode);
}

function restoreShadowTLSOpts(target, serverNameKey) {
    if (target?.plugin !== 'shadow-tls' || !target['plugin-opts']) {
        return undefined;
    }

    const opts = target['plugin-opts'];
    const enabled =
        Boolean(opts.password) ||
        (opts.version != null && Number(opts.version) !== 0);
    target['shadow-tls-opts'] = {
        password: opts.password,
        version: opts.version,
    };
    if (opts.host != null) target[serverNameKey] = opts.host;
    if (opts.alpn != null) target.alpn = opts.alpn;
    delete target.plugin;
    delete target['plugin-opts'];
    return enabled;
}

export function restoreShadowTLSProxyOpts(proxy) {
    if (['vmess', 'vless', 'trojan', 'anytls'].includes(proxy.type)) {
        const restored = restoreShadowTLSOpts(proxy, 'sni');
        if (restored && ['vmess', 'vless'].includes(proxy.type)) {
            proxy.tls = true;
        }
    }

    if (proxy.type === 'vless' && proxy.network === 'xhttp') {
        const downloadSettings = proxy['xhttp-opts']?.['download-settings'];
        if (restoreShadowTLSOpts(downloadSettings, 'servername')) {
            downloadSettings.tls = true;
        }
    }
}

function parseWireGuardCIDR(cidr, max) {
    if (cidr == null) return undefined;
    const normalized = `${cidr}`.trim();
    if (!/^\d+$/.test(normalized)) return undefined;
    const parsed = parseInt(normalized, 10);
    if (parsed < 0 || parsed > max) return undefined;
    return parsed;
}

function parseWireGuardInterfaceAddress(value, family) {
    if (value == null) return null;
    const raw = `${value}`.trim();
    if (!raw) return null;
    const [, hostRaw = raw, cidrRaw] = /^(.*?)(?:\/(\d+))?$/.exec(raw) || [];
    const host = `${hostRaw}`.trim().replace(/^\[/, '').replace(/\]$/, '');
    const isIPv4Family = family === 'ipv4';
    const isValid = isIPv4Family ? isIPv4(host) : isIPv6(host);
    if (!isValid) return null;
    const max = isIPv4Family ? 32 : 128;
    return {
        address: host,
        cidr: parseWireGuardCIDR(cidrRaw, max),
    };
}

function normalizeWireGuardInterfaceAddress(proxy, config) {
    const { addressKey, cidrKey, family, defaultCIDR } = config;
    const parsed = parseWireGuardInterfaceAddress(proxy[addressKey], family);
    if (!parsed) {
        if (
            proxy[addressKey] == null ||
            `${proxy[addressKey]}`.trim().length === 0
        ) {
            delete proxy[cidrKey];
        }
        return;
    }
    proxy[addressKey] = parsed.address;
    const normalizedCIDR = parseWireGuardCIDR(proxy[cidrKey], defaultCIDR);
    proxy[cidrKey] = normalizedCIDR ?? parsed.cidr ?? defaultCIDR;
}

export function normalizeWireGuardInterface(proxy = {}) {
    normalizeWireGuardInterfaceAddress(proxy, {
        addressKey: 'ip',
        cidrKey: 'ip-cidr',
        family: 'ipv4',
        defaultCIDR: 32,
    });
    normalizeWireGuardInterfaceAddress(proxy, {
        addressKey: 'ipv6',
        cidrKey: 'ipv6-cidr',
        family: 'ipv6',
        defaultCIDR: 128,
    });
    return proxy;
}

export function getWireGuardAddressWithCIDR(proxy = {}, family = 'ipv4') {
    const config =
        family === 'ipv6'
            ? { addressKey: 'ipv6', cidrKey: 'ipv6-cidr', defaultCIDR: 128 }
            : { addressKey: 'ip', cidrKey: 'ip-cidr', defaultCIDR: 32 };
    const parsed = parseWireGuardInterfaceAddress(
        proxy[config.addressKey],
        family,
    );
    if (!parsed) return undefined;
    const normalizedCIDR = parseWireGuardCIDR(
        proxy[config.cidrKey],
        config.defaultCIDR,
    );
    return `${parsed.address}/${
        normalizedCIDR ?? parsed.cidr ?? config.defaultCIDR
    }`;
}

export function produceProxyListOutput(list, type, opts = {}) {
    if (type === 'internal') return list;

    if (opts.prettyYaml || opts['pretty-yaml']) {
        return normalizeClashYaml(
            YAML.safeDump(
                {
                    proxies: list,
                },
                {
                    lineWidth: -1,
                },
            ),
        );
    }

    return (
        'proxies:\n' +
        list.map((proxy) => '  - ' + JSON.stringify(proxy) + '\n').join('')
    );
}

// custom_proxy_group 里的 name 之后是节点名匹配条件（子串或正则），
// 这里把它们求值成真实节点名；`.*` 展开为全部节点。
function resolveGroupProxies(groups, groupFilters, list) {
    const nodeNames = list.map((proxy) => proxy.name);
    const builtins = new Set([
        'DIRECT',
        'REJECT',
        'REJECT-DROP',
        'PASS',
        'COMPATIBLE',
        'GLOBAL',
    ]);

    const resolved = groups.map((group) => {
        const filters = groupFilters?.[group.name] || [];
        const proxies = group.proxies.flatMap((item) => {
            if (item !== '__ALL_PROXIES__') return [item];
            return nodeNames;
        });

        for (const filter of filters) {
            const regex = toFilterRegex(filter);
            const matched = nodeNames.filter((name) => regex.test(name));
            for (const name of matched) {
                if (!proxies.includes(name)) proxies.push(name);
            }
        }

        return { ...group, proxies };
    });

    // 配置里的组引用可能指向一个没有任何节点落入、因而被丢弃的地区组
    // （例如订阅里没有香港节点）。mihomo 遇到这类悬空引用会直接报错，
    // 这里反复剔除悬空引用，直到不再有组因为成员被清空而消失。
    let kept = resolved;
    for (;;) {
        const names = new Set(kept.map((group) => group.name));
        const builtinOrNode = (name) => builtins.has(name) || nodeNames.includes(name);
        const next = kept
            .map((group) => ({
                ...group,
                proxies: group.proxies.filter(
                    (name) => builtinOrNode(name) || names.has(name),
                ),
            }))
            .filter((group) => {
                if (group.proxies.length > 0) return true;
                $.error(
                    `proxy group ${group.name} has no proxies, it will be ignored`,
                );
                return false;
            });

        if (next.length === kept.length) {
            kept = next;
            break;
        }
        kept = next;
    }

    return kept;
}

// custom_proxy_group 里的过滤条件可能是 PCRE 风格的内联标志 (如 `(?i)香港|HK`)，
// 而 JS 的 RegExp 不支持 `(?i)`，这里转换后再构造。
function toFilterRegex(filter) {
    const flags = new Set();
    const pattern = filter.replace(/\(\?([a-z]+)\)/gi, (matched, inlineFlags) => {
        for (const flag of inlineFlags) {
            if ('ims'.includes(flag)) flags.add(flag);
        }
        return '';
    });

    try {
        return new RegExp(pattern, [...flags].join(''));
    } catch {
        // 仍不是合法正则时退化为子串匹配
        return new RegExp(escapeRegExp(pattern), [...flags].join(''));
    }
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function produceClashConfigOutput(list, type, opts = {}) {
    if (type === 'internal') return list;

    const externalConfig = opts.externalConfig || {};
    const externalRuleProviders = externalConfig['rule-providers'] || {};
    const externalRules = Array.isArray(externalConfig.rules)
        ? externalConfig.rules
        : [];
    const externalGroups = Array.isArray(externalConfig['proxy-groups'])
        ? resolveGroupProxies(
              externalConfig['proxy-groups'],
              externalConfig.groupFilters,
              list,
          )
        : [];

    if (externalGroups.length > 0) {
        renameCollidingProxies(externalGroups, list);
    }

    if (
        externalGroups.length === 0 &&
        Object.keys(externalRuleProviders).length === 0 &&
        externalRules.length === 0
    ) {
        return produceProxyListOutput(list, type, opts);
    }

    return normalizeClashYaml(
        YAML.safeDump(
            {
                proxies: list,
                ...(externalGroups.length > 0
                    ? { 'proxy-groups': externalGroups }
                    : {}),
                ...(Object.keys(externalRuleProviders).length > 0
                    ? { 'rule-providers': externalRuleProviders }
                    : {}),
                ...(externalRules.length > 0 ? { rules: externalRules } : {}),
            },
            { lineWidth: -1 },
        ),
    );
}

export function parseExternalConfig(content) {
    const text = String(content || '');
    if (!/^\s*\[custom\]/im.test(text)) {
        return YAML.safeLoad(text) || {};
    }

    const ruleProviders = {};
    const rules = [];
    const groups = [];
    const groupFilters = {};
    const providerNames = new Set();

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';')) continue;

        if (line.startsWith('ruleset=')) {
            const value = line.slice('ruleset='.length);
            const separator = value.indexOf(',');
            if (separator < 0) continue;
            const group = value.slice(0, separator).trim();
            const source = value.slice(separator + 1).trim();
            if (source.startsWith('[]')) {
                const builtin = source.slice(2).split(',');
                rules.push(`${builtin[0] === 'FINAL' ? 'MATCH' : builtin[0]},${builtin.slice(1).join(',')}${builtin.length > 1 ? ',' : ''}${group}`);
                continue;
            }
            const sourcePath = source.split(/[?#]/, 1)[0];
            const sourceName = sourcePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'rule';
            const baseName = sourceName.replace(/[^\w.-]+/g, '_') || 'rule';
            let name = baseName;
            let suffix = 2;
            while (providerNames.has(name)) name = `${baseName}_${suffix++}`;
            providerNames.add(name);
            ruleProviders[name] = {
                type: 'http',
                behavior: 'classical',
                format: 'text',
                url: source,
                path: `./ruleset/${name}.list`,
                interval: 86400,
            };
            rules.push(`RULE-SET,${name},${group}`);
        } else if (line.startsWith('custom_proxy_group=')) {
            const parts = line.slice('custom_proxy_group='.length).split('`');
            const name = parts.shift()?.trim();
            const groupType = parts.shift()?.trim();
            if (!name || !groupType) continue;
            const group = { name, type: groupType === 'url-test' ? 'url-test' : groupType, proxies: [] };
            for (const part of parts) {
                if (!part || /^https?:\/\//.test(part) || /^\d/.test(part)) continue;
                if (part === '.*') {
                    group.proxies.push('__ALL_PROXIES__');
                } else if (part.startsWith('[]')) {
                    group.proxies.push(part.slice(2));
                } else {
                    // 其余片段是节点名匹配条件（子串或正则），需在拿到节点列表后求值
                    groupFilters[name] = [...(groupFilters[name] || []), part];
                }
            }
            if (groupType === 'url-test') {
                const url = parts.find((part) => /^https?:\/\//.test(part));
                if (url) group.url = url;
                // 该字段形如 `interval,timeout,tolerance`，三段落均可留空（如 `600,,50`）
                const times = parts.find((part) => /^\d*\s*,\s*\d*\s*(,\s*\d*)?$/.test(part));
                if (times) {
                    const [interval, , tolerance] = times.split(',').map((value) => Number(value.trim()) || 0);
                    if (interval > 0) group.interval = interval;
                    if (tolerance > 0) group.tolerance = tolerance;
                }
            }
            groups.push(group);
        }
    }

    return { 'rule-providers': ruleProviders, rules, 'proxy-groups': groups, groupFilters };
}

// mihomo 判断策略组是否成环时按名字解析引用，成员名只要“看起来指向组自身”
// 就会误判。典型场景：节点名为 `SG`，而存在名为 `🇸🇬 SG` 的策略组。
// 这里把这类会撞车的节点名改写掉，避免 mihomo 报 loop is detected。
function renameCollidingProxies(groups, list) {
    const groupNames = groups.map((group) => group.name);
    if (groupNames.length === 0) return list;

    const used = new Set(list.map((proxy) => proxy.name));
    const renames = new Map();

    // `SG 2` 这类名字来自重名去重。mihomo 按名字解析引用，只要成员名本身
    // “看起来就是”某个组名（去掉国旗等前缀后完全相同）就会误判成环。
    const collides = (nodeName) => {
        // 去掉重名去重追加的 ` N` 序号后再比较
        const base = nodeName.replace(/\s+\d+$/, '');
        return groupNames.some((groupName) => {
            const trimmed = groupName.trim();
            if (trimmed === nodeName || trimmed === base) return true;
            // 组名形如 `🇸🇬 SG`、节点名形如 `SG`：去掉国旗/emoji 等前缀字符后
            // 与节点名完全一致，mihomo 会把它当成对组自身的引用
            const stripped = trimmed.replace(/^[^\p{L}\p{N}]+/u, '');
            return stripped === base;
        });
    };

    for (const proxy of list) {
        const name = proxy.name;
        if (renames.has(name) || !collides(name)) continue;

        let candidate = `${name} ·node`;
        let suffix = 2;
        while (used.has(candidate)) candidate = `${name} ·node${suffix++}`;

        used.add(candidate);
        renames.set(name, candidate);
    }

    if (renames.size === 0) return list;

    const mapName = (name) => renames.get(name) || name;

    for (const proxy of list) {
        proxy.name = mapName(proxy.name);
    }
    for (const group of groups) {
        group.proxies = group.proxies.map(mapName);
    }

    return list;
}

export function ensureUniqueProxyNames(list) {
    const nameCounts = new Map();
    const usedNames = new Set();

    return list.map((proxy) => {
        const name = proxy.name;
        let count = nameCounts.get(name) || 0;
        let uniqueName;

        do {
            count += 1;
            uniqueName = count === 1 ? name : `${name} ${count}`;
        } while (usedNames.has(uniqueName));

        nameCounts.set(name, count);
        usedNames.add(uniqueName);

        if (uniqueName !== name) {
            proxy.name = uniqueName;
        }

        return proxy;
    });
}
