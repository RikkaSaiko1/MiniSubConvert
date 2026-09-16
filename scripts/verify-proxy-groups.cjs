// 回归验证：`custom_proxy_group` 里的组引用必须被保留，且生成的 proxy-groups
// 不得成环（mihomo 遇到环会直接拒绝加载：loop is detected in ProxyGroup）。
//
// 关键点：模拟 workerd 行为 —— fetch() 对非 http(s) 协议直接抛错。
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let passed = 0;
let failed = 0;

function fail(msg) {
    failed += 1;
    console.log(`[FAIL] ${msg}`);
}

function pass(msg) {
    passed += 1;
    console.log(`[PASS] ${msg}`);
}

const enc = encodeURIComponent;

let subBody = '';
let configBody = '';

function installWorkerdFetch() {
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        // workerd 只接受 http/https，其余协议直接抛 TypeError
        if (!/^https?:/i.test(url)) throw new TypeError(`Unsupported URL scheme: ${url}`);
        if (url.includes('config.test')) return new Response(configBody, { status: 200 });
        return new Response(subBody, { status: 200 });
    };
    return () => {
        globalThis.fetch = original;
    };
}

// 解析生成的 YAML 的 proxy-groups 段，模拟 mihomo 的成环检测：
// 成员名若等于某个组名，就视为对该组的引用 -> 有向边；图中存在环即报错。
function parseGroups(yaml) {
    const lines = String(yaml).split(/\r?\n/);
    const groups = [];
    let current = null;
    let inGroups = false;

    for (const raw of lines) {
        if (/^proxy-groups:/.test(raw)) {
            inGroups = true;
            continue;
        }
        if (inGroups && /^[a-zA-Z_-]+:/.test(raw)) break;
        if (!inGroups) continue;

        const nameMatch = raw.match(/^\s*-\s*name:\s*(.+)$/);
        if (nameMatch) {
            current = { name: nameMatch[1].trim(), proxies: [] };
            groups.push(current);
            continue;
        }
        const proxyMatch = raw.match(/^\s{6,}-\s+(.+)$/);
        if (proxyMatch && current) current.proxies.push(proxyMatch[1].trim());
    }
    return groups;
}

// `proxies:` 段里实际存在的节点名。组员名若不在其中也不在组名里，
// mihomo 就只能把它当作无效引用或同名组引用处理。
function parseNodeNames(yaml) {
    const lines = String(yaml).split(/\r?\n/);
    const names = new Set();
    let inProxies = false;

    for (const raw of lines) {
        if (/^proxies:/.test(raw)) {
            inProxies = true;
            continue;
        }
        if (inProxies && /^[a-zA-Z_-]+:/.test(raw)) break;
        if (!inProxies) continue;

        const m = raw.match(/^\s+name:\s*(.+)$/);
        if (m) names.add(m[1].trim());
    }
    return names;
}

function findLoops(groups) {
    const names = new Set(groups.map((g) => g.name));
    const graph = new Map(
        groups.map((g) => [g.name, g.proxies.filter((p) => names.has(p))]),
    );

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map([...names].map((n) => [n, WHITE]));
    const stack = [];
    const loops = [];

    const dfs = (node) => {
        color.set(node, GRAY);
        stack.push(node);
        for (const next of graph.get(node) || []) {
            if (color.get(next) === GRAY) {
                loops.push([...stack.slice(stack.indexOf(next)), next].join(' -> '));
            } else if (color.get(next) === WHITE) {
                dfs(next);
            }
        }
        stack.pop();
        color.set(node, BLACK);
    };

    for (const n of names) if (color.get(n) === WHITE) dfs(n);
    return loops;
}

const groupOf = (groups, name) => groups.find((g) => g.name === name);

let handler;
let env;

(async () => {
    const esbuild = require('esbuild');
    const bundlePath = path.join(os.tmpdir(), `msc-verify-groups-${process.pid}.mjs`);
    await esbuild.build({
        entryPoints: [path.resolve('src/worker.js')],
        outfile: bundlePath,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        logLevel: 'silent',
        banner: {
            js: [
                'import { createRequire as __mscCreateRequire } from "node:module";',
                'const require = __mscCreateRequire(import.meta.url);',
            ].join('\n'),
        },
    });
    process.on('exit', () => {
        try {
            fs.rmSync(bundlePath, { force: true });
        } catch {
            /* 临时文件清理失败不影响结果 */
        }
    });

    const mod = await import(pathToFileURL(bundlePath).href);
    handler = mod.default;
    const DO = mod.MiniSubConvert;
    const doInstance = new DO();

    env = {
        ASSETS: { fetch: async () => new Response('', { status: 404 }) },
        MiniSubConvert: {
            idFromName: (n) => n,
            get: () => ({ fetch: (req) => doInstance.fetch(req) }),
        },
    };

    const restoreFetch = installWorkerdFetch();

    const run = async () => {
        const url =
            'https://worker.test/sub?target=mihomo' +
            `&url=${enc('https://sub.test/nodes')}` +
            `&config=${enc('https://config.test/ini')}`;
        const res = await handler.fetch(new Request(url), env, {});
        return { status: res.status, body: await res.text() };
    };

    const NODES = [
        'HK 01', 'JP 01', 'SG 01', 'US 01', 'TW 01', 'KR 01',
        // 与组名撞车的裸节点名，是 loop is detected 的经典诱因
        'SG', 'HK', 'JP', 'US', 'TW', 'KR',
        'Other Relay',
        // 与策略组完全同名的节点
        '🇸🇬 SG', '🇯🇵 JP',
    ]
        .map((name, i) => `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@10.0.0.${i + 1}:8388#${enc(name)}`)
        .join('\n');

    const REGION_FILTERS = {
        '🇭🇰 HK': '(港|HK|hk|Hong Kong|HongKong|hongkong)',
        '🇯🇵 JP': '(日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan)',
        '🇺🇸 US': '(美|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|United States)',
        '🇹🇼 TW': '(台|新北|彰化|TW|Taiwan)',
        '🇸🇬 SG': '(新加坡|坡|狮城|SG|Singapore)',
        '🇰🇷 KR': '(KR|Korea|KOR|首尔|韩|韓)',
    };

    const ini = [
        '[custom]',
        'ruleset=🚀 PROXY,[]FINAL',
        '',
        'custom_proxy_group=🚀 PROXY`select`.*`[]♻️ AUTO`[]🇭🇰 HK`[]🇯🇵 JP`[]🇺🇸 US`[]🇸🇬 SG`[]🇹🇼 TW`[]🇰🇷 KR`[]🌐 Other',
        'custom_proxy_group=♻️ AUTO`url-test`.*`https://www.apple.com/library/test/success.html`600,5,50',
        'custom_proxy_group=🤖 AI`select`[]🇺🇸 US`[]🚀 PROXY`[]🇸🇬 SG`[]🇯🇵 JP`[]🇰🇷 KR',
        'custom_proxy_group=▶️ YouTube`select`[]🚀 PROXY`[]♻️ AUTO`[]🇸🇬 SG`[]🇭🇰 HK`[]🇯🇵 JP`[]DIRECT',
        ...Object.entries(REGION_FILTERS).map(
            ([name, filter]) =>
                `custom_proxy_group=${name}\`url-test\`${filter}\`https://www.apple.com/library/test/success.html\`600,5,50`,
        ),
        'custom_proxy_group=🌐 Other`url-test`^(?!.*(港|HK|hk|日本|JP|Japan|美|US|台|TW|Taiwan|新加坡|SG|Singapore|KR|Korea)).*$`https://www.apple.com/library/test/success.html`600,5,50',
    ].join('\n');

    const withConfig = async (body) => {
        subBody = body;
        configBody = ini;
        return run();
    };

    try {
        console.log('=== 组引用必须保留，且不得成环 ===');
        const { status, body } = await withConfig(NODES);
        if (status !== 200) {
            fail(`期望 200，实际 ${status}`);
            throw new Error('aborted');
        }

        const groups = parseGroups(body);
        const names = groups.map((g) => g.name);

        if (names.length === 11) {
            pass(`全部 11 个策略组都被保留（${names.length}）`);
        } else {
            fail(`策略组数量应为 11，实际 ${names.length}: ${names.join(' | ')}`);
        }

        const loops = findLoops(groups);
        if (loops.length === 0) {
            pass('生成的 proxy-groups 无环（mihomo 可加载）');
        } else {
            fail(`检测到环: ${loops.join(' ; ')}`);
        }

        // 裸节点名 `SG` 必须被改名，否则会被 mihomo 当成对组 `🇸🇬 SG` 的引用
        const proxySection = body.slice(0, body.indexOf('proxy-groups:'));
        if (proxySection.includes('name: SG ·node') || proxySection.includes('SG ·node')) {
            pass('与组名撞车的裸节点 `SG` 已被改名');
        } else {
            fail('裸节点 `SG` 未被改名，mihomo 会误判成环');
        }

        // 组引用必须指向组，而不是同名节点
        const proxy = groupOf(groups, '🚀 PROXY');
        if (proxy && proxy.proxies.filter((p) => /SG$/.test(p)).includes('🇸🇬 SG')) {
            pass('`🚀 PROXY` 里的 `🇸🇬 SG` 仍是对组的引用');
        } else {
            fail(`\`🚀 PROXY\` 丢失了对组 \`🇸🇬 SG\` 的引用: ${proxy ? proxy.proxies.join(', ') : 'N/A'}`);
        }

        // 与组同名的节点必须【跟着 proxies 段一起改名】。若组员仍写原名，
        // 该名字在 proxies 段里已不存在，mihomo 只能把它解析成对同名组的
        // 引用，于是 `🚀 PROXY -> 🇸🇬 SG` 这类边被凭空造出来 -> loop is detected。
        const nodeNamesInDoc = parseNodeNames(body);
        const unresolved = [];
        for (const g of groups) {
            for (const m of g.proxies) {
                const isBuiltin = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'].includes(m);
                if (!isBuiltin && !nodeNamesInDoc.has(m) && !names.includes(m)) {
                    unresolved.push(`${g.name} -> ${m}`);
                }
            }
        }
        if (unresolved.length === 0) {
            pass('所有组员都能在 proxies 段或组名里解析到');
        } else {
            fail(`组员无法解析（会退化成组引用）: ${unresolved.join(' ; ')}`);
        }

        // mihomo 对同一策略组内的重名成员直接报 `the duplicate name`。
        const dupMembers = [];
        for (const g of groups) {
            const seen = new Set();
            for (const m of g.proxies) {
                if (seen.has(m)) dupMembers.push(`${g.name} -> ${m}`);
                seen.add(m);
            }
        }
        if (dupMembers.length === 0) {
            pass('没有任何策略组含重复成员');
        } else {
            fail(`策略组内存在重复成员: ${dupMembers.join(' ; ')}`);
        }

        if (proxy && proxy.proxies.includes('🇯🇵 JP ·node') && proxy.proxies.includes('🇯🇵 JP')) {
            pass('同名节点 `🇯🇵 JP` 与组引用 `🇯🇵 JP` 被正确区分');
        } else {
            fail(`同名节点/组引用未区分: ${proxy ? proxy.proxies.join(', ') : 'N/A'}`);
        }

        const youtube = groupOf(groups, '▶️ YouTube');
        if (youtube && youtube.proxies.includes('🚀 PROXY') && youtube.proxies.includes('♻️ AUTO')) {
            pass('`▶️ YouTube` 保留了 `🚀 PROXY` / `♻️ AUTO` 引用');
        } else {
            fail(`\`▶️ YouTube\` 丢失组引用: ${youtube ? youtube.proxies.join(', ') : 'N/A'}`);
        }

        const ai = groupOf(groups, '🤖 AI');
        if (ai && ai.proxies.includes('🇺🇸 US') && ai.proxies.includes('🚀 PROXY')) {
            pass('`🤖 AI` 保留 `🇺🇸 US` / `🚀 PROXY` 引用');
        } else {
            fail(`\`🤖 AI\` 组引用异常: ${ai ? ai.proxies.join(', ') : 'N/A'}`);
        }

        // 地区组只能含自己的节点，不能被其它地区的节点污染
        const sg = groupOf(groups, '🇸🇬 SG');
        const sgBad = sg ? sg.proxies.filter((p) => !/SG/.test(p)) : [];
        if (sg && sgBad.length === 0) {
            pass('`🇸🇬 SG` 组未被其它地区节点污染');
        } else {
            fail(`\`🇸🇬 SG\` 组含非 SG 成员: ${sgBad.join(', ')}`);
        }

        // 自我引用必须被剔除
        const selfRefs = groups.filter((g) => g.proxies.includes(g.name));
        if (selfRefs.length === 0) {
            pass('没有任何组引用自身');
        } else {
            fail(`存在自我引用: ${selfRefs.map((g) => g.name).join(', ')}`);
        }

        console.log('\n=== 订阅里没有地区节点时，空组被丢弃且引用被清理 ===');
        const onlyOther = `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@10.0.1.1:8388#${enc('Other Relay')}`;
        const second = await withConfig(onlyOther);
        if (second.status === 200) {
            const groups2 = parseGroups(second.body);
            const loops2 = findLoops(groups2);
            if (loops2.length === 0) {
                pass('空地区组被丢弃后仍无环');
            } else {
                fail(`空地区组场景出现环: ${loops2.join(' ; ')}`);
            }
            const dangling = groups2.filter((g) =>
                g.proxies.some(
                    (p) =>
                        !groups2.some((x) => x.name === p) &&
                        /^(🇭🇰|🇯🇵|🇺🇸|🇸🇬|🇹🇼|🇰🇷|🌐|♻️|🚀|🤖|▶️)/.test(p),
                ),
            );
            if (dangling.length === 0) {
                pass('没有指向已丢弃组的悬空引用');
            } else {
                fail(`存在悬空引用: ${dangling.map((g) => g.name).join(', ')}`);
            }
        } else {
            fail(`空地区组场景期望 200，实际 ${second.status}`);
        }

        // YAML 形式的配置没有 `[]X` 语法，成员是裸字符串。若配置里本就写了
        // 重复成员（`proxies: [SG, SG]`），改名后二者会得到同一个新名，mihomo
        // 会直接报 `proxy group <name>: the duplicate name`。
        console.log('\n=== YAML 配置里的重复成员必须被去重 ===');
        subBody = [
            `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@10.0.2.1:8388#${enc('SG')}`,
            `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@10.0.2.2:8388#${enc('SG')}`,
        ].join('\n');
        configBody = [
            'proxy-groups:',
            '  - name: 🇸🇬 SG',
            '    type: url-test',
            '    url: https://www.apple.com/library/test/success.html',
            '    proxies:',
            '      - SG',
            '      - SG',
        ].join('\n');

        const dup = await run();
        if (dup.status !== 200) {
            fail(`YAML 重复成员场景期望 200，实际 ${dup.status}`);
        } else {
            const dupGroups = parseGroups(dup.body);
            const dupSg = groupOf(dupGroups, '🇸🇬 SG');
            const sgMembers = dupSg ? dupSg.proxies : [];
            const sgDups = sgMembers.filter((m, i) => sgMembers.indexOf(m) !== i);
            if (sgMembers.length > 0 && sgDups.length === 0) {
                pass('YAML 配置里的重复成员已被去重');
            } else {
                fail(`\`🇸🇬 SG\` 仍含重复成员: ${sgMembers.join(', ')}`);
            }
        }
    } finally {
        restoreFetch();
    }

    console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
    if (failed > 0) process.exitCode = 1;
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
