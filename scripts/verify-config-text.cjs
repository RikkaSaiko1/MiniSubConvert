// 回归验证：`config` 参数同时支持「配置地址」和「配置正文」。
// - http(s):// -> 先请求再解析
// - 其余（[custom] INI 正文 / YAML 正文）-> 直接解析
// 关键点：模拟 workerd 行为 —— fetch() 对非 http(s) 协议直接抛错。
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let passed = 0;
let failed = 0;

const pass = (msg) => { passed += 1; console.log(`[PASS] ${msg}`); };
const fail = (msg) => { failed += 1; console.log(`[FAIL] ${msg}`); };

const enc = encodeURIComponent;

// 直接粘贴的 [custom] INI 正文（含换行、注释、emoji）
const INLINE_INI = `[custom]

; 注释不应影响解析
ruleset=🚀 PROXY,[]FINAL

custom_proxy_group=🚀 PROXY\`select\`.*\`[]♻️ AUTO\`[]🇭🇰 HK
custom_proxy_group=♻️ AUTO\`url-test\`.*\`https://www.apple.com/library/test/success.html\`600,,50
custom_proxy_group=🇭🇰 HK\`url-test\`(港|HK|hk)\`https://www.apple.com/library/test/success.html\`600,,50
`;

// YAML 正文（非 [custom] 时走 YAML.safeLoad）
const INLINE_YAML = `proxy-groups:
  - name: 🚀 PROXY
    type: select
    proxies:
      - DIRECT
rules:
  - MATCH,🚀 PROXY
`;

const SUBS = ['HK 01', 'HK', 'JP 01']
    .map((n, i) => `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@10.0.2.${i + 1}:8388#${enc(n)}`)
    .join('\n');

const groupNames = (body) =>
    (body.match(/^\s*-\s*name:\s*(.+)$/gm) || [])
        .map((l) => l.replace(/^\s*-\s*name:\s*/, '').trim());

(async () => {
    const esbuild = require('esbuild');
    const bundlePath = path.join(os.tmpdir(), `msc-verify-config-text-${process.pid}.mjs`);
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
        try { fs.rmSync(bundlePath, { force: true }); } catch { /* 清理失败不影响结果 */ }
    });

    const mod = await import(pathToFileURL(bundlePath).href);
    const handler = mod.default;
    const DO = mod.MiniSubConvert;
    const doInstance = new DO();

    const env = {
        ASSETS: { fetch: async () => new Response('', { status: 404 }) },
        MiniSubConvert: { idFromName: (n) => n, get: () => ({ fetch: (r) => doInstance.fetch(r) }) },
    };

    const requested = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        requested.push(url);
        if (!/^https?:/i.test(url)) throw new TypeError(`Unsupported URL scheme: ${url}`);
        if (url.includes('cfg.test')) return new Response(INLINE_INI, { status: 200 });
        if (url.includes('cfg404.test')) return new Response('nope', { status: 404 });
        return new Response(SUBS, { status: 200 });
    };

    const run = async (configParam) => {
        const qs = [
            'target=mihomo',
            `url=${enc('https://sub.test/n')}`,
        ];
        if (configParam !== undefined) qs.push(`config=${enc(configParam)}`);
        const res = await handler.fetch(new Request(`https://w.test/sub?${qs.join('&')}`), env, {});
        return { status: res.status, body: await res.text() };
    };

    try {
        console.log('=== config=<URL> 仍应正常工作（回归）===');
        requested.length = 0;
        const viaUrl = await run('https://cfg.test/ini');
        if (viaUrl.status === 200 && groupNames(viaUrl.body).length === 3) {
            pass(`URL 模式正常解析出 3 个组`);
        } else {
            fail(`URL 模式异常: status=${viaUrl.status} body=${viaUrl.body.slice(0, 120)}`);
        }
        if (requested.some((u) => u.includes('cfg.test'))) {
            pass('URL 模式确实发起了配置请求');
        } else {
            fail('URL 模式未请求配置地址');
        }

        console.log('\n=== config=<[custom] INI 正文> 应直接解析（本次新增）===');
        requested.length = 0;
        const viaInline = await run(INLINE_INI);
        const inlineGroups = groupNames(viaInline.body);
        if (viaInline.status === 200) {
            pass('正文模式返回 200（此前是 500）');
        } else {
            fail(`正文模式期望 200，实际 ${viaInline.status}: ${viaInline.body.slice(0, 160)}`);
        }
        if (inlineGroups.length === 3) {
            pass(`正文模式解析出 3 个组: ${inlineGroups.join(' | ')}`);
        } else {
            fail(`正文模式组数异常(${inlineGroups.length}): ${inlineGroups.join(' | ')}`);
        }
        if (/^proxy-groups:/m.test(viaInline.body)) {
            pass('正文模式产出含 proxy-groups');
        } else {
            fail('正文模式未产出 proxy-groups');
        }
        // 正文模式不得再去 fetch 任何配置地址
        if (requested.every((u) => !u.includes('cfg.test'))) {
            pass('正文模式未额外请求配置地址');
        } else {
            fail(`正文模式错误地发起了配置请求: ${requested.join(', ')}`);
        }
        // 地区组过滤应生效（HK 组含 HK 节点）
        if (viaInline.body.includes('HK 01')) {
            pass('正文模式节点正常注入');
        } else {
            fail('正文模式节点未注入');
        }

        console.log('\n=== config=<YAML 正文> 应直接解析 ===');
        const viaYaml = await run(INLINE_YAML);
        if (viaYaml.status === 200 && groupNames(viaYaml.body).includes('🚀 PROXY')) {
            pass('YAML 正文解析正常');
        } else {
            fail(`YAML 正文异常: status=${viaYaml.status} body=${viaYaml.body.slice(0, 160)}`);
        }

        console.log('\n=== 不带 config 参数仍应正常工作（回归）===');
        const noConfig = await run(undefined);
        if (noConfig.status === 200) {
            pass('无 config 参数返回 200');
        } else {
            fail(`无 config 参数异常: ${noConfig.status}`);
        }

        console.log('\n=== URL 请求失败仍应返回 502（回归）===');
        const bad = await run('https://cfg404.test/ini');
        if (bad.status === 502) {
            pass('配置地址 404 -> 502');
        } else {
            fail(`配置地址 404 期望 502，实际 ${bad.status}`);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }

    console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
    if (failed > 0) process.exitCode = 1;
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
