# Haircare HTML Editor

一个轻量级的可视化 HTML 幻灯片编辑器，专为编辑全屏 HTML PPT 文件而设计。

## 功能特性

| 功能 | 操作方式 |
|------|----------|
| **选中元素** | 单击任意元素，显示紫色选中框 |
| **编辑文字** | 双击元素，直接修改文字内容 |
| **删除元素** | 选中后按 `Delete` 键 |
| **翻页导航** | 顶栏 ◀ ▶ 按钮切换幻灯片 |
| **字体大小** | 右侧面板 `A+` / `A-` / `Reset` |
| **调整页序** | 右侧面板 `⬆ Move Up` / `⬇ Move Down` |
| **保存文件** | 点击 💾 Save，自动创建 `.bak` 备份 |

## 技术架构

```
浏览器
┌─────────────────────────────────────────┐
│  visual-editor.html (编辑器 UI)          │
│  ┌───────────────────────┬────────────┐ │
│  │  <iframe>             │ Info Panel │ │
│  │  原始 HTML 原样渲染     │ 选中信息    │ │
│  │  + 注入编辑脚本         │ 字体/排序   │ │
│  └───────────────────────┴────────────┘ │
└─────────────────────────────────────────┘
         ↕ postMessage 通信
┌─────────────────────────────────────────┐
│  server.js (Express)                     │
│  - GET /preview?path=  注入编辑脚本       │
│  - POST /api/save      保存 + .bak 备份  │
│  - GET /api/browse     文件浏览器         │
└─────────────────────────────────────────┘
```

**核心原理**：通过 `<iframe>` 原样加载 HTML 文件（100% 浏览器原生渲染），在 `</body>` 前注入一段编辑脚本，实现点击选中、双击编辑、删除等操作。编辑器 UI 与 iframe 之间通过 `postMessage` 通信。

## 快速开始

### 方式一：双击启动（推荐）

```
双击 start.bat
```

自动安装依赖并启动，浏览器打开 http://localhost:9001

### 方式二：命令行

```bash
npm install
npm start
```

### 使用流程

1. 打开 http://localhost:9001
2. 点击 📁 Open → 导航选择 HTML 文件
3. 单击选中元素 → 双击编辑文字 → 调整字体/页序
4. 点击 💾 Save 保存（自动备份 `.bak`）

## 适用场景

- **全屏 HTML 幻灯片**（scroll-snap、100vh 布局）
- **静态 HTML 页面**的文字微调
- **培训材料**的快速编辑和页面排序

## 项目文件

```
HTML-editor/
├── server.js            # Express 服务端（文件加载、脚本注入、保存）
├── visual-editor.html   # 编辑器前端 UI
├── start.bat            # Windows 一键启动脚本
├── package.json
└── README.md
```

## 设计决策

- **为什么不用 GrapesJS？** GrapesJS 的组件解析器无法处理复杂的全屏 HTML 幻灯片（:root CSS 变量、scroll-snap、100vh、overflow:hidden），渲染结果一片空白。
- **为什么用 iframe？** iframe 使用浏览器原生渲染引擎，保证 HTML 100% 正确显示，编辑脚本通过注入方式添加，不影响原始渲染。
- **为什么用 display:none 翻页？** scroll-snap 模式下 `scrollIntoView` 和 `scrollTo` 在 iframe 中不可靠，直接隐藏非当前 slide 最稳定。

## 依赖

- Node.js ≥ 14
- Express 4.x

## License

MIT
