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
// 组引用用 `{ __groupRef: name }` 哨兵包裹，以便在 `proxies` 数组被重建时
// 仍能区分“这是引用策略组”与“这是节点”。其余位置一律按名字处理。
function refName(item) {
    return item && typeof item === 'object' ? item.__groupRef : item;
}

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

    const groupNames = new Set(groups.map((group) => group.name));

    const resolved = groups.map((group) => {
        const filters = groupFilters?.[group.name] || [];
        const proxies = group.proxies.flatMap((item) => {
            if (item !== '__ALL_PROXIES__') return [item];
            return nodeNames;
        });

        for (const filter of filters) {
            // 裸片段优先按“引用已有策略组”解释（ACL4SSR 里 `🌍 国外` 的
            // `🇸🇬 SG`、`🇯🇵 JP` 就是组引用）；不指向任何组时才退化成
            // 节点名过滤条件。
            if (groupNames.has(filter)) {
                if (filter !== group.name && !proxies.some((item) => refName(item) === filter)) {
                    proxies.push({ __groupRef: filter });
                }
                continue;
            }

            for (const name of matchFilter(filter, nodeNames)) {
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
                    (item) => builtinOrNode(refName(item)) || names.has(refName(item)),
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

    // 上面剔除了悬空引用，这里剔除成环引用（A -> B -> A）。mihomo 检测到
    // ProxyGroup 成环时会直接拒绝加载（loop is detected），因此从组里去掉
    // 引用自身、或引用后能绕回自己的那个成员；组本身仍保留。
    const groupByName = new Map(kept.map((group) => [group.name, group]));
    const breaksLoop = new WeakSet();
    const visited = new WeakSet();

    const reaches = (from, target) => {
        if (from === target) return true;
        if (breaksLoop.has(from) || visited.has(from)) return false;
        visited.add(from);
        for (const item of from.proxies) {
            const nested = groupByName.get(refName(item));
            if (nested && reaches(nested, target)) return true;
        }
        return false;
    };

    for (const group of kept) {
        const next = group.proxies.filter((item) => {
            const member = refName(item);
            if (member === group.name) return false;
            const nested = groupByName.get(member);
            if (!nested) return true;
            breaksLoop.add(group);
            const loops = reaches(nested, group);
            breaksLoop.delete(group);
            return !loops;
        });

        if (next.length === group.proxies.length) continue;
        $.error(
            `proxy group ${group.name} contains loop references, they will be ignored`,
        );
        group.proxies = next;
    }

    return kept;
}

// custom_proxy_group 里的过滤条件可能是 PCRE 风格的内联标志 (如 `(?i)香港|HK`)、
// 显式分组 (如 `(香港|HK)`)，或普通子串 (如 `香港`)。只有前两类才按正则处理，
// 否则 `🇸🇬 SG` 这类国家名会被当成正则，把 `🇸🇬 SG 🇯🇵 JP` 也一并匹配进组里。
function isRegexFilter(filter) {
    return /\(\?[a-z]+\)/i.test(filter) || /[()|^$]/.test(filter);
}

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

function matchFilter(filter, nodeNames) {
    if (!isRegexFilter(filter)) {
        return nodeNames.filter((name) => name.includes(filter));
    }

    const regex = toFilterRegex(filter);
    return nodeNames.filter((name) => {
        regex.lastIndex = 0;
        return regex.test(name);
    });
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
    const groupRefs = {};
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
            // 显式组引用（`[]X`）与“过滤条件求值出的节点名”必须分开记录：
            // 二者最终都会进 `proxies`，但组引用不能被改名逻辑当成节点处理，
            // 否则 `[]🇯🇵 JP` 这类引用会被替换成同名节点 `🇯🇵 JP ·node`。
            const refs = new Set();
            for (const part of parts) {
                if (!part || /^https?:\/\//.test(part) || /^\d/.test(part)) continue;
                if (part === '.*') {
                    group.proxies.push('__ALL_PROXIES__');
                } else if (part.startsWith('[]')) {
                    const ref = part.slice(2);
                    refs.add(ref);
                    // 用哨兵标记“这是组引用”。节点名可能和组名完全相同
                    // （订阅里就有叫 `🇯🇵 JP` 的节点，而同时存在 `🇯🇵 JP` 组），
                    // 只有来源标记能区分二者；后续 resolveGroupProxies 会重建
                    // `proxies` 数组，因此标记必须随元素一起流动。
                    group.proxies.push({ __groupRef: ref });
                } else {
                    // 其余片段是节点名匹配条件（子串或正则），需在拿到节点列表后求值
                    groupFilters[name] = [...(groupFilters[name] || []), part];
                }
            }
            if (refs.size > 0) groupRefs[name] = refs;
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

    return { 'rule-providers': ruleProviders, rules, 'proxy-groups': groups, groupFilters, groupRefs };
}

// mihomo / Sub-Store 的 `config` 参数可以同时接受「配置地址」和「配置正文」：
// - http(s):// 是配置地址，需要先请求再解析；
// - 其余情况（直接粘贴的 [custom] INI 或 YAML 正文）必须直接解析，
//   否则 fetch() 会因不支持的协议抛错（正文首行的 `[custom]` 会被当成 scheme），
//   导致整个请求 500。
export async function resolveExternalConfig(config) {
    if (!config) return {};

    const isUrl = /^https?:\/\//i.test(config);
    if (!isUrl) return parseExternalConfig(config);

    const response = await fetch(config);
    if (!response.ok) {
        throw new Error(
            `failed to fetch external config: ${config} -> HTTP ${response.status}`,
        );
    }
    return parseExternalConfig(await response.text());
}

// mihomo 判断策略组是否成环时按名字解析引用：成员名只要“看起来指向某个组”
// 就会被当成组引用。典型场景：节点名为 `🇯🇵 JP`，而同时存在 `🇯🇵 JP` 策略组，
// 于是该节点在组里会被 mihomo 当成对组自身的引用 -> loop is detected。
// 这里只改写“确实是节点”的名字，`[]X` 组引用一律保持原样。
function renameCollidingProxies(groups, list) {
    const groupNameSet = new Set(groups.map((group) => group.name));
    if (groupNameSet.size === 0) {
        // 即便没有组名可比对，也必须解包组引用哨兵，避免对象泄漏进 YAML；
        // 同时按名字去重，防止 YAML 配置里重复成员导致 the duplicate name。
        for (const group of groups) {
            const seen = new Set();
            group.proxies = group.proxies
                .map((item) => refName(item))
                .filter((name) => {
                    if (seen.has(name)) return false;
                    seen.add(name);
                    return true;
                });
        }
        return list;
    }

    const nodeNames = new Set(list.map((proxy) => proxy.name));
    const used = new Set([...nodeNames, ...groupNameSet]);
    const renames = new Map();

    // `SG 2` 这类名字来自重名去重。mihomo 按名字解析引用，只要成员名本身
    // “看起来就是”某个组名（去掉国旗等前缀后完全相同）就会误判成环。
    const collides = (nodeName) => {
        // 去掉重名去重追加的 ` N` 序号后再比较
        const base = nodeName.replace(/\s+\d+$/, '');
        for (const groupName of groupNameSet) {
            const trimmed = groupName.trim();
            if (trimmed === nodeName || trimmed === base) return true;
            // 组名形如 `🇸🇬 SG`、节点名形如 `SG`：去掉国旗/emoji 等前缀字符后
            // 与节点名完全一致，mihomo 会把它当成对组自身的引用
            const stripped = trimmed.replace(/^[^\p{L}\p{N}]+/u, '');
            if (stripped === base) return true;
        }
        return false;
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

    // 即便没有节点需要改名，也要继续做组员校正：`proxies` 段里不存在的
    // 名字若恰好等于某个组名，会被 mihomo 当成组引用，可能凭空造出环路。
    for (const proxy of list) {
        proxy.name = renames.get(proxy.name) || proxy.name;
    }

    // 组引用必须原样保留：`[]🇯🇵 JP` 是引用组 `🇯🇵 JP`，即便订阅里存在同名节点
    // 也不能被改名，否则组之间的引用会丢失。
    //
    // 但“同名”并不能说明成员是引用还是节点 —— 必须靠 parse 阶段留下的
    // `{ __groupRef }` 哨兵判断：带哨兵的是引用；过滤条件（`.*`、正则）展开
    // 出来的则是节点，必须跟着 `proxies` 段一起改名，否则成员名在 `proxies`
    // 里不存在，mihomo 只能把它解析成对同名策略组的引用，从而产生
    // loop is detected。
    //
    // YAML 形式的配置没有 `[]X` 语法，成员是裸字符串。这类配置里若本就写了
    // 重复成员（`proxies: [SG, SG]`），改名后两者会得到同一个新名，mihomo
    // 会直接报 `the duplicate name`；因此改名后必须按最终名字去重。
    for (const group of groups) {
        const seen = new Set();
        group.proxies = group.proxies
            .map((item) => {
                const name = refName(item);
                const isRef = item !== null && typeof item === 'object';
                return isRef ? name : (renames.get(name) || name);
            })
            .filter((name) => {
                if (seen.has(name)) return false;
                seen.add(name);
                return true;
            });
    }

    return list;
}

// 重名节点按 `<name> <n>` 追加序号去重。注意不能用“该名字第几次出现”当序号：
// 若原始名单里已存在 `SG 2`，把第二个 `SG` 命名为 `SG 2` 会撞上它，进而递增成
// `SG 2 2` 这种被污染的名字。这里始终在 `<name> n` 上找到第一个未被占用的名字。
export function ensureUniqueProxyNames(list) {
    const usedNames = new Set();

    return list.map((proxy) => {
        const name = proxy.name;
        if (!usedNames.has(name)) {
            usedNames.add(name);
            return proxy;
        }

        let suffix = 2;
        while (usedNames.has(`${name} ${suffix}`)) suffix += 1;
        const uniqueName = `${name} ${suffix}`;

        usedNames.add(uniqueName);
        proxy.name = uniqueName;

        return proxy;
    });
}
