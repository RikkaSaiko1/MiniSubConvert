import _ from 'lodash';
import YAML from '@/utils/yaml';
import { isIPv4, isIPv6 } from '@/utils';
import { normalizeClashYaml } from '@/core/proxy-utils/preprocessors';

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

export function produceClashConfigOutput(list, type, opts = {}) {
    if (type === 'internal') return list;

    const externalConfig = opts.externalConfig || {};
    const externalRuleProviders = externalConfig['rule-providers'] || {};
    const externalRules = Array.isArray(externalConfig.rules)
        ? externalConfig.rules
        : [];
    const externalGroups = Array.isArray(externalConfig['proxy-groups'])
        ? externalConfig['proxy-groups']
        : [];
    const countryAliases = [
        ['香港', '🇭🇰', ['hong kong', 'hk', 'hkg']],
        ['台湾', '🇹🇼', ['taiwan', 'tw', 'twn']],
        ['日本', '🇯🇵', ['japan', 'jp', 'jpn']],
        ['韩国', '🇰🇷', ['korea', 'south korea', 'kr', 'kor']],
        ['新加坡', '🇸🇬', ['singapore', 'sg', 'sgp']],
        ['美国', '🇺🇸', ['united states', 'america', 'usa', 'us', 'en']],
        ['英国', '🇬🇧', ['united kingdom', 'great britain', 'england', 'uk', 'gb', 'gbr']],
        ['德国', '🇩🇪', ['germany', 'de', 'deu']],
        ['法国', '🇫🇷', ['france', 'fr', 'fra']],
        ['加拿大', '🇨🇦', ['canada', 'ca', 'can']],
        ['澳大利亚', '🇦🇺', ['australia', 'au', 'aus']],
        ['印度', '🇮🇳', ['india', 'in', 'ind']],
        ['俄罗斯', '🇷🇺', ['russia', 'ru', 'rus']],
        ['荷兰', '🇳🇱', ['netherlands', 'holland', 'nl', 'nld']],
        ['土耳其', '🇹🇷', ['turkey', 'tr', 'tur']],
    ];
    const proxyNames = list.map((proxy) => proxy.name);
    const searchableText = (proxy) =>
        [proxy.name, proxy.server, proxy.subName, proxy.collectionName]
            .filter(Boolean)
            .join(' ');
    const aliasesForGroup = (groupName) => {
        const normalizedName = String(groupName || '').toLowerCase();
        return countryAliases
            .filter(([name, flag]) =>
                normalizedName.includes(name) || normalizedName.includes(flag),
            )
            .flatMap(([, flag, aliases]) => [flag, ...aliases]);
    };
    const matchesFilter = (proxy, filter, aliases = []) => {
        const text = searchableText(proxy);
        if (aliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase()))) {
            return true;
        }
        if (!filter) return true;
        try {
            const normalizedFilter = filter.replace(/^\(\?i\)/, '');
            return new RegExp(
                normalizedFilter,
                filter.startsWith('(?i)') ? 'i' : '',
            ).test(text);
        } catch {
            return false;
        }
    };
    const resolveAllProxies = (value) => {
        if (value === '__ALL_PROXIES__') return proxyNames;
        if (Array.isArray(value)) return value.flatMap(resolveAllProxies);
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    resolveAllProxies(item),
                ]),
            );
        }
        return value;
    };
    const resolvedExternalGroups = externalGroups.map((group) => {
        const resolvedGroup = resolveAllProxies(group);
        if (!resolvedGroup['include-all']) return resolvedGroup;
        const groupAliases = aliasesForGroup(resolvedGroup.name);

        const dynamicProxies = proxyNames.filter(
            (_, index) =>
            matchesFilter(list[index], resolvedGroup.filter, groupAliases) &&
                (!resolvedGroup['exclude-filter'] ||
                    !matchesFilter(list[index], resolvedGroup['exclude-filter'])),
        );
        const proxies = [
            ...(Array.isArray(resolvedGroup.proxies)
                ? resolvedGroup.proxies
                : []),
            ...dynamicProxies,
        ];
        return {
            ...resolvedGroup,
            proxies: [...new Set(proxies)].length > 0
                ? [...new Set(proxies)]
                : ['DIRECT'],
        };
    });

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
                ...(resolvedExternalGroups.length > 0
                    ? { 'proxy-groups': resolvedExternalGroups }
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
                }
            }
            if (groupType === 'url-test') {
                const url = parts.find((part) => /^https?:\/\//.test(part));
                const interval = parts.find((part) => /^\d+$/.test(part));
                if (url) group.url = url;
                if (interval) group.interval = Number(interval);
            }
            groups.push(group);
        }
    }

    return { 'rule-providers': ruleProviders, rules, 'proxy-groups': groups };
}

export function ensureUniqueProxyNames(list) {
    const nameCounts = new Map();
    const usedNames = new Set();

    return list.map((proxy) => {
        const name = proxy.name;
        let count = nameCounts.get(name) || 0;
        let uniqueName = name;

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
