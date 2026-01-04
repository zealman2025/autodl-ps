# AutoDL PS

一个基于 Adobe UXP 的 Photoshop 插件，用于调用 AutoDL API 进行图像生成。

## 功能特性

- 🎨 调用 AutoDL API 进行图像生成
- 📝 支持自定义提示词
- 🔢 可配置批次大小
- 📊 实时日志显示
- ⏹️ 支持取消正在进行的请求
- 🎯 支持多种 API 类型（07Nunchaku-Qwenimage、qwenbg）
- 🌐 自动检测 API 服务器和 ComfyUI 状态
- 💾 配置保存到本地 JSON 文件
- 🔧 自动修正 API 地址格式（移除路径、添加协议等）

## 安装

**无需构建！** 这是一个纯 JavaScript 版本，可以直接使用。

1. 在 Photoshop 中加载插件：
   - 打开 Photoshop
   - 进入 "插件" 面板
   - 点击 "..." 菜单，选择 "加载插件"
   - 选择 `autodl-ps` 文件夹

## 使用方法

1. 在插件面板中选择 API 类型
2. 根据 API 类型输入相应参数：
   - **07Nunchaku-Qwenimage**: 输入提示词和批次大小
   - **qwenbg**: 使用当前 Photoshop 文档的画布或选区作为输入
3. 点击 "生成" 按钮
4. 查看日志了解生成进度和结果

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

**qwenbg:**
```json
{
  "workflow_id": "qwenbg",
  "input_values": {
    "319:image": "上传的图片文件名",
    "498:seed": 133337086798617
  },
  "client_id": "api-client-xxxxx"
}
```

### 服务器状态检查

插件会自动检查：
- **API 服务器状态**: 显示服务器是否在线（绿点=在线，红点=离线）
- **ComfyUI 状态**: 显示 ComfyUI 服务是否启动（绿点=已启动，红点=未启动）

状态会在以下情况自动更新：
- 插件初始化时
- 保存配置后
- 切换到首页时

## 添加新的 API 类型

以下以添加 `myapi` API 为例，说明如何添加新的 API 类型。

### 步骤 1: 在 `generate` 函数中添加 API 处理逻辑

在 `app.js` 文件的 `AutoDLAPI` 类的 `generate` 方法中（约第 216 行），添加新的 API 处理分支：

```javascript
async generate(text, batchSize = 1, signal, psUtils) {
    try {
        let payload;
        if (this.apiType === 'qwenbg') {
            // ... 现有代码 ...
        } else if (this.apiType === 'myapi') {
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
        } else {
            // ... 默认处理 ...
        }
        
        // 添加日志输出（可选）
        if (this.apiType === 'myapi') {
            this.addLog('info', `输入图像: ${payload.input_values['31:image']}`);
            this.addLog('info', `镜头指令: ${text}`);
        }
        // ... 其余代码 ...
    }
}
```

### 步骤 2: 添加 API 类型选择选项

在首页的 API 类型选择下拉框中（约第 1230 行），添加新选项：

```javascript
<select id="api-type-select" ...>
    <option value="07Nunchaku-Qwenimage" ...>07Nunchaku-Qwenimage</option>
    <option value="qwenbg" ...>qwenbg</option>
    <option value="myapi" ${state.apiType === 'myapi' ? 'selected' : ''}>myapi</option>
</select>
```

在设置页面的 API 类型选择中（约第 1351 行），同样添加：

```javascript
<select id="settings-api-type-select" ...>
    <option value="07Nunchaku-Qwenimage" ...>07Nunchaku-Qwenimage</option>
    <option value="qwenbg" ...>qwenbg</option>
    <option value="myapi" ${state.apiType === 'myapi' ? 'selected' : ''}>myapi</option>
</select>
```

### 步骤 3: 创建渲染函数（可选）

如果需要为该 API 显示特定的输入字段，创建一个渲染函数（约第 1275 行之后）：

```javascript
// 渲染 myapi 字段
function rendermyapiFields() {
    return `
        <div class="form-group">
            <label for="myapi-text-input">镜头移动指令 (82:text)</label>
            <textarea id="myapi-text-input" ${state.isGenerating ? 'disabled' : ''} onchange="state.text = this.value; render();" placeholder="输入镜头移动指令，例如：一段描述词">${state.text}</textarea>
        </div>
        <div class="form-group">
            <label>说明</label>
            <div class="info-box-secondary">
                myapi API 将使用当前 Photoshop 文档的画布或选区（如有）作为输入图像，并根据指令进行镜头移动。
            </div>
        </div>
    `;
}
```

然后在主页面渲染函数中（约第 1236 行）调用：

```javascript
${state.apiType === '07Nunchaku-Qwenimage' ? renderQwenImageFields() : ''}
${state.apiType === 'qwenbg' ? renderQwenbgFields() : ''}
${state.apiType === 'myapi' ? rendermyapiFields() : ''}
```

### 步骤 4: 添加验证逻辑（如需要）

如果该 API 需要提示词验证，在 `handleGenerate` 函数中（约第 792 行）添加：

```javascript
// 对于需要提示词的API，需要检查提示词
if ((state.apiType === '07Nunchaku-Qwenimage' || state.apiType === 'myapi') && !state.text.trim()) {
    addLog('error', '请输入提示词');
    return;
}
```

### 步骤 5: 更新配置加载验证

在 `loadSettingsFromFile` 函数中（约第 972 行），添加新 API 类型到验证列表：

```javascript
if (configData.apiType && (configData.apiType === '07Nunchaku-Qwenimage' || configData.apiType === 'qwenbg' || configData.apiType === 'myapi')) {
    state.apiType = configData.apiType;
}
```

### 步骤 6: 更新生成按钮禁用条件（如需要）

如果该 API 需要提示词，在生成按钮的禁用条件中（约第 1247 行）添加：

```javascript
<button data-action="generate" ${state.isGenerating || ((state.apiType === '07Nunchaku-Qwenimage' || state.apiType === 'myapi') && !state.text.trim()) ? 'disabled' : ''} ...>
```

### 完整示例：myapi API

**请求格式：**
```json
{
  "workflow_id": "myapi",
  "input_values": {
    "31:image": "[上传后的文件名]",
    "82:text": "一段描述词"
  },
  "client_id": "api-client-xxxxx"
}
```

**特点：**
- 需要上传 Photoshop 图像（使用 `exportPhotoshopImage`）
- 需要文本输入（镜头移动指令）
- 不需要批次大小和随机种子

完成以上步骤后，新的 API 类型就可以在插件中使用了。

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

## 系统要求

- Adobe Photoshop 2024 (v24.0.0) 或更高版本
- 支持 UXP 的 Photoshop 版本

## 许可证

MIT License
