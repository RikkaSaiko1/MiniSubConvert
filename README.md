# MiniSubConvert

使用 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 作为核心的订阅转换,支持部署到 CloudFlare Worker

## 支持的平台 (Target)

| 平台 | Parameter Keys |
| :--- | :--- |
| **Quantumult X** | `qx`, `QX`, `QuantumultX` |
| **Surge** | `surge`, `Surge`, `SurgeMac` |
| **Loon** | `Loon` |
| **Clash** | `clash`, `Clash` |
| **Clash Meta / Mihomo** | `meta`, `clashmeta`, `clash.meta`, `Clash.Meta`, `ClashMeta`, `mihomo`, `Mihomo` |
| **Stash** | `stash`, `Stash` |
| **Shadowrocket** | `shadowrocket`, `Shadowrocket`, `ShadowRocket` |
| **Surfboard** | `surfboard`, `Surfboard` |
| **Sing-box** | `singbox`, `sing-box` |
| **Egern** | `egern`, `Egern` |
| **V2Ray** | `v2`, `v2ray`, `V2Ray` |
| **URI** | `uri`, `URI` |
| **JSON** | `json`, `JSON` |

## 部署 

### Worker

1. 点击右上角的 `Fork` 按钮，将仓库复制到你的 GitHub 账户下。

2. 进入 [Worker](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create) 创建页面

3. 选择 `Continue With Github`

4. 选择Fork的仓库

5. 高级设置->变量名称 新增 `SECRET` 变量(选中加密) 

6. 后续更新只需 Github 中 `Sync fork` 即可


接口遵循以下格式：

```
GET <WORKER_DOMAIN>/<SECRET>/sub?target=<TARGET>&url=<URLS>

可选外部完整配置（例如 ACL4SSR）:

GET <WORKER_DOMAIN>/<SECRET>/sub?target=<TARGET>&url=<URLS>&config=<CONFIG_URL>

GET <WORKER_DOMAIN>/<SECRET>/version
```

*注意：`<SECRET>` 对应 Worker 环境变量中设置的 `SECRET` 值。*

参数说明

- **target**: 目标平台格式（请参考上方支持列表）。
    - 响应会带上与目标格式匹配的 `Content-Type`（Clash 系为 `application/x-yaml`，sing-box / JSON 为 `application/json`，其余为 `text/plain`），以便客户端正确解析。
    - 不在支持列表中的目标（如 `clashr`、`quanx`、`mixed`）会返回 `500`，错误信息中会指明该平台不被支持。
- **url**: 原始订阅链接。
    - **多订阅合并**：如果需要合并多个订阅，请使用竖线 `|` 分隔链接。
    - **URL 编码**：最终拼接后的字符串必须进行 **URL Encode** 编码。
- **config**: 可选。外部完整配置。
    - **URL 形式**：以 `http://` 或 `https://` 开头时按链接抓取。
    - **内联文本**：其他情况一律当作配置正文解析，即可以把 `.ini` / `.yaml` 配置内容直接塞进 `config` 参数，无需先上传到某个可访问的地址。正文同样需要 **URL Encode**。

请求示例 

假设：
- Worker 域名: `example.workers.dev`
- `SECRET`: `129438`
- 目标平台: `mihomo`
- 原始订阅:
    1. `https://example.com/sub1`
    2. `https://example.com/sub2`

**步骤：**

1.  **拼接**: `https://example.com/sub1|https://example.com/sub2`
2.  **编码**: `https%3A%2F%2Fexample.com%2Fsub1%7Chttps%3A%2F%2Fexample.com%2Fsub2`
3.  **最终 URL**:

```
https://example.workers.dev/129438/sub?target=mihomo&url=https%3A%2F%2Fexample.com%2Fsub1%7Chttps%3A%2F%2Fexample.com%2Fsub2
```

### 使用内联文本配置

`config` 也可以直接传配置正文。例如本地存在 `SubConverter_config_lite.ini`：

```ini
[custom]

ruleset=DIRECT,[]GEOIP,CN
ruleset=🚀 PROXY,[]FINAL

custom_proxy_group=🚀 PROXY`select`.*`[]♻️ AUTO
custom_proxy_group=♻️ AUTO`url-test`.*`https://www.apple.com/library/test/success.html`600,,50

enable_rule_generator=true
overwrite_original_rules=true
```

把它 URL Encode 后拼到 `config=`：

```
https://example.workers.dev/129438/sub?target=mihomo&url=<URLS>&config=%5Bcustom%5D%0A%0Aruleset%3DDIRECT...
```

这样就不用为了改一条规则去单独托管一个配置文件。需要注意内联文本会占用 URL 长度，配置较大时仍建议使用 URL 形式。

### INI 配置解析

`config` 指向的 `[custom]` 配置由内置解析器处理，其语义与 subconverter 保持一致（subconverter 用 iniparser 读取），因此从 subconverter 迁移过来的配置无需改写即可使用：

- **键名大小写不敏感**：`ruleset=`、`Ruleset=`、`RULESET=` 等价。
- **等号两侧允许空白**：`custom_proxy_group =X`、`custom_proxy_group= X` 均可解析。
- **注释**：`;` 与 `#` 开头的行都会被忽略。
- **换行与 BOM**：兼容 CRLF 与 UTF-8 BOM 开头的文件。

支持的指令：

| 指令 | 说明 |
| --- | --- |
| `ruleset=<组>,<URL>` | 生成 `rule-providers` 条目与对应的 `RULE-SET` 规则 |
| `ruleset=<组>,[]<类型>,<值>` | 内建规则，如 `[]DOMAIN,example.com`、`[]GEOIP,CN`、`[]FINAL` |
| `custom_proxy_group=<名>`<code>`</code>`<类型>`<code>`</code><code>`</code>`<参数>`<code>`</code><code>`</code>...` | 定义策略组，类型支持 `select`、`url-test`、`fallback`、`load-balance` |
| `enable_rule_generator` / `overwrite_original_rules` | 接受但忽略（本转换器不做规则生成器行为） |

`custom_proxy_group` 的参数按位置识别：

- `[]<名称>` 表示**显式引用另一个策略组**。引用会保留原名，不会被当成同名节点。
- `.*` 表示**包含全部节点**。
- 其余片段视为**节点名过滤条件**：含 `()`、`|`、`^`、`$` 或内联标志 `(?i)` 时按正则匹配，否则按子串匹配。
- `url-test` 组的测速地址为参数中第一个 `http(s)://` 值，测速参数形如 `间隔,超时,容差`，后两段可省略（`300`、`600,,50` 均合法）。

为保证产物能被 mihomo 正常加载，生成阶段还会做以下校正：

- 引用了不存在策略组的成员会被剔除。
- 指向自身或形成环路的组成员会被剔除。
- 节点名与策略组名冲突时自动重命名（避免 mihomo 把节点误判成组引用）。重命名标记写在**名字的文本部分**（`SG` → `SG-tag`），而不是以分隔符结尾的后缀。
- 组内重复成员会被去重（避免 `the duplicate name`）。

### 与 subconverter 串联使用

本项目可作为 subconverter 的**上游**：先用远程 subconverter + INI 完成一次转换，再把产物导入 misub 做最终转换。

多跳转换时，下游（misub、bettbox 等）会重新按地区正则匹配节点名并做 emoji 规范化。因此撞名规避**不能用装饰性后缀**——`SG ·node` 这类后缀会被下游整段抹掉，名字还原成 `🇸🇬 SG`，与同名策略组精确撞名，报 `proxy group 🇸🇬 SG: the duplicate name`。本项目改用文本标记 `SG-tag`：国旗 emoji 加在最前面不影响该标记，下游规范化后节点名仍不等于组名，撞名不会复活。

由于上述校正只在生成阶段生效，两跳之间不会产生组引用冲突。

### Docker

```bash
docker run -d \
    --name minisubconvert \
    -p 3000:3000 \
    -e SECRET=minisubconvert \
    bestrui/minisubconvert
```