// 回归验证：INI 解析器与 subconverter(iniparser) 的语义保持一致。
//
// 背景：subconverter 用 iniparser 读取 `[custom]` 配置，而本项目的解析器要
// 产出「与 subconverter 等价」的策略组/规则，否则第一跳产物导入 misub 时
// 会因组结构不同而出现转换冲突（引用不存在的组、组成员重复等）。
//
// iniparser 的两条关键行为（见 iniparser/src/iniparser.c）：
//   1. 键名统一 tolower() -> 大小写不敏感（`Ruleset=` / `RULESET=` 等价）
//   2. 解析前跳过行首空白 -> `key = value` 合法（等号两侧空白被忽略）
// 本项目此前用 `line.startsWith('ruleset=')` 精确匹配，会把上述写法整行
// 静默丢弃，导致策略组凭空消失。
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let passed = 0;
let failed = 0;

const pass = (msg) => { passed += 1; console.log(`[PASS] ${msg}`); };
const fail = (msg) => { failed += 1; console.log(`[FAIL] ${msg}`); };

(async () => {
    const esbuild = require('esbuild');
    const bundlePath = path.join(os.tmpdir(), `msc-verify-ini-parser-${process.pid}.mjs`);
    await esbuild.build({
        entryPoints: [path.resolve('src/core/proxy-utils/producers/utils.js')],
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

    const { parseExternalConfig } = await import(pathToFileURL(bundlePath).href);

    const names = (cfg) => (cfg['proxy-groups'] || []).map((g) => g.name);
    const ruleCount = (cfg) => (cfg.rules || []).length;
    const providerNames = (cfg) => Object.keys(cfg['rule-providers'] || {});

    // 断言某段 INI 能解析出预期的组名（顺序无关）
    const expectGroups = (label, ini, expected) => {
        let cfg;
        try {
            cfg = parseExternalConfig(ini);
        } catch (error) {
            fail(`${label}: 解析抛错 ${error.message}`);
            return;
        }
        const actual = names(cfg);
        if (actual.length === expected.length && expected.every((n) => actual.includes(n))) {
            pass(`${label}: 组=[${actual.join(' | ')}]`);
        } else {
            fail(`${label}: 期望 [${expected.join(' | ')}]，实际 [${actual.join(' | ')}]`);
        }
    };

    console.log('=== 1. 基线：标准写法（回归，不得破坏）===');
    expectGroups(
        '标准 custom_proxy_group',
        '[custom]\ncustom_proxy_group=A`select`.*\ncustom_proxy_group=B`url-test`.*`http://x`300',
        ['A', 'B'],
    );
    expectGroups(
        '标准 ruleset',
        '[custom]\nruleset=G,[]DOMAIN,a.com\nruleset=H,[]FINAL',
        [],
    );
    {
        const cfg = parseExternalConfig('[custom]\nruleset=G,[]DOMAIN,a.com\nruleset=H,[]FINAL');
        if (ruleCount(cfg) === 2) pass('标准 ruleset: 生成 2 条规则');
        else fail(`标准 ruleset: 期望 2 条规则，实际 ${ruleCount(cfg)}`);
    }

    console.log('\n=== 2. 等号两侧空白（iniparser 跳过行首空白）===');
    expectGroups('custom_proxy_group =X', '[custom]\ncustom_proxy_group =A`select`.*', ['A']);
    expectGroups('custom_proxy_group= X', '[custom]\ncustom_proxy_group= A`select`.*', ['A']);
    expectGroups('custom_proxy_group = X', '[custom]\ncustom_proxy_group = A`select`.*', ['A']);
    {
        const cfg = parseExternalConfig('[custom]\nruleset =G,[]FINAL');
        if (ruleCount(cfg) === 1) pass('ruleset =G: 规则生效');
        else fail(`ruleset =G: 期望 1 条规则，实际 ${ruleCount(cfg)}`);
    }
    {
        // 规则组名两侧空白应被 trim，否则会指向不存在的组
        const cfg = parseExternalConfig('[custom]\nruleset = G , []FINAL ');
        const rule = (cfg.rules || [])[0] || '';
        if (rule.endsWith(',G')) pass(`ruleset 组名被 trim: "${rule}"`);
        else fail(`ruleset 组名未 trim: "${rule}"`);
    }

    console.log('\n=== 3. 键名大小写不敏感（iniparser tolower）===');
    expectGroups('全大写 CUSTOM_PROXY_GROUP', '[custom]\nCUSTOM_PROXY_GROUP=A`select`.*', ['A']);
    expectGroups('混合 Custom_Proxy_Group', '[custom]\nCustom_Proxy_Group=A`select`.*', ['A']);
    expectGroups('UPPER + 空格', '[custom]\nCUSTOM_PROXY_GROUP =A`select`.*', ['A']);
    {
        const cfg = parseExternalConfig('[custom]\nRULESET=G,[]DOMAIN,a.com');
        if (ruleCount(cfg) === 1) pass('全大写 RULESET 生效');
        else fail(`全大写 RULESET 未生效 (rules=${ruleCount(cfg)})`);
    }
    {
        // 大小写不敏感后，值部分的 URL / 组名不得被误转小写
        const cfg = parseExternalConfig('[custom]\nRULESET=🚀 PROXY,https://Example.COM/Path/A.list');
        const provider = providerNames(cfg)[0];
        const url = provider ? cfg['rule-providers'][provider].url : '';
        if (url === 'https://Example.COM/Path/A.list') pass('URL 大小写被保留');
        else fail(`URL 大小写被破坏: "${url}"`);
    }

    console.log('\n=== 4. 注释与空行 ===');
    expectGroups('# 注释', '[custom]\n# comment\ncustom_proxy_group=A`select`.*', ['A']);
    expectGroups('; 注释', '[custom]\n; comment\ncustom_proxy_group=A`select`.*', ['A']);
    expectGroups('空行 + 注释混合', '[custom]\n\n; c\n\ncustom_proxy_group=A`select`.*\n\n# c2\n', ['A']);

    console.log('\n=== 5. 换行与 BOM ===');
    expectGroups('CRLF', '[custom]\r\ncustom_proxy_group=A`select`.*\r\n', ['A']);
    expectGroups('CRLF + 空格 + 大写', '[custom]\r\nRuleset = G , []FINAL \r\nCUSTOM_PROXY_GROUP=A`select`.*', ['A']);
    expectGroups('BOM 开头', '\uFEFF[custom]\ncustom_proxy_group=A`select`.*', ['A']);
    expectGroups('BOM + 前置空白', ' \uFEFF[custom]\ncustom_proxy_group=A`select`.*', ['A']);
    expectGroups('[custom] 前有注释行', '; header\n[custom]\ncustom_proxy_group=A`select`.*', ['A']);

    console.log('\n=== 6. 组引用与过滤条件（不得混淆）===');
    {
        const cfg = parseExternalConfig(
            '[custom]\ncustom_proxy_group=🚀 P`select`.*`[]♻️ AUTO\ncustom_proxy_group=♻️ AUTO`url-test`.*`http://x`300',
        );
        const refs = cfg.groupRefs['🚀 P'];
        if (refs && refs.has('♻️ AUTO')) pass('显式组引用被记录到 groupRefs');
        else fail(`显式组引用未记录: ${JSON.stringify(cfg.groupRefs)}`);
    }
    {
        const cfg = parseExternalConfig('[custom]\ncustom_proxy_group=HK`url-test`(港|HK)`http://x`300');
        if ((cfg.groupFilters.HK || []).includes('(港|HK)')) pass('正则过滤条件进入 groupFilters');
        else fail(`过滤条件未记录: ${JSON.stringify(cfg.groupFilters)}`);
    }
    {
        // `.*` 通配应展开为 __ALL_PROXIES__ 而非过滤条件
        const cfg = parseExternalConfig('[custom]\ncustom_proxy_group=A`select`.*');
        const group = (cfg['proxy-groups'] || [])[0];
        if (group && group.proxies.includes('__ALL_PROXIES__')) pass('`.*` 展开为 __ALL_PROXIES__');
        else fail(`\`.*\` 未展开: ${JSON.stringify(group && group.proxies)}`);
    }

    console.log('\n=== 7. url-test 参数解析 ===');
    {
        const cfg = parseExternalConfig('[custom]\ncustom_proxy_group=A`url-test`.*`http://test/x`600,5,50');
        const group = (cfg['proxy-groups'] || [])[0] || {};
        if (group.url === 'http://test/x' && group.interval === 600 && group.tolerance === 50) {
            pass('url-test 的 url/interval/tolerance 均解析正确');
        } else {
            fail(`url-test 参数异常: ${JSON.stringify(group)}`);
        }
    }
    {
        // `600,,50` 省略 timeout，与用户 lite.ini 写法一致
        const cfg = parseExternalConfig('[custom]\ncustom_proxy_group=A`url-test`.*`http://test/x`600,,50');
        const group = (cfg['proxy-groups'] || [])[0] || {};
        if (group.interval === 600 && group.tolerance === 50) pass('`600,,50` 省略 timeout 仍解析正确');
        else fail(`\`600,,50\` 解析异常: ${JSON.stringify(group)}`);
    }
    {
        const cfg = parseExternalConfig('[custom]\ncustom_proxy_group=A`url-test`.*`http://test/x`300');
        const group = (cfg['proxy-groups'] || [])[0] || {};
        // 单参数只设 interval；省略的 timeout/tolerance 不写入产物
        if (group.url === 'http://test/x' && group.interval === 300 && group.tolerance === undefined) {
            pass('仅 interval 时解析正确（不臆造 tolerance）');
        } else {
            fail(`单参数 url-test 异常: ${JSON.stringify(group)}`);
        }
    }

    console.log('\n=== 8. ruleset 形式 ===');
    {
        const cfg = parseExternalConfig('[custom]\nruleset=G,https://a.com/b/c/d.list');
        if (providerNames(cfg).includes('d')) pass('远程 ruleset 生成 provider=d');
        else fail(`远程 ruleset provider 异常: ${providerNames(cfg)}`);
    }
    {
        const cfg = parseExternalConfig('[custom]\nruleset=G,[]GEOIP,CN');
        if ((cfg.rules || [])[0] === 'GEOIP,CN,G') pass('内建 GEOIP 规则正确');
        else fail(`内建 GEOIP 异常: ${JSON.stringify(cfg.rules)}`);
    }
    {
        const cfg = parseExternalConfig('[custom]\nruleset=G,[]FINAL');
        if ((cfg.rules || [])[0] === 'MATCH,G') pass('[]FINAL 转为 MATCH');
        else fail(`[]FINAL 异常: ${JSON.stringify(cfg.rules)}`);
    }
    {
        const cfg = parseExternalConfig('[custom]\nruleset=DIRECT,[]DOMAIN,a.com');
        if ((cfg.rules || [])[0] === 'DOMAIN,a.com,DIRECT') pass('[]DOMAIN 规则正确');
        else fail(`[]DOMAIN 异常: ${JSON.stringify(cfg.rules)}`);
    }

    console.log('\n=== 9. 非 [custom] 内容走 YAML ===');
    {
        const cfg = parseExternalConfig('proxy-groups:\n  - name: X\n    type: select\n');
        if (names(cfg).includes('X')) pass('YAML 配置正常解析');
        else fail(`YAML 配置解析异常: ${JSON.stringify(cfg).slice(0, 120)}`);
    }
    {
        // BOM 不得影响 YAML 判定
        const cfg = parseExternalConfig('\uFEFFproxy-groups:\n  - name: Y\n    type: select\n');
        if (names(cfg).includes('Y')) pass('YAML 配置带 BOM 仍正常解析');
        else fail(`YAML 带 BOM 解析异常: ${JSON.stringify(cfg).slice(0, 120)}`);
    }

    console.log('\n=== 10. 畸形输入不得抛错 ===');
    const malformed = [
        ['空字符串', ''],
        ['仅空白', '   \n\t\n'],
        ['无等号', '[custom]\ncustom_proxy_group`select`.*'],
        ['冒号误写', '[custom]\ncustom_proxy_group: A`select`.*'],
        ['反引号不足', '[custom]\ncustom_proxy_group=A`select'],
        ['缺 groupType', '[custom]\ncustom_proxy_group=A'],
        ['只有规则名', '[custom]\nruleset=A'],
        ['ruleset 无逗号', '[custom]\nruleset=ABC'],
        ['未知指令', '[custom]\nunknown_key=value'],
        ['[custom] 单独一行', '[custom]'],
    ];
    for (const [label, input] of malformed) {
        try {
            parseExternalConfig(input);
            pass(`${label}: 未抛错`);
        } catch (error) {
            fail(`${label}: 抛错 ${error.message}`);
        }
    }

    console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
    if (failed > 0) process.exitCode = 1;
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
