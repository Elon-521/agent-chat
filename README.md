# 问诊大师 · 温暖陪伴版

这是保留所选“温暖陪伴”设计的 Agent 聊天网站，使用 React + Vite 前端和服务端 API。目前按本地运行模式配置，主流程连接千问 AI 平台的 Managed Agent。API Key 由服务端读取，不发送给浏览器。

## 本地运行

先安装 Node.js 22.15 或更新版本，在本项目文件夹打开 PowerShell：

1. 复制环境变量示例：`Copy-Item .env.example .env`。
2. 用文本编辑器打开 `.env`，填入自己的 `DASHSCOPE_API_KEY`；Agent ID、Environment ID 和接口地址已预填。
3. 安装依赖：`npm.cmd install`。
4. 启动后端：`npm.cmd start`，保持该终端运行。
5. 再打开一个终端，进入同一项目文件夹，运行：`npm.cmd run dev`。
6. 在浏览器打开 Vite 显示的本地地址。

服务端启动时会自动加载项目目录中的 `.env`；修改配置后需重启后端。Windows 使用 `npm.cmd` 可避免 PowerShell 脚本执行策略拦截。本地前端将 `/api` 请求代理到 `http://127.0.0.1:8787`。未配置有效密钥时，页面可以打开，但无法完成真实聊天。

## Managed Agent 配置

`.env.example` 中的主流程配置如下：

```dotenv
DASHSCOPE_API_KEY=
MANAGED_AGENT_ID=agent_01M5F13VM60RY58FXBBVM9HMVR
MANAGED_AGENT_ENVIRONMENT_ID=env_ZjZjYTdjNDlhZWQzNDQ2ZW
MANAGED_AGENT_BASE_URL=https://maas.qianwenaiapi.com/api/v1/agentstudio
MANAGED_AGENT_TIMEOUT_MS=90000
```

`DASHSCOPE_API_KEY` 填入有权访问该 Agent 的千问 AI 平台 API Key，Key 归属对应的 workspace。Managed Agent 使用上面的统一 base URL，不额外传 workspace 参数。`MANAGED_AGENT_TIMEOUT_MS` 是可选的请求超时配置，单位毫秒。

这里的 `agent_…` 是 Managed Agent ID，不能填进普通应用的 `DASHSCOPE_APP_ID`。接口背景见[千问 AI 平台 Managed Agent 官方文档](https://platform.qianwenai.com/docs/api-reference/agent-infra/managed-agents/introduction)。

服务端先连接事件流，再投递消息，并可复用已有 session 延续对话。遇到需要人工审批的操作时，不自动批准。真实连通性和回复效果需要在配置有效密钥后验证。

## 部署到 Vercel

如需上线，将 `outputs/agent-chat` 设为 Vercel 项目根目录，构建命令使用 `npm run build`。在 Settings → Environment Variables 中添加上述服务端变量；`MANAGED_AGENT_TIMEOUT_MS` 可按需配置。后端函数使用 `maxDuration: 120`（秒），部署平台与套餐也须支持相应执行时长。

前端与后端同站部署时，保留 `VITE_API_BASE_URL=/api/chat`。本文是部署说明，不代表网站已部署或真实聊天已验证通过。不要把真实 `.env`、API Key 或带密钥的截图提交到 GitHub，也不要给密钥变量添加 `VITE_` 前缀。

## GitHub Pages 前端 + 独立后端

GitHub Pages 只能托管静态文件，需要另外部署支持 Node.js 和事件流连接的 HTTPS 后端，例如本项目的 Vercel 后端。API Key 和所有 Managed Agent 配置均保存在后端平台。

构建前端时设置：

```dotenv
VITE_API_BASE_URL=https://你的后端域名/api/chat
```

在后端平台设置允许访问的前端来源：

```dotenv
ALLOWED_ORIGIN=https://你的用户名.github.io
```

然后运行 `npm.cmd run build`，将 `dist` 发布到 Pages。

页面保留健康信息免责声明，不能替代医生面诊；紧急情况应联系当地急救或医疗机构。

## GitHub + 国内云部署

GitHub 用来保存代码和自动检查，网站本身建议部署到阿里云国内地域。项目已经提供 `Dockerfile`，可部署到阿里云 SAE、容器服务或支持 Docker 的函数计算 Web 服务；容器会同时提供网页和 `/api/chat`，因此前端继续使用同域的 `VITE_API_BASE_URL=/api/chat`。

云平台需要设置以下服务端环境变量：

```dotenv
DASHSCOPE_API_KEY=你的密钥
MANAGED_AGENT_ID=agent_01M5F13VM60RY58FXBBVM9HMVR
MANAGED_AGENT_ENVIRONMENT_ID=env_ZjZjYTdjNDlhZWQzNDQ2ZW
MANAGED_AGENT_BASE_URL=https://maas.qianwenaiapi.com/api/v1/agentstudio
MANAGED_AGENT_TIMEOUT_MS=90000
HOST=0.0.0.0
PORT=云平台分配的端口
```

不要把真实 `.env` 或 API Key 提交到 GitHub。`.github/workflows/ci.yml` 会在推送和 Pull Request 时自动执行 `npm ci`、`npm test` 和 `npm run build`。如果使用自定义域名在中国大陆长期公开访问，通常还需要完成 ICP 备案；没有备案时可先使用云平台提供的访问地址验证。

## GitHub Pages 前端发布

仓库已包含 `.github/workflows/pages.yml`。推送到 `main` 后，GitHub Actions 会构建 `dist/` 并发布到 Pages，前端会请求当前的 Vercel `/api/chat` 后端；API Key 仍只保存在后端环境变量中。

首次启用时，在 GitHub 仓库打开 **Settings → Pages**，将 **Build and deployment** 的 **Source** 选择为 **GitHub Actions**。之后在 **Actions** 中等待 `Deploy frontend to GitHub Pages` 完成，访问 `https://elon-521.github.io/agent-chat/`。

GitHub Pages 只负责静态网页，不能单独运行 Node.js 后端。中国大陆访问速度受 GitHub 网络状况影响，页面地址可以使用，但不承诺始终稳定或低延迟；如果需要更稳定的国内访问，应把后端和前端一起迁移到国内云服务。
