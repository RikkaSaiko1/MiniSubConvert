// 验证订阅信息响应头转发：把 worker 源码用 esbuild 打包后再跑真实代码路径
// （src/worker.js 使用目录导入，Node 原生 ESM 无法直接加载，wrangler 由 esbuild 处理）。
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TR = 'trojan://password@example.com:443?allowInsecure=1&sni=example.com#MiSub-Test-Node';
const enc = encodeURIComponent;

function installFetch(routes) {
    globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new TypeError(`Invalid URL: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new TypeError(`scheme ${parsed.protocol} not supported`);
        }
        const route = routes[url];
        if (!route) throw new TypeError(`fetch failed: ${url}`);
        const headers = new Headers();
        for (const [k, v] of Object.entries(route.headers || {})) headers.set(k, v);
        return new Response(route.body, { status: route.status, headers });
    };
}

let pass = 0;
let fail = 0;

async function check(label, query, verify) {
    const url = `https://sub1.rikka0.ccwu.cc/sub?${query}`;
    let res;
    try {
        res = await handler.fetch(new Request(url), env);
    } catch (e) {
        console.log(`[FAIL] ${label} -> THREW ${e.name}: ${e.message}`);
        fail++;
        return;
    }
    const body = await res.text();
    const got = verify(res, body);
    console.log(`${got ? '[PASS]' : '[FAIL]'} ${label}`);
    if (!got) {
        console.log(`       status=${res.status}`);
        console.log(`       subscription-userinfo=${res.headers.get('subscription-userinfo')}`);
        console.log(`       profile-update-interval=${res.headers.get('profile-update-interval')}`);
        console.log(`       profile-web-page-url=${res.headers.get('profile-web-page-url')}`);
    }
    if (got) pass++;
    else fail++;
}

(async () => {
    const esbuild = require('esbuild');
    const bundlePath = path.join(os.tmpdir(), `msc-worker-${process.pid}.mjs`);
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

    const mod = await import(pathToFileURL(bundlePath).href);
    process.on('exit', () => {
        try {
            fs.rmSync(bundlePath, { force: true });
        } catch {
            /* 临时文件清理失败不影响结果 */
        }
    });
    handler = mod.default;
    const DO = mod.MiniSubConvert;

    const UI = 'upload=0; download=434; total=102400; expire=4102329600';
    installFetch({
        'https://a.example/sub': {
            status: 200,
            body: TR,
            headers: {
                'subscription-userinfo': UI,
                'profile-update-interval': '3',
                'profile-web-page-url': 'https://a.example/admin',
            },
        },
        'https://b.example/sub': {
            status: 200,
            body: TR,
            headers: {
                'subscription-userinfo': 'upload=100; download=200; total=1000; expire=4102329600',
            },
        },
        'https://plain.example/sub': { status: 200, body: TR },
        // MiSub 回调源：原始 URL 无 userinfo，改写出的 ?target=nodes 版本有 userinfo。
        'https://misub.example/Profile/Token?base64=&callback_token=external': {
            status: 200,
            body: TR,
            headers: { 'x-misub-mode': 'external-nodes-callback' },
        },
        'https://misub.example/Profile/Token?callback_token=external&target=nodes': {
            status: 200,
            body: TR,
            headers: {
                'subscription-userinfo': UI,
                'profile-update-interval': '24',
                'x-misub-mode': 'node-export-plain',
            },
        },
        // 改写版本存在但依然没有 userinfo -> 应回退原始 URL（原始 URL 有独特节点头）。
        'https://fallback.example/sub?base64=&callback_token=external': {
            status: 200,
            body: 'trojan://orig@example.com:443#OriginalNode',
        },
        'https://fallback.example/sub?callback_token=external&target=nodes': {
            status: 200,
            body: 'trojan://rewritten@example.com:443#RewrittenNode',
        },
    });

    const doInstance = new DO();
    env = {
        MiniSubConvert: {
            idFromName: (n) => n,
            get: () => ({ fetch: (req) => doInstance.fetch(req) }),
        },
    };

    await check(
        'single source forwards all three headers',
        `target=clash&url=${enc('https://a.example/sub')}`,
        (res) =>
            res.headers.get('subscription-userinfo') === UI &&
            res.headers.get('profile-update-interval') === '3' &&
            res.headers.get('profile-web-page-url') === 'https://a.example/admin',
    );

    await check(
        'zero upload preserved',
        `target=clash&url=${enc('https://a.example/sub')}`,
        (res) => /(^|;\s*)upload=0(;|$)/.test(res.headers.get('subscription-userinfo') || ''),
    );

    await check(
        'multi source merges: sum bytes, max expire',
        `target=clash&url=${enc('https://a.example/sub')}|${enc('https://b.example/sub')}`,
        (res) => {
            const ui = res.headers.get('subscription-userinfo') || '';
            const f = Object.fromEntries(
                ui.split(';').map((p) => p.split('=').map((s) => s.trim())),
            );
            return (
                f.upload === '100' &&
                f.download === '634' &&
                f.total === '103400' &&
                f.expire === '4102329600'
            );
        },
    );

    await check(
        'source without userinfo -> no header, still 200',
        `target=clash&url=${enc('https://plain.example/sub')}`,
        (res, body) =>
            res.status === 200 &&
            res.headers.get('subscription-userinfo') === null &&
            body.includes('trojan'),
    );

    await check(
        'raw node link (no fetch) -> no header, still 200',
        `target=clash&url=${enc(TR)}`,
        (res, body) =>
            res.status === 200 &&
            res.headers.get('subscription-userinfo') === null &&
            body.includes('trojan'),
    );

    await check(
        'cors headers still present alongside forwarded headers',
        `target=clash&url=${enc('https://a.example/sub')}`,
        (res) => res.headers.get('access-control-allow-origin') === '*',
    );

    await check(
        'MiSub callback source is rewritten to target=nodes -> userinfo forwarded',
        `target=clash&url=${enc('https://misub.example/Profile/Token?base64=&callback_token=external')}`,
        (res) => res.headers.get('subscription-userinfo') === UI,
    );

    await check(
        'rewrite carries no userinfo -> falls back to original source body',
        `target=clash&url=${enc('https://fallback.example/sub?base64=&callback_token=external')}`,
        (res, body) =>
            res.status === 200 &&
            res.headers.get('subscription-userinfo') === null &&
            body.includes('OriginalNode') &&
            !body.includes('RewrittenNode'),
    );

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
