// 回归验证：用构建产物 dist/worker.js 跑真实代码路径。
// 关键点：模拟 workerd 行为 —— fetch() 对非 http(s) 协议直接抛错。
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const TR = 'trojan://password@example.com:443?allowInsecure=1&sni=example.com#MiSub-Test-Node';
const enc = encodeURIComponent;

// workerd 语义的 fetch：只接受 http(s)，其它协议抛 TypeError。
function installWorkerdFetch(routes) {
    globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new TypeError(`Invalid URL: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new TypeError(`Fetch API cannot load: ${url}. URL scheme "${parsed.protocol.replace(':', '')}" is not supported.`);
        }
        const route = routes[url];
        if (!route) throw new TypeError(`fetch failed: ${url}`);
        return new Response(route.body, { status: route.status });
    };
}

let pass = 0;
let fail = 0;

async function case_(label, query, expect) {
    const url = `https://sub1.rikka0.ccwu.cc/sub?${query}`;
    let status = null;
    let body = '';
    try {
        const res = await handler.fetch(new Request(url), env);
        status = res.status;
        body = await res.text();
    } catch (e) {
        status = `THREW ${e.name}`;
        body = e.message;
    }
    const ok = expect(status, body);
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}`);
    console.log(`       status=${status} body=${JSON.stringify(body.slice(0, 220))}`);
}

let handler;
let env;

(async () => {
    const mod = await import(pathToFileURL(path.resolve('src/worker.js')).href);
    handler = mod.default;
    const DO = mod.MiniSubConvert;

    installWorkerdFetch({
        'https://good.example/sub': { status: 200, body: TR },
        'https://dead.example/sub': { status: 404, body: 'not found' },
    });

    const doInstance = new DO();
    env = {
        MiniSubConvert: {
            idFromName: (n) => n,
            get: () => ({ fetch: (req) => doInstance.fetch(req) }),
        },
    };

    console.log('=== 原始失败请求（本次 bug 的核心用例）===');
    await case_(`url=节点链接(trojan://) target=clash`, `target=clash&url=${enc(TR)}`, (s, b) =>
        s === 200 && b.includes('type') && b.includes('trojan'),
    );

    console.log('\n=== target 各平台同样应可用 ===');
    for (const t of ['sing-box', 'v2ray', 'surge', 'Loon', 'qx', 'clashmeta', 'stash', 'Surfboard', 'Shadowrocket', 'egern', 'json', 'uri']) {
        await case_(`url=节点链接 target=${t}`, `target=${t}&url=${enc(TR)}`, (s) => s === 200);
    }

    console.log('\n=== 订阅地址仍正常 ===');
    await case_('订阅地址返回含节点', `target=clash&url=${enc('https://good.example/sub')}`, (s, b) =>
        s === 200 && b.includes('MiSub-Test-Node'),
    );

    console.log('\n=== 多个 url 混用（| 分隔）===');
    await case_('节点链接|订阅地址', `target=clash&url=${enc(TR)}|${enc('https://good.example/sub')}`, (s, b) =>
        s === 200 && (b.match(/MiSub-Test-Node/g) || []).length === 2,
    );

    console.log('\n=== 错误不再被静默吞掉 ===');
    await case_('订阅地址 HTTP 404 -> 明确报错', `target=clash&url=${enc('https://dead.example/sub')}`, (s, b) =>
        s === 500 && b.includes('404'),
    );
    await case_('不可达订阅地址 -> 明确报错', `target=clash&url=${enc('https://nope.example/sub')}`, (s, b) =>
        s === 500 && b.includes('internal error'),
    );

    console.log('\n=== 未受影响的行为 ===');
    await case_('缺 target -> 400', `url=${enc(TR)}`, (s, b) => s === 400);
    await case_('不支持的 target -> 500 且有原因', `target=nope&url=${enc(TR)}`, (s, b) =>
        s === 500 && b.toLowerCase().includes('not supported'),
    );
    await case_('空节点内容 -> 200 空列表', `target=clash&url=${enc('https://good.example/sub')}&list=true`, (s) => s === 200);

    console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
    process.exit(fail === 0 ? 0 : 1);
})();
