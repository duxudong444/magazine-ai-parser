<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Magazine to Markdown

本项目是一个本地运行的 `Express + Vite + React + TypeScript` 应用，用来上传英文杂志 PDF、提取目录、调用大模型解析文章，并导出 Markdown。

## 本地使用

前置要求：

- Node.js 22 LTS
- npm 10+

步骤：

1. 安装依赖

   ```bash
   npm install
   ```

2. 复制环境变量模板

   ```bash
   copy .env.example .env.local
   ```

3. 编辑 `.env.local`

   至少配置一组可用的 API Key：

   ```env
   VITE_AI_PROVIDER=gemini
   VITE_GEMINI_API_KEY=你的_key
   ```

   也可以不配 `.env.local`，启动后在页面右上角的“设置”里手动填写。

4. 启动开发服务

   ```bash
   npm run dev
   ```

5. 打开浏览器

   [http://localhost:3000](http://localhost:3000)

## 常用命令

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## 说明

- 后端负责接收 PDF 分片上传、解析文本和推送处理状态。
- 前端和后端在本地开发时共用 `3000` 端口。
- `npm run start` 现在也可以直接运行 TypeScript 服务端入口。
