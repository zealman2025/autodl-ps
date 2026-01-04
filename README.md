# AutoDL PS

一个基于 Adobe UXP 的 Photoshop 插件，用于调用 AutoDL API 进行图像生成。

## 功能特性

- 🎨 调用 AutoDL API 进行图像生成
- 📝 支持自定义提示词
- 🔢 可配置批次大小
- 📊 实时日志显示
- ⏹️ 支持取消正在进行的请求
- 🎯 支持多种 API 类型（07Nunchaku-Qwenimage、qwenbg、Z-Image）

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
   - **Z-Image**: 输入提示词、尺寸、批次大小和随机种子
3. 点击 "生成" 按钮
4. 查看日志了解生成进度和结果

## API 配置

插件调用以下 API 端点：
- **URL**: 可在"设置"页面配置（默认：`https://uu98101-76679a71ac1c.westd.seetacloud.com:8443`）
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
  }
}
```

**qwenbg:**
```json
{
  "workflow_id": "qwenbg",
  "input_values": {
    "319:image": "上传的图片文件名",
    "498:seed": 133337086798617
  }
}
```

**Z-Image:**
```json
{
  "workflow_id": "Z-Image",
  "input_values": {
    "141:seed": 453236349928716,
    "216:batch_size": 1,
    "376:value": 1280,
    "377:value": 720,
    "544:text": "你的提示词"
  }
}
```

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
