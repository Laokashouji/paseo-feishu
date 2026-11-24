# paseo-feishu

将飞书 / Lark 的会话、待办与日程接入 [Paseo](https://paseo.sh/) 的外部插件。

基于飞书 / Lark 官方开源 CLI [`@larksuite/cli`](https://github.com/larksuite/cli)（`lark-cli`），插件自身不保存任何凭证，直接复用本机 `lark-cli` 登录态，无任何公司内部依赖，支持 macOS、Linux 与 Windows，同时兼容国内飞书（`feishu.cn`）与海外 Lark（`larksuite.com`）。

## 功能

- **飞书侧边栏面板（会话 / 待办 / 日程）**
  - **会话**：分页浏览最近活跃会话（最近附加过的会话置顶），支持服务端群聊搜索 + 最近活跃单聊补充。
  - **待办**：查看未完成待办与逾期状态，侧边栏入口展示逾期待办计数徽标。
  - **日程**：按本机时区查看今日日程、时间段、地点与视频会议标识。
- **输入框附件源（`@` / 附加飞书会话）**
  - 按免打扰状态自动降权排序（普通会话优先，免打扰会话仍可搜索和附加）。
  - 附件仅注入定位参数与 `lark-cli` 查询命令，不内联海量聊天正文，避免撑爆上下文。
- **一键新建对话（带预览确认）**
  - 会话、待办、日程均支持点击「新对话」先预览和编辑首条消息，再选择「创建并填入输入框（草稿）」或「创建并发送」。
  - 在 Paseo 设置页可按来源独立配置工作区归属（复用默认工作区 / 每次新建 / 固定工作区）、默认目录、模型（留空自动使用 Paseo 可用默认模型）、思考强度、权限等级与开场白。
- **命令中心快捷入口**：支持「打开飞书面板」与「飞书插件设置」。

## 前置条件

- Paseo `>= 0.16.0`
- 安装并登录官方开源 CLI [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli)：

```bash
npm install -g @larksuite/cli
# 初始化应用配置（海外 Lark 请加 --brand lark）
lark-cli config init
# 登录个人账号（用于读取会话、待办、日程与群免打扰设置）
lark-cli auth login
```

## 安装

本插件零运行时 npm 依赖，可直接通过 Git 安装：

```bash
paseo plugin install git:Laokashouji/paseo-feishu
```

或使用完整仓库地址：

```bash
paseo plugin install https://github.com/Laokashouji/paseo-feishu.git
```

安装完成后，插件默认 ID 为 `feishu-bridge`。如需升级到最新版本：

```bash
paseo plugin update feishu-bridge
```

## 环境变量（可选）

| 变量 | 说明 |
| --- | --- |
| `FEISHU_LARK_CLI_BIN`（或 `LARK_CLI_BIN`） | 显式指定 `lark-cli` 可执行文件路径。未设置时会自动探测 `PATH` 及常见安装位置（Homebrew、pnpm、npm、nvm、fnm、Volta、Bun、mise、asdf、Scoop、Go 等）。 |
| `FEISHU_BRAND`（或 `LARK_BRAND`） | 显式指定品牌：`feishu`（默认，兜底链接用 `applink.feishu.cn`）或 `lark`（兜底链接用 `applink.larksuite.com`）。未设置时会自动读取 `lark-cli` 配置或根据返回链接推断。 |
| `PASEO_FEISHU_DIR`（或 `FEISHU_PLUGIN_DIR` / `FEISHU_BRIDGE_DIR`） | 自定义插件状态目录（保存 `settings.json`、`ui-state.json`、`recent-attach.json`）。默认使用 `$XDG_CONFIG_HOME/feishu-bridge`、`~/.config/feishu-bridge`（POSIX）或 `%APPDATA%/feishu-bridge`（Windows）。 |

## 本地开发与验证

```bash
pnpm install
pnpm typecheck
pnpm test
```

如需以本地目录方式加载调试：

```bash
paseo plugin install /absolute/path/to/paseo-feishu
paseo plugin reload feishu-bridge
```

## License

[MIT](./LICENSE)
