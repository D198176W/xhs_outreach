# 小红书与 LinkedIn 建联工作台

目标：参考 BOSS 建联的 Chromium remote-debugging/CDP 直连方式，实现小红书账号建联的本地闭环。

## 当前能力

- 输入小红书电脑端账号主页 URL，为每个账号创建会话
- 也可由 `boss_talk/boss_auto_talk/frontend` 为任务名单中有有效小红书或 LinkedIn 主页 URL 的人选创建会话；AI 资料分析仅供沟通参考，不再阻止交接。`?session=编号` 会打开对应会话
- SQLite 落库：账号、会话、消息、风格、事件
- CDP 打开小红书页面，尝试读取页面文本与聊天消息
- AI 生成建议回复的服务接口已预留；未配置模型时使用本地模板兜底
- 前端展示会话、聊天内容、AI 建议、风格控制
- 人工可编辑文案、发送、暂停、恢复、接管
- 遇登录/验证码/风控/找不到输入框时标记为需要人工接管
- LinkedIn 的会话读取目前仍是占位实现；发送前须在工作台人工确认页面和文案

## 启动

1. 启动 Chromium，并开启 CDP：

```powershell
chrome.exe --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=D:\tmp\xhs-cdp https://www.xiaohongshu.com
```

2. 启动服务：

```powershell
cd xhs_outreach
npm run dev
```

3. 打开：

```text
http://127.0.0.1:5188
```

## 环境变量

- `PORT`：本地服务端口，默认 `5188`
- `CDP_PORT`：浏览器 CDP 端口，默认 `9222`
- `AI_API_URL`：可选，AI 生成接口地址
- `AI_API_KEY`：可选，AI 接口密钥

`AI_API_URL` 未配置时，会使用本地规则生成建议回复。

## 说明

这版先把产品与工程骨架搭好。小红书页面 DOM 经常变化，`lib/xhs-adapter.mjs` 里的选择器是多候选兜底策略；后续需要用真实登录后的页面逐步校准。
