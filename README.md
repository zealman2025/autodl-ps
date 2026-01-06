# AutoDL PS

一个基于 Adobe UXP 的 Photoshop 插件，用于调用 AutoDL API 进行图像生成。

## 功能特性

- 🎨 调用 AutoDL API 进行图像生成
- 📝 支持自定义提示词
- 🔢 可配置批次大小
- 🎲 随机种子生成（一键生成8位随机数字）
- 📊 实时日志显示
- ⏹️ 支持取消正在进行的请求
- 🎯 支持多种 API 类型
  - **内置 API**: 07Nunchaku-Qwenimage
  - **自定义 API**: 通过 JSON 配置添加任意 API
- 🌐 自动检测 API 服务器和 ComfyUI 状态
- 💾 配置保存到本地 JSON 文件
- 🔧 自动修正 API 地址格式（移除路径、添加协议等）
- ⚠️ API 地址验证（防止输入 ComfyUI 地址而非 API 端点地址）
- 📁 支持在新文档中打开生成的图像
- 🔄 实时进度显示（整体进度和节点进度）

## 安装

**无需构建！** 这是一个纯 JavaScript 版本，可以直接使用。

1. 在 Photoshop 中加载插件：
   - 打开 Photoshop
   - 进入 "插件" 面板
   - 点击 "..." 菜单，选择 "加载插件"
   - 选择 `autodl-ps` 文件夹

## 使用方法

### 基本使用

1. **配置 API 服务器地址**（首次使用）：
   - 切换到 "设置" 标签页
   - 输入 API 服务器地址（通常以 "uu" 开头，例如：`https://uu.example.com:8443`）
   - 选择默认 API 类型
   - 点击 "保存" 按钮

2. **生成图像**：
   - 切换到 "生成" 标签页
   - 选择 API 类型
   - 根据 API 类型输入相应参数：
     - **07Nunchaku-Qwenimage**: 输入提示词和批次大小
     - **自定义 API**: 根据配置的字段输入相应参数
   - 可选：勾选 "在新文档打开" 以在新文档中打开生成的图像
   - 点击 "生成" 按钮
   - 查看日志了解生成进度和结果

### 自定义 API

插件支持通过 JSON 配置添加自定义 API，无需修改代码。

#### 添加自定义 API

1. 切换到 "设置" 标签页
2. 滚动到 "自定义 API 管理" 部分
3. 在文本框中粘贴包含 `workflow_id` 和 `input_values` 的 JSON 代码，例如：

```json
{
  "workflow_id": "qwenbg",
  "input_values": {
    "319:image": "[需要上传图片]",
    "476:seed": 780040281973519,
    "88:string": "示例文本",
    "143:seed": 12345678,
    "58:width": 1024,
    "59:batch_size": 2
  }
}
```

4. 点击 "+ 添加自定义API" 按钮
5. 系统会自动解析字段类型：
   - `*:image` → 图像上传字段（使用当前 Photoshop 文档）
   - `*:seed` → 随机种子字段（支持大数字，带🎲按钮）
   - `*:string` → 文本输入字段
   - `*:width`, `*:batch_size` → 数值字段

#### 删除自定义 API

在 "设置" 标签页的 "自定义 API 管理" 部分，点击对应 API 的 "删除" 按钮。

#### 自定义 API 字段类型

- **图像字段** (`*:image`): 自动使用当前 Photoshop 文档的画布或选区（如有）
- **随机种子字段** (`*:seed`): 支持大数字，点击🎲按钮可随机生成8位数字
- **文本字段** (`*:string`): 普通文本输入
- **数值字段** (`*:width`, `*:batch_size`): 整数输入

## API 配置

插件调用以下 API 端点：
- **URL**: 可在"设置"页面配置，支持自动格式修正（移除路径、添加协议等）
- **方法**: POST
- **Content-Type**: application/json

### 请求格式

根据不同的 API 类型，请求格式会有所不同：

**07Nunchaku-Qwenimage:**
```json
{
  "workflow_id": "07Nunchaku-Qwenimage",
  "input_values": {
    "3:seed": 1234567890,
    "6:text": "你的提示词",
    "58:batch_size": 1
  },
  "client_id": "api-client-xxxxx"
}
```

**自定义 API:**
根据配置的 `workflow_id` 和 `input_values` 动态生成请求。

### ComfyUI 状态检查

插件会自动检查 ComfyUI 服务状态：
- **ComfyUI 状态**: 显示 ComfyUI 服务是否启动（绿点=已启动，红点=未启动）

状态会在以下情况自动更新：
- 插件初始化时
- 保存配置后
- 切换到生成页面时

### API 地址验证

插件会自动检测并警告：
- 如果输入的地址看起来像 ComfyUI 地址（而非 API 端点地址），会显示警告
- API 端点地址通常以 "uu" 开头
- 保存配置时会阻止保存 ComfyUI 地址

## 配置管理

### 配置文件位置

配置保存在 `autodl-config.json` 文件中，包含：
- `apiEndpoint`: API 服务器地址
- `defaultApiType`: 默认 API 类型
- `customApis`: 自定义 API 配置列表

### 配置自动保存

以下操作会自动保存配置：
- 添加自定义 API
- 删除自定义 API
- 保存设置（手动点击"保存"按钮）

### 配置加载

插件启动时会自动从 `autodl-config.json` 加载配置。

## 添加新的 API 类型（代码方式）

如果需要通过修改代码添加新的 API 类型，可以参考以下步骤：

### 步骤 1: 在 `generate` 函数中添加 API 处理逻辑

在 `app.js` 文件的 `AutoDLAPI` 类的 `generate` 方法中（约第 216 行），添加新的 API 处理分支：

```javascript
async generate(text, batchSize = 1, signal, psUtils, customApiConfig = null, customApiValues = {}) {
    try {
        let payload;
        if (this.apiType === 'myapi') {
            // 新增：myapi API 处理
            if (!psUtils) throw new Error('myapi API需要Photoshop工具实例');
            const { file, filename } = await this.exportPhotoshopImage(psUtils);
            const uploadedFilename = await this.uploadImage(file, filename, signal);
            payload = { 
                workflow_id: 'myapi', 
                input_values: { 
                    '31:image': uploadedFilename, 
                    '82:text': text 
                }, 
                client_id: this.clientId 
            };
        } else if (customApiConfig) {
            // ... 自定义API处理 ...
        } else {
            // ... 默认处理 ...
        }
        // ... 其余代码 ...
    }
}
```

### 步骤 2: 添加 API 类型选择选项

在生成页面的 API 类型选择下拉框中（约第 1826 行），添加新选项：

```javascript
<select id="api-type-select" ...>
    <option value="07Nunchaku-Qwenimage" ...>07Nunchaku-Qwenimage</option>
    <option value="myapi" ${state.apiType === 'myapi' ? 'selected' : ''}>myapi</option>
    ${state.customApis.map(api => ...)}
</select>
```

在设置页面的 API 类型选择中（约第 2049 行），同样添加：

```javascript
<select id="settings-api-type-select" ...>
    <option value="07Nunchaku-Qwenimage" ...>07Nunchaku-Qwenimage</option>
    <option value="myapi" ${state.defaultApiType === 'myapi' ? 'selected' : ''}>myapi</option>
    ${state.customApis.map(api => ...)}
</select>
```

### 步骤 3: 创建渲染函数

如果需要为该 API 显示特定的输入字段，创建一个渲染函数（约第 1843 行之后）：

```javascript
// 渲染 myapi 字段
function rendermyapiFields() {
    return `
        <div class="form-group">
            <label for="myapi-text-input">镜头移动指令 (82:text)</label>
            <textarea id="myapi-text-input" ${state.isGenerating ? 'disabled' : ''} placeholder="输入镜头移动指令">${state.text}</textarea>
        </div>
        <div class="form-group">
            <label>说明</label>
            <div class="info-box-secondary">
                myapi API 将使用当前 Photoshop 文档的画布或选区（如有）作为输入图像。
            </div>
        </div>
    `;
}
```

然后在主页面渲染函数中（约第 1825 行）调用：

```javascript
${state.apiType === '07Nunchaku-Qwenimage' ? renderQwenImageFields() : ''}
${state.apiType === 'myapi' ? rendermyapiFields() : ''}
${state.apiType && state.apiType.startsWith('custom_') ? renderCustomApiFields() : ''}
```

### 步骤 4: 添加验证逻辑（如需要）

如果该 API 需要提示词验证，在 `handleGenerate` 函数中添加：

```javascript
// 对于需要提示词的API，需要检查提示词
if ((state.apiType === '07Nunchaku-Qwenimage' || state.apiType === 'myapi') && !state.text.trim()) {
    addLog('error', '请输入提示词');
    return;
}
```

### 推荐方式：使用自定义 API 功能

**更推荐的方式是使用自定义 API 功能**，无需修改代码：
1. 在设置页面粘贴包含 `workflow_id` 和 `input_values` 的 JSON
2. 系统会自动解析并生成对应的输入字段
3. 支持图像上传、随机种子、文本、数值等多种字段类型

## 项目结构

```
autodl-ps/
├── manifest.json          # UXP 插件清单文件
├── index.html            # 主 HTML 文件
├── styles.css            # CSS 样式文件
├── app.js                # JavaScript 应用代码
└── README.md             # 说明文档
```

## 技术说明

- **无需构建**: 所有代码都是纯 JavaScript，不需要任何构建工具
- **文件分离**: CSS 和 JavaScript 已分离为独立文件，便于维护
- **直接运行**: 可以直接在 Photoshop UXP 环境中运行
- **状态管理**: 使用单一 state 对象管理应用状态
- **配置持久化**: 使用 `uxp.storage.localFileSystem` 保存配置到 JSON 文件
- **事件处理**: 使用 `addEventListener` 绑定事件，符合 UXP 规范

## 系统要求

- Adobe Photoshop 2024 (v24.0.0) 或更高版本
- 支持 UXP 的 Photoshop 版本

## 许可证

MIT License
