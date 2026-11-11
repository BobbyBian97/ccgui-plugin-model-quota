# 模型额度胶囊

在 CC GUI 输入框状态栏（分支切换器之后）用胶囊显示**当前会话模型所在渠道**的 5 小时 / 周 / 月额度。

胶囊显示**已用百分比**，悬浮可查看剩余额度、具体用量与重置时间；额度快用完时胶囊自动变为黄色 / 红色。

## 功能

- 自动跟随当前会话：按会话的渠道 / 模型识别数据源，切换会话即切换胶囊
- 也可在插件设置里固定数据源（自动 / 仅 GLM / 仅 OpenCode）
- 每个源最多三个窗口：5 小时、周、月
- 每 2 分钟自动刷新；点击胶囊直接打开插件设置
- 数据源失败时显示简短错误（Key 无效、限流、网络错误等），保留上次成功数据并降级展示

## 支持的数据源

| 数据源 | 窗口 | 接口 |
|---|---|---|
| 智谱 GLM Coding Plan（国内） | 5 小时 / 周 / 月 | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` |
| 智谱 GLM Coding Plan（海外） | 5 小时 / 周 / 月 | `https://api.z.ai/api/monitor/usage/quota/limit` |
| OpenCode Go / Zen | 5 小时 / 周 / 月（账号级，Zen / Go 共用） | `https://opencode.ai/zen/go/v1/usage` |

## 安装

- 市场：CC GUI → 插件 → 搜索「模型额度胶囊」→ 安装
- 本地：CC GUI → 插件 → 从本地目录安装 → 选择本仓库根目录（含 `manifest.json`）

安装后在 插件管理 → 模型额度胶囊 → 齿轮 打开设置，填入对应渠道的 API Key。

## 权限说明

| 权限 | 用途 |
|---|---|
| `ui:composer-status` | 在输入框状态栏注册额度胶囊 |
| `ui:settings-section` | 提供插件设置页（Key、数据源、刷新） |
| `storage` | 在本机插件私有 KV 保存 API Key 与最近一次成功数据 |
| `events` | 订阅 `session://activated` / `session://selection-changed` 以跟随当前会话渠道 |
| `host:models` | 读取本机渠道目录，把会话事件里的渠道 UUID 换成显示名（识别 GLM / OpenCode），只读、不出网 |
| `network:open.bigmodel.cn` | 查询智谱 GLM 国内额度 |
| `network:api.z.ai` | 查询智谱 GLM 海外额度 |
| `network:opencode.ai` | 查询 OpenCode Go 额度 |

## 数据与隐私

- API Key 只保存在本机 CC GUI 插件私有存储（`ctx.storage`），不会上传到任何第三方。
- Key 仅用于向对应厂商的官方额度接口发起查询；不采集、不记录、不外发任何对话内容或文件路径。
- 无遥测、无统计上报。
- 请求经 CC GUI 宿主代理发出（`plugin_http_request`），域名受 `network:` 权限精确约束。

## 开发

仓库结构：

```
.
├── manifest.json              # 插件清单（id / 版本 / 权限 / 贡献点）
├── src/main.js                # 单文件 ESM 源码（无 import / JSX）
├── build.mjs                  # 构建：src/main.js → dist/main.js，并校验体积/黑名单
├── .github/workflows/release.yml  # 推送 tag 时自动构建并附加 Release 附件
├── README.md
└── LICENSE
```

本地构建与自检：

```bash
node build.mjs
```

本地调试：CC GUI → 插件 → 从本地目录安装 → 选择 `dist/`（或仓库根目录）。

## 发版

1. 修改 `manifest.json` 的 `version`（semver，必须严格递增）。
2. 提交并推送，打与版本一致的 tag（不带 `v` 前缀）：

   ```bash
   git tag 0.2.1
   git push origin 0.2.1
   ```

3. GitHub Action 自动构建并把 `main.js`、`manifest.json` 附加到该 tag 的 Release。
4. 已上架版本：向索引仓 `zhukunpenglinyutong/ccgui-plugins` 提「版本登记 PR」（更新 `plugins/model-quota.json` 的版本与 SHA256）。

## 许可证

[MIT](LICENSE)
