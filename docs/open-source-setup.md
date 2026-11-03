# ApplyPilot 开源配置说明

## 项目名称

本项目的开源名称是 **ApplyPilot**，中文名称是 **ApplyPilot · AI 求职表单助手**。

## 个人信息如何配置

源码不包含候选人的简历内容。使用者需要在浏览器扩展侧边栏中配置：

1. 打开“候选人信息库”。
2. 上传自己的 `.txt`、`.md` 或 `.docx` 简历/个人资料。
3. 点击“解析并保存”或“解析并追加”。
4. 后续表单回填时，扩展从浏览器本地信息库读取这些内容。

信息库存储在浏览器的 `chrome.storage.local` 中，不写入 GitHub 仓库。已有信息库继续补充时，使用“解析并追加”，不要把真实简历直接提交到源码目录。

## AI 配置如何填写

在扩展“AI 配置”中新增 Profile，并填写：

```text
Base URL: 使用者自己的 AI 服务地址
协议: chat-completions / responses / anthropic
模型 ID: 使用者有权限调用的模型
API Key: 使用者自己的 Key
```

API Key 只保存在浏览器扩展本地配置中。不要把 Key 写入 TypeScript、JSON、`.env` 文件或 README 示例。

## 本地服务如何配置

启动服务端时，把占位符替换成自己的扩展 ID：

```bash
AUTO_INFO_EXTENSION_ORIGIN=chrome-extension://<your-extension-id> ./auto-info-server
```

服务端会自动生成本地 token。token 保存在 `server/.token`，数据库保存在 `server/data/auto-info.db`，这些文件已被 `.gitignore` 排除。

## 开源前检查清单

- 不提交真实简历、身份证号、手机号、邮箱或求职链接；
- 不提交 API Key、服务端 token、数据库和本地备份；
- 不把带有个人信息的招聘 URL 写进 issue、README 或测试文件；
- 如果新增页面快照，先清理表单现值和 URL 查询参数中的 token；
- 示例资料使用 `<YOUR_NAME>`、`<YOUR_EMAIL>`、`<YOUR_SCHOOL>` 等占位符。

## 关于页面回归样本

项目开发目录中的 `test.html` / `test-*.html` 是历史页面结构回归样本，不参与扩展运行，也不是候选人信息库。开源副本已通过 `.gitignore` 默认排除这些快照，避免发布第三方页面内容；如需要回归测试，请使用者在本地自行准备并清理后的样本。
