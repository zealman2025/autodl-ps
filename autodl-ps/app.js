/**
 * AutoDL API 工具类
 */
class AutoDLAPI {
    constructor(baseUrl, apiType, addLog, updateProgress) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiEndpoint = `${this.baseUrl}/api/workflow/generate`;
        this.uploadEndpoint = `${this.baseUrl}/api/comfy/upload/image`;
        this.apiType = apiType;
        this.addLog = addLog;
        this.updateProgress = updateProgress || (() => {});
        this.clientId = 'api-client-' + Math.random().toString(36).substring(7);
        this.ws = null;
        this.currentPromptId = null;
        this.totalNodes = 11;
        this.executedNodes = 0;
    }

    initWebSocket(promptId) {
        if (this.ws) {
            this.ws.close();
        }
        const wsUrl = this.baseUrl.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/comfyui-ws?clientId=' + this.clientId;
        this.currentPromptId = promptId;
        this.executedNodes = 0;
        try {
            if (typeof WebSocket === 'undefined') {
                this.addLog('info', 'WebSocket 不可用，将使用轮询模式');
                return;
            }
            this.ws = new WebSocket(wsUrl);
            this.ws.onopen = () => this.addLog('info', 'WebSocket 连接已建立');
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.data && data.data.prompt_id && this.currentPromptId && data.data.prompt_id !== this.currentPromptId) return;
                    if (data.type === 'executing' && data.data.node !== undefined) {
                        if (data.data.node === null) {
                            this.updateProgress(100, 100, '执行完成');
                        } else {
                            this.executedNodes++;
                            const percent = Math.min(100, Math.floor((this.executedNodes / this.totalNodes) * 100));
                            this.updateProgress(percent, 0, `节点 ${data.data.node}`);
                        }
                    } else if (data.type === 'progress') {
                        const percent = Math.round((data.data.value / data.data.max) * 100);
                        this.updateProgress(null, percent, null);
                    } else if (data.type === 'executed') {
                        this.updateProgress(100, 100, '执行完成');
                    }
                } catch (error) {}
            };
            this.ws.onerror = () => this.addLog('error', 'WebSocket 连接错误');
            this.ws.onclose = () => {};
        } catch (error) {
            this.addLog('error', `WebSocket 初始化失败: ${error.message}`);
        }
    }

    closeWebSocket() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    async pollTaskResult(promptId, maxAttempts = 60, interval = 2000, signal) {
        const historyEndpoint = `${this.baseUrl}/api/comfy/proxy/history?prompt_id=${promptId}`;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (signal && signal.aborted) throw new Error('轮询被取消');
            try {
                this.addLog('info', `查询任务结果 (${attempt + 1}/${maxAttempts})...`);
                const response = await fetch(historyEndpoint, { method: 'GET', signal });
                if (!response.ok) {
                    if (response.status === 404) {
                        this.addLog('info', '任务尚未完成，继续等待...');
                        if (attempt < maxAttempts - 1) await new Promise(resolve => setTimeout(resolve, interval));
                        continue;
                    }
                    throw new Error(`查询失败: ${response.status} ${response.statusText}`);
                }
                const historyData = await response.json();
                if (historyData[promptId] && historyData[promptId].outputs) {
                    const outputs = historyData[promptId].outputs;
                    const allImages = [];
                    for (const nodeId in outputs) {
                        const nodeOutput = outputs[nodeId];
                        if (nodeOutput.images && Array.isArray(nodeOutput.images)) {
                            nodeOutput.images.forEach((img) => {
                                const imageUrl = `${this.baseUrl}/api/comfy/view?filename=${img.filename}&subfolder=${img.subfolder || ''}&type=${img.type || 'output'}`;
                                allImages.push({ type: 'image', url: imageUrl, filename: img.filename, subfolder: img.subfolder, imageType: img.type });
                            });
                        }
                        if (nodeOutput.gifs && Array.isArray(nodeOutput.gifs)) {
                            nodeOutput.gifs.forEach((vid) => {
                                const videoUrl = `${this.baseUrl}/api/comfy/view?filename=${vid.filename}&subfolder=${vid.subfolder || ''}&type=${vid.type || 'output'}`;
                                allImages.push({ type: 'video', url: videoUrl });
                            });
                        }
                    }
                    if (allImages.length > 0) {
                        this.addLog('success', `找到 ${allImages.length} 个输出结果`);
                        const firstImage = allImages.find(img => img.type === 'image') || allImages[0];
                        return { success: true, prompt_id: promptId, data: allImages, imageUrl: firstImage.url };
                    } else {
                        this.addLog('info', '任务已完成但未找到图像输出，继续检查...');
                    }
                } else {
                    this.addLog('info', '任务尚未完成，继续等待...');
                }
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') throw error;
                this.addLog('info', `查询时出错，继续等待: ${error.message}`);
            }
            if (attempt < maxAttempts - 1) await new Promise(resolve => setTimeout(resolve, interval));
        }
        throw new Error('轮询超时，无法获取任务结果');
    }

    async uploadImage(file, filename, signal) {
        try {
            this.addLog('info', `开始上传图片: ${filename}`);
            const uxp = require('uxp');
            const arrayBuffer = await file.read({ format: uxp.storage.formats.binary });
            if (!arrayBuffer) throw new Error('无法读取文件内容');
            let body, contentType;
            if (typeof FormData !== 'undefined') {
                try {
                    const formData = new FormData();
                    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
                    formData.append('image', blob, filename);
                    formData.append('overwrite', 'true');
                    body = formData;
                    contentType = undefined;
                    this.addLog('info', '使用FormData上传');
                } catch (e) {
                    this.addLog('info', 'FormData不可用，使用手动构建multipart/form-data');
                    throw e;
                }
            } else {
                const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
                const CRLF = '\r\n';
                const formDataParts = [];
                formDataParts.push(`--${boundary}${CRLF}`);
                formDataParts.push(`Content-Disposition: form-data; name="image"; filename="${filename}"${CRLF}`);
                formDataParts.push(`Content-Type: image/jpeg${CRLF}${CRLF}`);
                const textEncoder = new TextEncoder();
                let textParts = formDataParts.join('');
                let textBytes = textEncoder.encode(textParts);
                const imageBytes = new Uint8Array(arrayBuffer);
                formDataParts.length = 0;
                formDataParts.push(`${CRLF}--${boundary}${CRLF}`);
                formDataParts.push(`Content-Disposition: form-data; name="overwrite"${CRLF}${CRLF}`);
                formDataParts.push('true');
                const overwriteParts = formDataParts.join('');
                const overwriteBytes = textEncoder.encode(overwriteParts);
                const endBoundary = textEncoder.encode(`${CRLF}--${boundary}--${CRLF}`);
                const totalLength = textBytes.length + imageBytes.length + overwriteBytes.length + endBoundary.length;
                const combinedBuffer = new Uint8Array(totalLength);
                let offset = 0;
                combinedBuffer.set(textBytes, offset);
                offset += textBytes.length;
                combinedBuffer.set(imageBytes, offset);
                offset += imageBytes.length;
                combinedBuffer.set(overwriteBytes, offset);
                offset += overwriteBytes.length;
                combinedBuffer.set(endBoundary, offset);
                body = combinedBuffer.buffer;
                contentType = `multipart/form-data; boundary=${boundary}`;
                this.addLog('info', '使用手动构建的multipart/form-data上传');
            }
            const headers = {};
            if (contentType) headers['Content-Type'] = contentType;
            this.addLog('info', `尝试上传到: ${this.uploadEndpoint}`);
            const response = await fetch(this.uploadEndpoint, { method: 'POST', headers, body, signal });
            if (!response.ok) {
                const errorText = await response.text();
                this.addLog('error', `上传失败: ${response.status} ${response.statusText}`);
                this.addLog('error', `错误详情: ${errorText}`);
                throw new Error(`上传失败: ${response.status} ${response.statusText}`);
            }
            const result = await response.json();
            let uploadedFilename = filename;
            if (result.name) {
                uploadedFilename = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
            } else if (result.filename) {
                uploadedFilename = result.filename;
            } else if (result.file) {
                uploadedFilename = result.file;
            } else if (typeof result === 'string') {
                uploadedFilename = result;
            }
            this.addLog('success', `图片上传成功: ${uploadedFilename}`);
            return uploadedFilename;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.addLog('error', `上传图片失败: ${errorMessage}`);
            throw error;
        }
    }

    async exportPhotoshopImage(psUtils) {
        try {
            this.addLog('info', '正在从Photoshop导出画布或选区...');
            const result = await psUtils.exportCanvasOrSelection();
            this.addLog('success', `导出成功: ${result.filename}`);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.addLog('error', `导出Photoshop图像失败: ${errorMessage}`);
            throw error;
        }
    }

    async generate(text, batchSize = 1, signal, psUtils, zImageParams) {
        try {
            let payload;
            if (this.apiType === 'qwenbg') {
                if (!psUtils) throw new Error('qwenbg API需要Photoshop工具实例');
                const { file, filename } = await this.exportPhotoshopImage(psUtils);
                const uploadedFilename = await this.uploadImage(file, filename, signal);
                payload = { workflow_id: 'qwenbg', input_values: { '319:image': uploadedFilename, '498:seed': 133337086798617 }, client_id: this.clientId };
            } else if (this.apiType === 'Z-Image') {
                if (!zImageParams) throw new Error('Z-Image API需要额外参数');
                payload = { workflow_id: 'Z-Image', input_values: { '141:seed': zImageParams.seed, '216:batch_size': batchSize, '376:value': zImageParams.width, '377:value': zImageParams.height, '544:text': text }, client_id: this.clientId };
            } else {
                const seed = Math.floor(Date.now() * 1000 + Math.random() * 1000000);
                payload = { workflow_id: '07Nunchaku-Qwenimage', input_values: { '3:seed': seed, '6:text': text, '58:batch_size': batchSize }, client_id: this.clientId };
            }
            this.addLog('info', `发送请求到: ${this.apiEndpoint}`);
            this.addLog('info', `API类型: ${this.apiType}`);
            this.addLog('info', `Workflow ID: ${payload.workflow_id}`);
            if (this.apiType === '07Nunchaku-Qwenimage') {
                this.addLog('info', `提示词: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
                this.addLog('info', `批次大小: ${batchSize}`);
                this.addLog('info', `Seed: ${payload.input_values['3:seed']}`);
            } else if (this.apiType === 'Z-Image') {
                this.addLog('info', `提示词: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
                this.addLog('info', `尺寸: ${payload.input_values['376:value']}x${payload.input_values['377:value']}`);
                this.addLog('info', `批次大小: ${batchSize}`);
                this.addLog('info', `Seed: ${payload.input_values['141:seed']}`);
            } else {
                this.addLog('info', `输入图像: ${payload.input_values['319:image']}`);
                this.addLog('info', `Seed: ${payload.input_values['498:seed']}`);
            }
            const response = await fetch(this.apiEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
            if (!response.ok) {
                const errorText = await response.text();
                this.addLog('error', `API 响应错误: ${response.status} ${response.statusText}`);
                this.addLog('error', `错误详情: ${errorText}`);
                throw new Error(`API 调用失败: ${response.status} ${response.statusText}`);
            }
            const result = await response.json();
            this.addLog('success', 'API 调用成功');
            this.addLog('info', `响应数据结构: ${JSON.stringify(result, null, 2).substring(0, 500)}...`);
            if (!result.success) throw new Error('API 返回失败状态');
            const promptId = result?.prompt_id;
            if (promptId) {
                this.addLog('info', `检测到 prompt_id: ${promptId}，开始轮询任务结果...`);
                this.initWebSocket(promptId);
                const pollResult = await this.pollTaskResult(promptId, 60, 2000, signal);
                this.closeWebSocket();
                return pollResult;
            }
            let imageUrl = null;
            if (result?.data && Array.isArray(result.data) && result.data.length > 0) {
                const imageData = result.data.find((item) => item.type === 'image');
                if (imageData?.url) {
                    imageUrl = imageData.url;
                    this.addLog('success', `找到图像URL: ${imageData.url.substring(0, 100)}...`);
                    if (imageData.size) this.addLog('info', `图像尺寸: ${imageData.size}`);
                }
            }
            if (!imageUrl) {
                if (result?.outputs && Array.isArray(result.outputs) && result.outputs.length > 0) {
                    const firstOutput = result.outputs[0];
                    imageUrl = firstOutput?.image_url || firstOutput?.url || firstOutput?.object_url || firstOutput?.output;
                } else if (result?.images && Array.isArray(result.images) && result.images.length > 0) {
                    imageUrl = result.images[0];
                } else if (result?.image_url) {
                    imageUrl = result.image_url;
                } else if (result?.url) {
                    imageUrl = result.url;
                }
            }
            if (!imageUrl) {
                this.addLog('error', '无法从API响应中提取图像URL');
                this.addLog('info', `完整响应: ${JSON.stringify(result)}`);
                throw new Error('无法从API响应中获取图像URL');
            }
            return { ...result, imageUrl };
        } catch (error) {
            this.closeWebSocket();
            if (error instanceof Error && error.name === 'AbortError') {
                this.addLog('error', 'API 调用被用户取消');
                throw error;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.addLog('error', `API 调用失败: ${errorMessage}`);
            throw error;
        }
    }
}

/**
 * Photoshop 工具类 - 用于图像导入
 */
class PhotoshopUtils {
    constructor(addLog) {
        this.addLog = addLog;
    }

    async exportCanvasOrSelection() {
        try {
            const { app, core, action } = require('photoshop');
            if (!app.activeDocument) throw new Error('没有活动的文档，请先打开或创建一个文档');
            const doc = app.activeDocument;
            this.addLog('info', `正在导出文档: ${doc.name}`);
            const uxp = require('uxp');
            const fs = uxp.storage.localFileSystem;
            const temp = await fs.getTemporaryFolder();
            const timestamp = Date.now();
            const randomStr = Math.random().toString(36).substring(2, 11);
            const filename = `ps-export-${timestamp}-${randomStr}.jpg`;
            const tempFile = await temp.createFile(filename, { overwrite: true });
            await core.executeAsModal(async () => {
                const selection = doc.selection;
                const hasSelection = selection && selection.bounds && (selection.bounds.right - selection.bounds.left > 0) && (selection.bounds.bottom - selection.bounds.top > 0);
                if (hasSelection) {
                    const bounds = selection.bounds;
                    const width = bounds.right - bounds.left;
                    const height = bounds.bottom - bounds.top;
                    this.addLog('info', `检测到选区，尺寸: ${width}x${height}`);
                    const duplicatedDoc = await doc.duplicate();
                    try {
                        await duplicatedDoc.crop({ left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom });
                        this.addLog('info', '文档已裁剪到选区范围');
                        await duplicatedDoc.saveAs.jpg(tempFile, { quality: 90 }, true);
                        this.addLog('info', '选区图像已导出');
                    } finally {
                        await duplicatedDoc.closeWithoutSaving();
                    }
                } else {
                    this.addLog('info', '未检测到有效选区，将导出整个文档');
                    await doc.saveAs.jpg(tempFile, { quality: 90 }, true);
                    this.addLog('info', '文档图像已导出');
                }
            }, { commandName: '导出画布或选区' });
            this.addLog('success', `图像已导出到临时文件: ${filename}`);
            return { file: tempFile, filename };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.addLog('error', `导出失败: ${errorMessage}`);
            throw error;
        }
    }

    extractImageUrls(apiResponse) {
        const imageUrls = [];
        if (apiResponse?.data && Array.isArray(apiResponse.data) && apiResponse.data.length > 0) {
            apiResponse.data.forEach((item) => {
                if (item.type === 'image' && item.url) imageUrls.push(item.url);
            });
        }
        if (imageUrls.length === 0) {
            if (apiResponse?.imageUrl) {
                imageUrls.push(apiResponse.imageUrl);
            } else if (apiResponse?.outputs && Array.isArray(apiResponse.outputs) && apiResponse.outputs.length > 0) {
                apiResponse.outputs.forEach((output) => {
                    const url = output?.image_url || output?.url || output?.object_url || output?.output;
                    if (url) imageUrls.push(url);
                });
            } else if (apiResponse?.images && Array.isArray(apiResponse.images) && apiResponse.images.length > 0) {
                imageUrls.push(...apiResponse.images);
            } else if (apiResponse?.image_url) {
                imageUrls.push(apiResponse.image_url);
            } else if (apiResponse?.url) {
                imageUrls.push(apiResponse.url);
            } else if (apiResponse?.output) {
                imageUrls.push(apiResponse.output);
            } else if (apiResponse?.result?.output_images) {
                if (Array.isArray(apiResponse.result.output_images)) {
                    imageUrls.push(...apiResponse.result.output_images);
                } else if (apiResponse.result.output_images[0]) {
                    imageUrls.push(apiResponse.result.output_images[0]);
                }
            }
        }
        return imageUrls;
    }

    async downloadImageFile(imageUrl, index) {
        const uxp = require('uxp');
        const fs = uxp.storage.localFileSystem;
        const temp = await fs.getTemporaryFolder();
        this.addLog('info', `开始下载图像 ${index + 1}: ${imageUrl.substring(0, 100)}...`);
        let fileExtension = '.png';
        try {
            if (imageUrl.startsWith('http')) {
                const urlPath = new URL(imageUrl).pathname;
                const urlExtension = urlPath.match(/\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i)?.[1];
                if (urlExtension) fileExtension = '.' + urlExtension.toLowerCase();
            } else if (imageUrl.startsWith('data:image/')) {
                const mimeMatch = imageUrl.match(/^data:image\/([^;,]+)/);
                if (mimeMatch) {
                    const mimeType = mimeMatch[1].toLowerCase();
                    fileExtension = mimeType === 'jpeg' ? '.jpg' : `.${mimeType}`;
                }
            }
        } catch (e) {
            this.addLog('warning', `解析文件扩展名失败，使用默认扩展名: ${fileExtension}`);
        }
        if (imageUrl.startsWith('data:image/')) {
            const base64 = imageUrl.split(',')[1];
            const binary = atob(base64);
            const array = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
            const fileName = `autodl-result-${Date.now()}-${index}-${Math.random().toString(36).substring(2, 11)}${fileExtension}`;
            const file = await temp.createFile(fileName, { overwrite: true });
            await file.write(array.buffer, { format: uxp.storage.formats.binary });
            this.addLog('success', `图像 ${index + 1} (data URI) 已保存: ${fileName}`);
            return file;
        }
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error(`下载图像 ${index + 1} 失败: ${res.status} ${res.statusText}`);
        const arrayBuffer = await res.arrayBuffer();
        const fileName = `autodl-result-${Date.now()}-${index}-${Math.random().toString(36).substring(2, 11)}${fileExtension}`;
        const file = await temp.createFile(fileName, { overwrite: true });
        await file.write(arrayBuffer, { format: uxp.storage.formats.binary });
        this.addLog('success', `图像 ${index + 1} 已下载并保存: ${fileName}`);
        return file;
    }

    async getResultImageFile(apiResponse) {
        const imageUrls = this.extractImageUrls(apiResponse);
        if (imageUrls.length === 0) {
            this.addLog('error', '无法从API响应中提取图像URL');
            this.addLog('info', `API响应结构: ${JSON.stringify(apiResponse).substring(0, 500)}`);
            throw new Error('无法从API响应中获取图像URL');
        }
        this.addLog('info', `找到 ${imageUrls.length} 张图像，开始下载...`);
        const imageFiles = await Promise.all(imageUrls.map((url, index) => this.downloadImageFile(url, index)));
        if (imageFiles.length === 1) return imageFiles[0];
        return imageFiles;
    }

    async importResultToDocument(resultFile, createNewDoc = false) {
        this.addLog('info', '开始导入图像到文档...');
        this.addLog('info', `导入模式: ${createNewDoc ? '新文档' : '当前文档'}`);
        const { core, app, action } = require('photoshop');
        const commandName = createNewDoc ? '' : 'Import Result Image';
        await core.executeAsModal(async (executionContext) => {
            const hostControl = executionContext.hostControl;
            try {
                if (createNewDoc) {
                    this.addLog('info', '在新文档中打开图像...');
                    const fs = require('uxp').storage.localFileSystem;
                    const token = await fs.createSessionToken(resultFile);
                    await action.batchPlay([{ _obj: 'open', null: { _path: token, _kind: 'local' }, _options: { dialogOptions: 'dontDisplay' } }], { synchronousExecution: true, modalBehavior: 'execute' });
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const resultDoc = app.activeDocument;
                    if (resultDoc) {
                        this.addLog('success', `图像已在新文档中打开: ${resultDoc.name}`);
                    } else {
                        const resultDoc = await app.open(resultFile);
                        this.addLog('success', `图像已在新文档中打开（降级方案）: ${resultDoc.name}`);
                    }
                } else {
                    const currentDoc = app.activeDocument;
                    if (!currentDoc) throw new Error('没有活动的文档');
                    this.addLog('info', '正在将图像置入当前文档...');
                    try {
                        const fs = require('uxp').storage.localFileSystem;
                        const token = await fs.createSessionToken(resultFile);
                        if (currentDoc.placeFile) {
                            await currentDoc.placeFile(token);
                            this.addLog('info', '使用 placeFile API 置入图像');
                        } else {
                            await action.batchPlay([{ _obj: 'placeEvent', null: { _path: token, _kind: 'local' } }], { synchronousExecution: true, modalBehavior: 'execute' });
                            this.addLog('info', '使用 batchPlay 置入图像');
                        }
                        await action.batchPlay([{ _obj: 'placedLayerApply' }], { synchronousExecution: true, modalBehavior: 'execute' });
                        const newLayer = currentDoc.activeLayers[0];
                        if (newLayer) {
                            newLayer.name = 'AutoDL Generated';
                            this.addLog('success', '图像已成功导入到当前文档');
                        }
                    } catch (placeError) {
                        this.addLog('error', `置入图像失败: ${placeError.message}`);
                        throw placeError;
                    }
                }
            } catch (error) {
                this.addLog('error', `导入图像失败: ${error.message}`);
                hostControl.unwindHistory();
                throw error;
            }
        }, commandName ? { commandName } : {});
    }
}

// 应用主代码
// 常量定义
const DEFAULT_PROMPT = '超广角动感运营插画，3d插画风格海报，创意字体设计，将字体进行抽象变形，创造出扁平化节奏动感，大标题中文字"镜像问题，训练问题"，小标题中文字"555"，一张皮克斯3D动画风格设计工作室的可爱海报，上面有一个的年轻女孩坐在画板前，在画板上画小猫';

// 应用状态
let state = {
    text: '',
    batchSize: 1,
    apiEndpoint: '',
    apiType: '07Nunchaku-Qwenimage',
    isGenerating: false,
    zImageWidth: 1280,
    zImageHeight: 720,
    zImageSeed: 453236349928716,
    logs: [],
    status: '',
    statusType: 'processing',
    openInNewDoc: false,
    activeTab: 'main',
    workflowProgress: 0,
    nodeProgress: 0,
    currentNode: '准备中...',
    showProgress: false
};

let abortControllerRef = null;
let apiRef = null;
let psUtilsRef = null;

// 初始化
function init() {
    // 从localStorage加载保存的配置
    try {
        const savedEndpoint = localStorage.getItem('autodl_api_endpoint');
        if (savedEndpoint) {
            state.apiEndpoint = savedEndpoint;
        }
        const savedApiType = localStorage.getItem('autodl_api_type');
        if (savedApiType && (savedApiType === '07Nunchaku-Qwenimage' || savedApiType === 'qwenbg' || savedApiType === 'Z-Image')) {
            state.apiType = savedApiType;
        }
    } catch (e) {
        // localStorage可能不可用，忽略
    }

    // 初始化默认提示词
    if (!state.text) {
        state.text = DEFAULT_PROMPT;
    }

    // 初始化 API 和 Photoshop 工具实例
    initAPI();
    initPhotoshopUtils();

    // 渲染界面
    render();
}

// 初始化 API 实例
function initAPI() {
    apiRef = new AutoDLAPI(
        state.apiEndpoint,
        state.apiType,
        (type, message) => addLog(type, message),
        (workflowPercent, nodePercent, nodeName) => {
            if (workflowPercent !== null) {
                state.workflowProgress = workflowPercent;
                render();
            }
            if (nodePercent !== null) {
                state.nodeProgress = nodePercent;
                render();
            }
            if (nodeName !== null) {
                state.currentNode = nodeName;
                render();
            }
        }
    );
}

// 初始化 Photoshop 工具实例
function initPhotoshopUtils() {
    if (!psUtilsRef) {
        psUtilsRef = new PhotoshopUtils((type, message) => {
            addLog(type, message);
        });
    }
}

// 添加日志
function addLog(type, message) {
    state.logs.push({
        type: type,
        message: message,
        timestamp: new Date()
    });
    render();
}

// 清空日志
function clearLogs() {
    state.logs = [];
    render();
}

// 复制日志
async function copyLogs() {
    if (state.logs.length === 0) {
        addLog('info', '没有日志可复制');
        return;
    }

    const logText = state.logs.map(log => {
        const timeStr = log.timestamp.toLocaleTimeString();
        const typeStr = log.type === 'error' ? '[错误]' : log.type === 'success' ? '[成功]' : '[信息]';
        return `${timeStr} ${typeStr} ${log.message}`;
    }).join('\n');

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(logText);
            addLog('success', '日志已复制到剪贴板');
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = logText;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            textarea.setSelectionRange(0, 99999);
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textarea);
            
            if (successful) {
                addLog('success', '日志已复制到剪贴板（备用方法）');
            } else {
                throw new Error('复制命令执行失败');
            }
        }
    } catch (error) {
        console.error('复制日志失败:', error);
        addLog('error', `复制日志失败: ${error.message}`);
    }
}

// 生成图像
async function handleGenerate() {
    // 检查 API 端点是否已设置
    if (!state.apiEndpoint || !state.apiEndpoint.trim()) {
        addLog('error', '请先在"设置"页面配置 API 服务器地址');
        setActiveTab('settings');
        return;
    }

    // 对于需要提示词的API，需要检查提示词
    if ((state.apiType === '07Nunchaku-Qwenimage' || state.apiType === 'Z-Image') && !state.text.trim()) {
        addLog('error', '请输入提示词');
        return;
    }

    state.isGenerating = true;
    state.status = '正在生成...';
    state.statusType = 'processing';
    state.showProgress = true;
    state.workflowProgress = 0;
    state.nodeProgress = 0;
    state.currentNode = '准备执行...';
    addLog('info', '开始调用 AutoDL API...');

    // 创建新的 AbortController
    abortControllerRef = new AbortController();

    try {
        const result = await apiRef.generate(
            state.text,
            state.batchSize,
            abortControllerRef.signal,
            psUtilsRef,
            {
                width: state.zImageWidth,
                height: state.zImageHeight,
                seed: state.zImageSeed
            }
        );

        addLog('success', 'API调用成功，开始处理图像...');
        addLog('info', `API响应: ${JSON.stringify(result).substring(0, 300)}...`);

        // 下载图像文件（可能是单个文件或文件数组）
        const resultFiles = await psUtilsRef.getResultImageFile(result);
        const files = Array.isArray(resultFiles) ? resultFiles : [resultFiles];
        addLog('success', `图像下载完成，共 ${files.length} 张`);

        // 导入图像到Photoshop
        try {
            const { app } = require('photoshop');
            const hasActiveDoc = app.activeDocument !== null;
            
            // 导入所有图片
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                addLog('info', `正在导入第 ${i + 1}/${files.length} 张图像...`);
                
                try {
                    let shouldCreateNewDoc = false;
                    if (state.openInNewDoc) {
                        shouldCreateNewDoc = true;
                    } else if (!hasActiveDoc && i === 0) {
                        shouldCreateNewDoc = true;
                    }
                    
                    await psUtilsRef.importResultToDocument(file, shouldCreateNewDoc);
                    if (shouldCreateNewDoc) {
                        addLog('success', `第 ${i + 1} 张图像已在新文档中打开`);
                    } else {
                        addLog('success', `第 ${i + 1} 张图像已成功导入到当前文档`);
                    }
                } catch (importError) {
                    addLog('info', `导入第 ${i + 1} 张图像失败，尝试在新文档中打开: ${importError.message}`);
                    await psUtilsRef.importResultToDocument(file, true);
                    addLog('success', `第 ${i + 1} 张图像已在新文档中打开`);
                }
            }
            
            if (state.openInNewDoc) {
                addLog('success', `所有 ${files.length} 张图像已在新文档中打开`);
            } else {
                addLog('success', `所有 ${files.length} 张图像已成功导入到Photoshop`);
            }
        } catch (error) {
            addLog('error', `导入图像时发生错误: ${error.message}`);
            throw error;
        }

        state.status = '生成成功！';
        state.statusType = 'success';
        state.workflowProgress = 100;
        state.nodeProgress = 100;
        state.currentNode = '执行完成';
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            state.status = '已取消';
            state.statusType = 'error';
            addLog('info', '用户取消了操作');
        } else {
            state.status = '生成失败';
            state.statusType = 'error';
            const errorMessage = error instanceof Error ? error.message : String(error);
            addLog('error', `生成失败: ${errorMessage}`);
        }
    } finally {
        state.isGenerating = false;
        abortControllerRef = null;
        setTimeout(() => {
            state.showProgress = false;
            render();
        }, 2000);
    }
    render();
}

// 取消生成
function handleCancel() {
    if (abortControllerRef) {
        abortControllerRef.abort();
        addLog('info', '正在取消请求...');
        state.showProgress = false;
        render();
    }
}

// 保存配置
function saveSettings() {
    try {
        localStorage.setItem('autodl_api_endpoint', state.apiEndpoint);
        localStorage.setItem('autodl_api_type', state.apiType);
        addLog('success', '配置已保存');
        state.status = '配置已保存';
        state.statusType = 'success';
        setTimeout(() => {
            state.status = '';
            render();
        }, 2000);
        initAPI(); // 重新初始化 API
    } catch (e) {
        addLog('error', '保存配置失败');
        state.status = '保存失败';
        state.statusType = 'error';
    }
    render();
}

// 切换标签页
function setActiveTab(tab) {
    state.activeTab = tab;
    render();
}

// 渲染界面
function render() {
    const root = document.getElementById('root');
    if (!root) return;

    root.innerHTML = `
        <div class="app app-container">
            <!-- TAB 导航 -->
            <div class="sp-tabs">
                <div class="sp-tab ${state.activeTab === 'main' ? 'selected' : ''}" data-tab="main">
                    <span class="tab-text ${state.activeTab === 'main' ? 'active' : 'inactive'}">生成</span>
                </div>
                <div class="sp-tab ${state.activeTab === 'logs' ? 'selected' : ''}" data-tab="logs">
                    <span class="tab-text ${state.activeTab === 'logs' ? 'active' : 'inactive'}">日志</span>
                </div>
                <div class="sp-tab ${state.activeTab === 'settings' ? 'selected' : ''}" data-tab="settings">
                    <span class="tab-text ${state.activeTab === 'settings' ? 'active' : 'inactive'}">设置</span>
                </div>
            </div>

            <!-- 主页面 TAB -->
            ${state.activeTab === 'main' ? renderMainTab() : ''}

            <!-- 日志页面 TAB -->
            ${state.activeTab === 'logs' ? renderLogsTab() : ''}

            <!-- 设置页面 TAB -->
            ${state.activeTab === 'settings' ? renderSettingsTab() : ''}
        </div>
    `;

    // 绑定TAB点击事件
    const tabs = root.querySelectorAll('.sp-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            if (tabName) {
                setActiveTab(tabName);
            }
        });
    });

    // 绑定按钮点击事件
    const actionButtons = root.querySelectorAll('[data-action]');
    actionButtons.forEach(button => {
        button.addEventListener('click', function() {
            const action = this.getAttribute('data-action');
            if (action === 'generate') {
                handleGenerate();
            } else if (action === 'cancel') {
                handleCancel();
            } else if (action === 'clearLogs') {
                clearLogs();
            } else if (action === 'copyLogs') {
                copyLogs();
            } else if (action === 'saveSettings') {
                saveSettings();
            }
        });
    });
}

// 渲染主页面
function renderMainTab() {
    return `
        <div class="sp-tab-page visible tab-page">
            <div class="container">
                <h2 class="page-title">AutoDL PS</h2>
                
                <div class="form-group">
                    <label>当前 API 服务器</label>
                    <div class="info-box">
                        ${state.apiEndpoint || '未设置'}
                    </div>
                    <div class="help-text">
                        在"设置"页面可以修改 API 服务器配置
                    </div>
                </div>

                <div class="form-group">
                    <label for="api-type-select">API 类型</label>
                    <select id="api-type-select" ${state.isGenerating ? 'disabled' : ''} onchange="state.apiType = this.value; render();">
                        <option value="07Nunchaku-Qwenimage" ${state.apiType === '07Nunchaku-Qwenimage' ? 'selected' : ''}>07Nunchaku-Qwenimage</option>
                        <option value="qwenbg" ${state.apiType === 'qwenbg' ? 'selected' : ''}>qwenbg</option>
                        <option value="Z-Image" ${state.apiType === 'Z-Image' ? 'selected' : ''}>Z-Image</option>
                    </select>
                </div>

                ${state.apiType === '07Nunchaku-Qwenimage' ? renderQwenImageFields() : ''}
                ${state.apiType === 'qwenbg' ? renderQwenbgFields() : ''}
                ${state.apiType === 'Z-Image' ? renderZImageFields() : ''}

                <div class="form-group">
                    <label class="checkbox-label ${state.isGenerating ? 'disabled' : ''}">
                        <input type="checkbox" ${state.openInNewDoc ? 'checked' : ''} ${state.isGenerating ? 'disabled' : ''} onchange="state.openInNewDoc = this.checked; render();">
                        <span>在新文档打开</span>
                    </label>
                </div>

                <div class="button-group">
                    <button data-action="generate" ${state.isGenerating || ((state.apiType === '07Nunchaku-Qwenimage' || state.apiType === 'Z-Image') && !state.text.trim()) ? 'disabled' : ''} class="button-primary">
                        ${state.isGenerating ? '生成中...' : '生成'}
                    </button>
                    ${state.isGenerating ? `<button data-action="cancel" class="button-danger">取消</button>` : ''}
                </div>

                ${state.showProgress ? renderProgressPanel() : ''}
                ${state.status && !state.showProgress ? `<div class="status ${state.statusType} status-message">${state.status}</div>` : ''}
            </div>
        </div>
    `;
}

// 渲染 QwenImage 字段
function renderQwenImageFields() {
    return `
        <div class="form-group">
            <label for="text-input">提示词 (6:text)</label>
            <textarea id="text-input" ${state.isGenerating ? 'disabled' : ''} onchange="state.text = this.value; render();" placeholder="输入提示词，例如：超广角动感运营插画，3d插画风格海报...">${state.text}</textarea>
        </div>
        <div class="form-group">
            <label for="batch-size-input">批次大小 (58:batch_size)</label>
            <input id="batch-size-input" type="number" min="1" max="10" value="${state.batchSize}" ${state.isGenerating ? 'disabled' : ''} onchange="state.batchSize = parseInt(this.value) || 1; render();">
        </div>
    `;
}

// 渲染 Qwenbg 字段
function renderQwenbgFields() {
    return `
        <div class="form-group">
            <label>说明</label>
            <div class="info-box-secondary">
                qwenbg API 将使用当前 Photoshop 文档的画布或选区（如有）作为输入图像。
            </div>
        </div>
    `;
}

// 渲染 Z-Image 字段
function renderZImageFields() {
    return `
        <div class="form-group">
            <label for="z-image-text-input">提示词 (544:text)</label>
            <textarea id="z-image-text-input" ${state.isGenerating ? 'disabled' : ''} onchange="state.text = this.value; render();" placeholder="输入提示词，例如：镜中自拍的少女，双马尾垂落肩头...">${state.text}</textarea>
        </div>
        <div class="form-row">
            <div class="form-group form-group-inline">
                <label for="z-image-width-input">宽度 (376:value)</label>
                <input id="z-image-width-input" type="number" min="1" max="4096" value="${state.zImageWidth}" ${state.isGenerating ? 'disabled' : ''} onchange="state.zImageWidth = parseInt(this.value) || 1280; render();">
            </div>
            <div class="form-group form-group-inline">
                <label for="z-image-height-input">高度 (377:value)</label>
                <input id="z-image-height-input" type="number" min="1" max="4096" value="${state.zImageHeight}" ${state.isGenerating ? 'disabled' : ''} onchange="state.zImageHeight = parseInt(this.value) || 720; render();">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-inline">
                <label for="z-image-batch-size-input">批次大小 (216:batch_size)</label>
                <input id="z-image-batch-size-input" type="number" min="1" max="10" value="${state.batchSize}" ${state.isGenerating ? 'disabled' : ''} onchange="state.batchSize = parseInt(this.value) || 1; render();">
            </div>
            <div class="form-group form-group-inline">
                <label for="z-image-seed-input">随机种子 (141:seed)</label>
                <input id="z-image-seed-input" type="number" value="${state.zImageSeed}" ${state.isGenerating ? 'disabled' : ''} onchange="state.zImageSeed = parseInt(this.value) || 453236349928716; render();">
            </div>
        </div>
    `;
}

// 渲染进度面板
function renderProgressPanel() {
    return `
        <div class="progress-panel">
            <div class="progress-label">
                <span>整体渲染进度</span>
                <span>${state.workflowProgress}%</span>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill workflow" style="width: ${state.workflowProgress}%;"></div>
            </div>
            <div class="progress-label">
                <span>${state.currentNode}</span>
                <span>${state.nodeProgress}%</span>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill node" style="width: ${state.nodeProgress}%;"></div>
            </div>
        </div>
    `;
}

// 渲染日志页面
function renderLogsTab() {
    return `
        <div class="sp-tab-page visible logs-page-simple">
            <div class="log-content-area">
                ${state.logs.length === 0 ? '<div class="log-entry log-empty">暂无日志</div>' : state.logs.map(log => `
                    <div class="log-entry ${log.type}">
                        <span class="log-timestamp">[${log.timestamp.toLocaleTimeString()}]</span>
                        <span class="log-type-label"> [${log.type === 'error' ? '错误' : log.type === 'success' ? '成功' : '信息'}]</span>
                        ${log.message}
                    </div>
                `).join('')}
            </div>
            <div class="log-buttons-bottom">
                <button data-action="clearLogs" ${state.logs.length === 0 ? 'disabled' : ''} class="button-log button-log-secondary">
                    清空
                </button>
                <button data-action="copyLogs" ${state.logs.length === 0 ? 'disabled' : ''} class="button-log button-log-primary">
                    复制
                </button>
            </div>
        </div>
    `;
}

// 渲染设置页面
function renderSettingsTab() {
    return `
        <div class="sp-tab-page visible tab-page">
            <div class="container">
                <h2 class="page-title-large">API 服务器配置</h2>
                
                <div class="form-group">
                    <label for="settings-api-endpoint-input">API 服务器地址</label>
                    <input id="settings-api-endpoint-input" type="text" value="${state.apiEndpoint}" onchange="state.apiEndpoint = this.value; render();" placeholder="https://your-server.com:8443">
                    <div class="help-text-medium">
                        此配置将应用于所有 API 类型。修改后请点击"保存"按钮保存配置。
                    </div>
                </div>

                <div class="form-group">
                    <label for="settings-api-type-select">默认 API 类型</label>
                    <select id="settings-api-type-select" value="${state.apiType}" onchange="state.apiType = this.value; render();">
                        <option value="07Nunchaku-Qwenimage" ${state.apiType === '07Nunchaku-Qwenimage' ? 'selected' : ''}>07Nunchaku-Qwenimage</option>
                        <option value="qwenbg" ${state.apiType === 'qwenbg' ? 'selected' : ''}>qwenbg</option>
                        <option value="Z-Image" ${state.apiType === 'Z-Image' ? 'selected' : ''}>Z-Image</option>
                    </select>
                    <div class="help-text-medium">
                        选择默认使用的 API 类型。
                    </div>
                </div>

                <div class="info-box-large">
                    <div class="info-box-title">说明：</div>
                    <div class="info-box-item">• API 服务器地址是所有 API 类型共用的配置</div>
                    <div class="info-box-item">• 配置保存后，下次打开插件会自动加载</div>
                    <div class="info-box-item">• 当前保存的地址：<span class="info-box-highlight">${state.apiEndpoint || '未设置'}</span></div>
                </div>

                <div class="button-group-bottom">
                    <button data-action="saveSettings">
                        保存配置
                    </button>
                </div>

                ${state.status && state.activeTab === 'settings' ? `<div class="status ${state.statusType} status-message-large">${state.status}</div>` : ''}
            </div>
        </div>
    `;
}

// UXP 入口点设置
try {
    const { entrypoints } = require('uxp');
    let panelRoot = null;
    let attachment = null;

    entrypoints.setup({
        panels: {
            'autodl-panel': {
                create() {
                    panelRoot = document.createElement('div');
                    panelRoot.style.height = '100vh';
                    panelRoot.style.overflow = 'hidden';

                    const rootDiv = document.createElement('div');
                    rootDiv.id = 'root';
                    rootDiv.style.height = '100%';
                    panelRoot.appendChild(rootDiv);

                    if (!window.__autodlMounted) {
                        init();
                        window.__autodlMounted = true;
                    }
                },
                show({ node }) {
                    if (!panelRoot) {
                        this.create();
                    }
                    attachment = node;
                    if (attachment && panelRoot && !panelRoot.parentElement) {
                        attachment.appendChild(panelRoot);
                    }
                },
                hide() {
                    if (attachment && panelRoot && panelRoot.parentElement === attachment) {
                        attachment.removeChild(panelRoot);
                    }
                    attachment = null;
                },
                destroy() {
                    panelRoot = null;
                    attachment = null;
                }
            }
        }
    });
} catch (e) {
    // 非 UXP 环境或直接打开时的回退
    const container = document.getElementById('root') || (() => {
        const d = document.createElement('div');
        d.id = 'root';
        d.style.height = '100vh';
        document.body.appendChild(d);
        return d;
    })();
    if (!window.__autodlMounted) {
        init();
        window.__autodlMounted = true;
    }
}
