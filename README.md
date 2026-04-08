# ReadAI 阅读增强器（Chrome 扩展）

一个基于 AI 的阅读增强 Chrome 扩展：在文章页生成摘要与目录，并对原文进行结构化划线标注与术语解释，帮助快速理解与定位重点。

## 功能特性

### 文章分析
- **自动提取正文**：对微信公众号、知乎等常见文章结构做了适配与兜底提取。
- **AI 摘要**：在侧边栏展示摘要。
- **AI 目录（TOC）**：点击目录跳转到原文对应位置，并带滚动联动高亮（scroll spy）。

### AI 智能标注（划线）
| 标注类型 | 样式 | 说明 |
|---|---|---|
| 核心论点 | 黄色底 + 实线下划线 | 主要论点/论据 |
| 数据/事实 | 绿色底 + 实线下划线 | 可验证事实、数据 |
| 观点 | 紫色底 + 实线下划线 | 主观判断/立场 |
| 专业术语 | 浅蓝字 + 蓝色虚线下划线 | 悬停显示解释（全局顶层浮层，不易被遮挡） |

界面截图：
<img width="2558" height="1308" alt="image" src="https://github.com/user-attachments/assets/64fa77af-63eb-4bd0-b4bd-517d32d09a9e" />
<img width="2560" height="1308" alt="image" src="https://github.com/user-attachments/assets/12ef9730-c31e-4213-b85c-1deff6e740e4" />
<img width="2560" height="1298" alt="image" src="https://github.com/user-attachments/assets/f4006dda-d504-46df-9fef-bb510ae442a9" />

### 阅读模式切换（右上角开关）
- **增强**：显示所有 AI 标注与术语提示。
- **原文**：隐藏标注，回到更“干净”的阅读体验。

### 侧边栏交互
- **可拖动**：顶部栏和底部提示条都可拖动侧边栏位置。
- **可缩放**：支持四角拖拽调整宽高；缩放时字号会随宽度自适应。
- **保留布局**：在“分析中 → 结果展示”的切换过程中，如果你拖动/缩放了侧边栏，结果展示时会保持这些改动。

## 安装方法（开发者模式）
1. 下载/克隆本项目到本地
2. 打开 Chrome，访问 `chrome://extensions/`
3. 打开右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择项目根目录 `ai-reader-plugin`

## 配置 API
点击插件图标 → 设置，填写：

| 字段 | 说明 | 示例 |
|---|---|---|
| API 请求地址 | OpenAI 兼容 Chat Completions 地址 | `https://api.openai.com/v1/chat/completions` |
| API Key | 你的密钥 | `sk-...` |
| 模型名称 | 使用的模型 | `gpt-4o-mini` |

界面截图：
<img width="748" height="1130" alt="image" src="https://github.com/user-attachments/assets/884229fd-a487-436c-95ec-313743e53884" />


常见兼容服务示例：
- **OpenAI**：`https://api.openai.com/v1/chat/completions`
- **DeepSeek**：`https://api.deepseek.com/v1/chat/completions`（如 `deepseek-chat`）
- **Moonshot (Kimi)**：`https://api.moonshot.cn/v1/chat/completions`
- **通义千问（兼容模式）**：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- **自建代理**：任何 OpenAI 兼容服务

## 使用方法
1. 打开任意文章页面
2. 点击工具栏插件图标
3. 点击“开始分析”
4. 等待侧边栏从“分析中”切换到“结果”
5. 点击目录跳转、悬停术语查看解释、用右上角开关切换增强/原文

## 注意事项（安全与权限）
- **密钥存储**：API Key 会保存在 `chrome.storage.sync` 中（会随你的浏览器账号同步到其他设备）。如果你不希望同步，请使用专门的测试 Key。
- **权限**：扩展会在网页注入内容脚本以实现标注与侧边栏显示；请仅在你信任的浏览器环境中使用。
- **数据流**：分析请求从浏览器直接发出到你配置的 API 服务；页面内容用于生成摘要/目录/标注。

## 文件结构
```
ai-reader-plugin/
├── manifest.json        # 扩展配置（MV3）
├── popup.html           # 弹窗 UI
├── src/
│   ├── popup.js         # 弹窗逻辑：配置/触发分析/注入脚本
│   ├── background.js    # 后台 SW：统一请求 AI、编排结果
│   ├── content.js       # 页面脚本：提取正文、标注、目录跳转、侧边栏交互
│   └── content.css      # 注入页面样式
└── icons/               # 图标
```
