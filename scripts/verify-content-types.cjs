/**
 * 校验各 target 的 Content-Type 是否与输出格式匹配。
 * 客户端（Clash Verge / Stash 等）会按 Content-Type 决定解析方式，
 * 全部返回 text/plain 会导致 YAML/JSON 订阅被拒绝。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');

const REPO = path.resolve(__dirname, '..');

const NODES = [
    'vless://296a8de3-c1d1-4745-85a4-011b6da13d1e@150.230.206.130:443?security=tls&type=ws&host=a.test&path=%2Fws&encryption=none#JP',
    'vless://296a8de3-c1d1-4745-85a4-011b6da13d1e@150.230.206.131:443?security=tls&type=ws&host=b.test&path=%2Fws&encryption=none#SG',
].join('\n');

const INI = [
    '[custom]',
    'ruleset=DIRECT,[]DOMAIN,fsend.cn',
    'ruleset=🚀 PROXY,[]FINAL',
    'custom_proxy_group=🚀 PROXY`select`.*',
    'custom_proxy_group=🇯🇵 JP`url-test`(日本|JP)',
    'enable_rule_generator=true',
    'overwrite_original_rules=true',
].join('\n');

const EXPECT = [
    ['clash', 200, /^application\/x-yaml/],
    ['mihomo', 200, /^application\/x-yaml/],
    ['clashmeta', 200, /^application\/x-yaml/],
    ['meta', 200, /^application\/x-yaml/],
    ['stash', 200, /^application\/x-yaml/],
    ['singbox', 200, /^application\/json/],
    ['json', 200, /^application\/json/],
    ['uri', 200, /^text\/plain/],
    ['v2ray', 200, /^text\/plain/],
    ['loon', 200, /^text\/plain/],
    ['surge', 200, /^text\/plain/],
    ['shadowrocket', 200, /^text\/plain/],
];

(async () => {
    let pass = 0, fail = 0;
    const check = (name, ok, detail) => {
        if (ok) { pass++; console.log(`  PASS  ${name}`); }
        else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
    };

    const out = path.join(os.tmpdir(), `worker-ct-${Date.now()}.mjs`);
    await esbuild.build({
        entryPoints: [path.join(REPO, 'src', 'worker.js')],
        bundle: true, outfile: out, platform: 'node', format: 'esm', target: 'node20',
        banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
        logLevel: 'silent',
    });
    const mod = await import(`file://${out.replace(/\\/g, '/')}`);
    const doInstance = new mod.MiniSubConvert();
    const env = { MiniSubConvert: { idFromName: (n) => n, get: () => ({ fetch: (r) => doInstance.fetch(r) }) } };

    const realFetch = globalThis.fetch;
    const nodesResponse = (headers = {}) =>
        new Response(NODES, { status: 200, headers: { 'content-type': 'text/plain', ...headers } });
    globalThis.fetch = async (url, init) =>
        String(url).includes('sub.test') ? nodesResponse() : realFetch(url, init);

    for (const [target, wantStatus, wantCt] of EXPECT) {
        const p = new URLSearchParams();
        p.set('target', target);
        p.set('url', 'https://sub.test/nodes');
        p.set('config', INI);
        const res = await doInstance.fetch(new Request(`https://worker.test/sub?${p.toString()}`, { method: 'GET' }), env);
        const ct = res.headers.get('content-type') || '';
        await res.text();
        check(`${target} -> status ${wantStatus}`, res.status === wantStatus, `got ${res.status}`);
        if (res.status === 200) check(`${target} -> ${wantCt.source}`, wantCt.test(ct), `got "${ct}"`);
    }

    // 订阅信息头必须仍然转发，且不能被 Content-Type 覆盖
    const userinfo = 'upload=1; download=2; total=3; expire=4';
    globalThis.fetch = async (url, init) => String(url).includes('sub.test')
        ? nodesResponse({ 'subscription-userinfo': userinfo, 'profile-update-interval': '6' })
        : realFetch(url, init);
    const p = new URLSearchParams();
    p.set('target', 'clash');
    p.set('url', 'https://sub.test/nodes');
    const res = await doInstance.fetch(new Request(`https://worker.test/sub?${p.toString()}`, { method: 'GET' }), env);
    await res.text();
    check('subscription-userinfo still forwarded', res.headers.get('subscription-userinfo') === userinfo, `got "${res.headers.get('subscription-userinfo')}"`);
    check('profile-update-interval still forwarded', res.headers.get('profile-update-interval') === '6', `got "${res.headers.get('profile-update-interval')}"`);
    check('content-type survives header forwarding', /^application\/x-yaml/.test(res.headers.get('content-type') || ''), `got "${res.headers.get('content-type')}"`);

    globalThis.fetch = realFetch;
    console.log(`\n===== ${pass} passed, ${fail} failed =====`);
    try { fs.unlinkSync(out); } catch { /* ignore */ }
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
