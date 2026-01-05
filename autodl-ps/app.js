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

    async generate(text, batchSize = 1, signal, psUtils, customApiConfig = null, customApiValues = {}) {
        try {
            let payload;
            if (customApiConfig) {
                // 自定义API处理
                const inputValues = {};
                
                // 处理每个输入字段
                if (customApiConfig.input_fields && customApiConfig.input_fields.length > 0) {
                    for (const field of customApiConfig.input_fields) {
                        if (field.type === 'image') {
                            // 图像上传字段
                            if (!psUtils) throw new Error(`${field.label || field.key} 需要Photoshop工具实例`);
                            const { file, filename } = await this.exportPhotoshopImage(psUtils);
                            const uploadedFilename = await this.uploadImage(file, filename, signal);
                            inputValues[field.key] = uploadedFilename;
                        } else if (field.type === 'string' || field.type === 'text') {
                            // 文本字段
                            const value = customApiValues[field.key] || '';
                            if (value) {
                                inputValues[field.key] = String(value);
                            }
                        } else if (field.type === 'seed') {
                            // 随机种子字段（默认8位），支持大数字
                            let value = customApiValues[field.key] !== undefined ? customApiValues[field.key] : Math.floor(Math.random() * 100000000);
                            // 如果是字符串（大数字），直接使用；否则转换为整数
                            if (typeof value === 'string') {
                                // 大数字作为字符串传递
                                inputValues[field.key] = value;
                            } else {
                                // 普通数字转换为整数
                                const numValue = parseInt(value) || Math.floor(Math.random() * 100000000);
                                // 如果数字太大，使用字符串
                                if (numValue > Number.MAX_SAFE_INTEGER) {
                                    inputValues[field.key] = String(numValue);
                                } else {
                                    inputValues[field.key] = numValue;
                                }
                            }
                        } else if (field.type === 'value' || field.type === 'width' || field.type === 'batch_size') {
                            // 数值字段
                            const value = customApiValues[field.key] !== undefined ? customApiValues[field.key] : field.default_value;
                            if (value !== undefined && value !== null && value !== '') {
                                inputValues[field.key] = parseInt(value) || 0;
                            }
                        }
                    }
                }
                
                payload = {
                    workflow_id: customApiConfig.workflow_id,
                    input_values: inputValues,
                    client_id: this.clientId
                };
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
const DEFAULT_PROMPT = '超广角动感运营插画，3d插画风格海报，创意字体设计，将字体进行抽象变形，创造出扁平化节奏动感，大标题中文字"zealman镜像牛X"，小标题中文字"用了都说好"，一张皮克斯3D动画风格设计工作室的可爱海报，上面有一个的年轻女孩坐在画板前，在画板上画小猫';

// 应用状态
let state = {
    text: '',
    batchSize: 1,
    apiEndpoint: '',
    apiType: '07Nunchaku-Qwenimage', // 当前使用的API类型（生成页面使用）
    defaultApiType: '07Nunchaku-Qwenimage', // 默认API类型（保存在设置中）
    customApis: [], // 自定义API配置列表 [{id, name, workflow_id, input_fields: [{key, type, label}]}]
    isGenerating: false,
    logs: [],
    status: '',
    statusType: 'processing',
    openInNewDoc: false,
    activeTab: 'main',
    workflowProgress: 0,
    nodeProgress: 0,
    currentNode: '准备中...',
    showProgress: false,
    apiServerStatus: 'unknown', // 'online', 'offline', 'checking', 'unknown'
    comfyuiStatus: 'unknown', // 'online', 'offline', 'checking', 'unknown'
    isCheckingStatus: false, // 是否正在检查状态，避免重复检查
    editingCustomApi: null, // 正在编辑的自定义API ID
    customApiValues: {} // 自定义API的输入值 {[apiId]: {[fieldKey]: value}}
};

let abortControllerRef = null;
let apiRef = null;
let psUtilsRef = null;

// 初始化
async function init() {
    console.log('初始化开始，当前 state:', { apiEndpoint: state.apiEndpoint, apiType: state.apiType });
    
    // 从 JSON 文件加载保存的配置
    try {
        const loaded = await loadSettingsFromFile();
        if (loaded) {
            console.log('配置已从 JSON 文件加载，当前 state:', { apiEndpoint: state.apiEndpoint, apiType: state.apiType });
        } else {
            console.log('未找到配置文件，使用默认配置');
        }
    } catch (e) {
        console.error('从文件系统加载配置失败:', e);
        console.error('加载失败时的 state:', { apiEndpoint: state.apiEndpoint, apiType: state.apiType });
    }

    // 初始化默认提示词
    if (!state.text) {
        state.text = DEFAULT_PROMPT;
    }

    // 确保当前使用的API类型与默认值一致（如果之前没有加载配置）
    if (!state.defaultApiType) {
        state.defaultApiType = state.apiType || '07Nunchaku-Qwenimage';
    }
    // 如果默认API类型是已删除的 qwenbg，重置为默认值
    if (state.defaultApiType === 'qwenbg') {
        state.defaultApiType = '07Nunchaku-Qwenimage';
    }
    // 如果当前API类型是已删除的 qwenbg，重置为默认值
    if (state.apiType === 'qwenbg') {
        state.apiType = state.defaultApiType || '07Nunchaku-Qwenimage';
    }
    // 初始化时，当前使用的API类型应该等于默认值
    state.apiType = state.defaultApiType;

    console.log('初始化完成，最终 state:', { apiEndpoint: state.apiEndpoint, defaultApiType: state.defaultApiType, apiType: state.apiType });

    // 初始化 API 和 Photoshop 工具实例
    initAPI();
    initPhotoshopUtils();

    // 检查 API 服务器状态
    if (state.apiEndpoint && state.apiEndpoint.trim()) {
        checkApiServerStatus();
    }

    // 渲染界面
    render();
}

// 更新进度条（只更新进度条部分，不重新渲染整个页面）
let progressUpdateTimer = null;
function updateProgressOnly() {
    // 使用节流，避免过于频繁的更新
    if (progressUpdateTimer) {
        return;
    }
    
    progressUpdateTimer = setTimeout(() => {
        progressUpdateTimer = null;
        
        const progressPanel = document.querySelector('.progress-panel');
        if (!progressPanel) {
            // 如果进度面板不存在，需要完整渲染
            render();
            return;
        }
        
        // 查找进度条相关的 DOM 元素
        const progressLabels = progressPanel.querySelectorAll('.progress-label');
        const progressBars = progressPanel.querySelectorAll('.progress-bar-fill');
        
        // 更新整体进度（第一个进度标签和进度条）
        if (progressLabels.length > 0) {
            const workflowLabel = progressLabels[0];
            const workflowSpans = workflowLabel.querySelectorAll('span');
            if (workflowSpans.length >= 2) {
                workflowSpans[1].textContent = `${state.workflowProgress}%`;
            }
        }
        if (progressBars.length > 0) {
            const workflowBar = progressBars[0];
            if (workflowBar.classList.contains('workflow')) {
                workflowBar.style.width = `${state.workflowProgress}%`;
            }
        }
        
        // 更新节点进度（第二个进度标签和进度条）
        if (progressLabels.length > 1) {
            const nodeLabel = progressLabels[1];
            const nodeSpans = nodeLabel.querySelectorAll('span');
            if (nodeSpans.length >= 2) {
                if (state.currentNode) {
                    nodeSpans[0].textContent = state.currentNode;
                }
                nodeSpans[1].textContent = `${state.nodeProgress}%`;
            }
        }
        if (progressBars.length > 1) {
            const nodeBar = progressBars[1];
            if (nodeBar.classList.contains('node')) {
                nodeBar.style.width = `${state.nodeProgress}%`;
            }
        }
    }, 50); // 每50ms最多更新一次
}

// 初始化 API 实例
function initAPI() {
    apiRef = new AutoDLAPI(
        state.apiEndpoint,
        state.apiType,
        (type, message) => addLog(type, message),
        (workflowPercent, nodePercent, nodeName) => {
            // 更新状态
            if (workflowPercent !== null) {
                state.workflowProgress = workflowPercent;
            }
            if (nodePercent !== null) {
                state.nodeProgress = nodePercent;
            }
            if (nodeName !== null) {
                state.currentNode = nodeName;
            }
            
            // 如果进度面板正在显示，尝试只更新进度条
            if (state.showProgress) {
                const progressPanel = document.querySelector('.progress-panel');
                // 如果进度面板已存在，只更新进度条；否则需要完整渲染
                if (progressPanel) {
                    updateProgressOnly();
                } else {
                    // 进度面板不存在，需要完整渲染来创建它
                    render();
                }
            } else {
                // 进度面板未显示，需要完整渲染
                render();
            }
        }
    );
}

// 检查 ComfyUI 状态
async function checkComfyUIStatus(skipRender = false) {
    if (!state.apiEndpoint || !state.apiEndpoint.trim()) {
        state.comfyuiStatus = 'unknown';
        if (!skipRender) render();
        return;
    }

    state.comfyuiStatus = 'checking';
    if (!skipRender) render();

    try {
        const baseUrl = state.apiEndpoint.replace(/\/$/, '');
        // ComfyUI 的常用检查端点（按优先级排序）
        const endpoints = [
            `${baseUrl}/api/object_info`, // 对象信息（节点信息）- 最可靠的端点
            `${baseUrl}/api/system_stats`, // 系统统计
            `${baseUrl}/api/prompts`, // 提示词列表
            `${baseUrl}/api/queue`, // 队列信息
            `${baseUrl}/api/history` // 历史记录
        ];
        
        let isComfyUIOnline = false;

        // 尝试每个端点，使用独立的超时控制
        for (const endpoint of endpoints) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                const response = await fetch(endpoint, {
                    method: 'GET',
                    signal: controller.signal,
                    headers: {
                        'Accept': 'application/json'
                    }
                });
                
                clearTimeout(timeoutId);
                
                // ComfyUI 的 API 通常返回 JSON，状态码 200 表示成功
                if (response.ok) {
                    const contentType = response.headers.get('content-type') || '';
                    // 如果返回 JSON，说明是 ComfyUI API
                    if (contentType.includes('application/json')) {
                        try {
                            const data = await response.json();
                            // 如果能成功解析 JSON，说明是 ComfyUI API
                            isComfyUIOnline = true;
                            break;
                        } catch (e) {
                            // JSON 解析失败，继续尝试下一个端点
                            continue;
                        }
                    }
                }
            } catch (e) {
                // 如果是 AbortError，说明超时了，继续尝试下一个端点
                if (e.name === 'AbortError') {
                    continue;
                }
                // 网络错误（如 CORS、连接拒绝等）也继续尝试下一个端点
                continue;
            }
        }

        // 如果所有标准端点都失败，尝试访问 ComfyUI 的 WebSocket 端点（通过 HTTP 检查）
        // 这可以帮助检测 ComfyUI 服务器是否存在
        if (!isComfyUIOnline) {
            try {
                const wsCheckUrl = `${baseUrl}/comfyui-ws`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                
                const response = await fetch(wsCheckUrl, {
                    method: 'GET',
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                // WebSocket 端点通常返回 400（Bad Request）或 426（Upgrade Required），这表示服务器存在且是 WebSocket 端点
                // 200 也可能表示服务器响应了请求
                if (response.status === 400 || response.status === 426 || response.status === 200) {
                    isComfyUIOnline = true;
                }
            } catch (e) {
                // WebSocket 检查也失败，保持离线状态
                // 如果错误是网络错误（如连接拒绝），说明服务器可能离线
            }
        }

        state.comfyuiStatus = isComfyUIOnline ? 'online' : 'offline';
    } catch (error) {
        // 任何错误都视为离线
        state.comfyuiStatus = 'offline';
    }
    if (!skipRender) render();
}

// 检查 API 服务器状态
async function checkApiServerStatus(skipInitialRender = false) {
    // 如果正在检查中，跳过重复检查
    if (state.isCheckingStatus) {
        return;
    }

    if (!state.apiEndpoint || !state.apiEndpoint.trim()) {
        state.apiServerStatus = 'unknown';
        state.comfyuiStatus = 'unknown';
        if (!skipInitialRender) render();
        return;
    }

    state.isCheckingStatus = true;
    state.apiServerStatus = 'checking';
    if (!skipInitialRender) render();

    try {
        const baseUrl = state.apiEndpoint.replace(/\/$/, '');
        // 尝试访问 API 的健康检查端点或根路径
        const healthCheckUrl = `${baseUrl}/api/health`;
        const rootUrl = `${baseUrl}/`;
        
        // 使用较短的超时时间（3秒）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        let isOnline = false;

        try {
            // 先尝试健康检查端点
            const response = await fetch(healthCheckUrl, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (response.ok || response.status < 500) {
                isOnline = true;
            }
        } catch (e) {
            clearTimeout(timeoutId);
            // 如果健康检查失败，尝试根路径
            try {
                const rootController = new AbortController();
                const rootTimeoutId = setTimeout(() => rootController.abort(), 3000);
                const rootResponse = await fetch(rootUrl, {
                    method: 'GET',
                    signal: rootController.signal
                });
                clearTimeout(rootTimeoutId);
                
                if (rootResponse.ok || rootResponse.status < 500) {
                    isOnline = true;
                }
            } catch (rootError) {
                // 两个请求都失败，服务器离线
                isOnline = false;
            }
        }

        state.apiServerStatus = isOnline ? 'online' : 'offline';
        
        // 如果 API 服务器在线，检查 ComfyUI 状态（跳过中间渲染，最后统一渲染）
        if (isOnline) {
            await checkComfyUIStatus(true); // 跳过中间渲染
        } else {
            state.comfyuiStatus = 'offline';
        }
    } catch (error) {
        // 任何错误都视为离线
        state.apiServerStatus = 'offline';
        state.comfyuiStatus = 'offline';
    } finally {
        state.isCheckingStatus = false;
    }
    // 只在最终状态确定后渲染一次
    render();
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
        const typeStr = log.type === 'error' ? '[错误]' : log.type === 'success' ? '[成功]' : log.type === 'warning' ? '[警告]' : '[信息]';
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
    if (state.apiType === '07Nunchaku-Qwenimage' && !state.text.trim()) {
        addLog('error', '请输入提示词');
        return;
    }

    // 在生成开始前，从复选框读取当前状态（防止状态不同步）
    const openInNewDocCheckbox = document.getElementById('open-in-new-doc-checkbox');
    if (openInNewDocCheckbox) {
        state.openInNewDoc = openInNewDocCheckbox.checked;
        addLog('info', `"在新文档打开"选项状态: ${state.openInNewDoc ? '已勾选' : '未勾选'}`);
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
        // 检查是否是自定义API
        let customApiConfig = null;
        let customApiValues = {};
        if (state.apiType && state.apiType.startsWith('custom_')) {
            customApiConfig = state.customApis.find(api => api.id === state.apiType);
            if (!customApiConfig) {
                throw new Error(`找不到自定义API配置: ${state.apiType}`);
            }
            // 获取自定义API的输入值
            customApiValues = state.customApiValues[state.apiType] || {};
        }
        
        const result = await apiRef.generate(
            state.text,
            state.batchSize,
            abortControllerRef.signal,
            psUtilsRef,
            customApiConfig,
            customApiValues
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
                    // 如果勾选了"在新文档打开"，每张图都创建新文档
                    // 否则，如果没有活动文档且是第一张图，创建新文档；否则导入到当前文档
                    let shouldCreateNewDoc = false;
                    // 确保使用最新的状态（从state读取）
                    const openInNewDoc = state.openInNewDoc;
                    addLog('info', `当前"在新文档打开"状态: ${openInNewDoc ? '已勾选' : '未勾选'}`);
                    
                    if (openInNewDoc) {
                        // 勾选了新文档打开，每张图都创建新文档
                        shouldCreateNewDoc = true;
                        addLog('info', `已勾选"在新文档打开"，将为第 ${i + 1} 张图像创建新文档`);
                    } else if (!hasActiveDoc && i === 0) {
                        // 没有活动文档且是第一张图，创建新文档
                        shouldCreateNewDoc = true;
                        addLog('info', '没有活动文档，将在新文档中打开第一张图像');
                    } else {
                        // 其他情况，导入到当前文档
                        shouldCreateNewDoc = false;
                        addLog('info', `将第 ${i + 1} 张图像导入到当前文档`);
                    }
                    
                    addLog('info', `准备${shouldCreateNewDoc ? '在新文档中打开' : '导入到当前文档'}第 ${i + 1} 张图像`);
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

// 保存配置到 JSON 文件
async function saveSettingsToFile() {
    try {
        console.log('开始保存配置到文件:', { apiEndpoint: state.apiEndpoint, defaultApiType: state.defaultApiType });
        
        const uxp = require('uxp');
        const fs = uxp.storage.localFileSystem;
        const dataFolder = await fs.getDataFolder();
        console.log('数据文件夹获取成功');
        
        const configData = {
            apiEndpoint: state.apiEndpoint || '',
            apiType: state.defaultApiType || '07Nunchaku-Qwenimage', // 保存默认API类型，不是当前使用的
            customApis: state.customApis || [], // 保存自定义API配置
            timestamp: Date.now()
        };
        
        console.log('准备写入配置数据:', configData);
        const jsonContent = JSON.stringify(configData, null, 2);
        console.log('JSON 内容:', jsonContent);
        
        const configFile = await dataFolder.createFile('autodl-config.json', { overwrite: true });
        await configFile.write(jsonContent, { format: uxp.storage.formats.utf8 });
        console.log('文件写入完成');
        
        // 验证保存是否成功
        const verifyFile = await dataFolder.getEntry('autodl-config.json');
        if (verifyFile && verifyFile.isFile) {
            const verifyContent = await verifyFile.read({ format: uxp.storage.formats.utf8 });
            console.log('验证读取的内容:', verifyContent);
            const verifyData = JSON.parse(verifyContent);
            console.log('验证解析的数据:', verifyData);
            
            if (verifyData.apiEndpoint === configData.apiEndpoint && verifyData.apiType === configData.apiType && JSON.stringify(verifyData.customApis || []) === JSON.stringify(configData.customApis || [])) {
                const filePath = verifyFile.nativePath || verifyFile.name || 'autodl-config.json';
                console.log('配置保存验证成功，文件路径:', filePath);
                return { success: true, filePath: filePath };
            } else {
                console.error('验证失败 - 期望:', configData, '实际:', verifyData);
                throw new Error(`保存后验证失败: 期望 apiEndpoint=${configData.apiEndpoint}, 实际=${verifyData.apiEndpoint}`);
            }
        } else {
            throw new Error('验证文件不存在');
        }
    } catch (e) {
        console.error('保存配置到文件系统失败:', e);
        console.error('错误堆栈:', e.stack);
        throw e;
    }
}

// 从 JSON 文件加载配置
async function loadSettingsFromFile() {
    try {
        const uxp = require('uxp');
        const fs = uxp.storage.localFileSystem;
        const dataFolder = await fs.getDataFolder();
        const configFile = await dataFolder.getEntry('autodl-config.json');
        if (configFile && configFile.isFile) {
            const content = await configFile.read({ format: uxp.storage.formats.utf8 });
            console.log('读取配置文件内容:', content);
            const configData = JSON.parse(content);
            console.log('解析后的配置数据:', configData);
            
            let loaded = false;
            if (configData.apiEndpoint !== undefined && configData.apiEndpoint !== null) {
                state.apiEndpoint = String(configData.apiEndpoint).trim();
                console.log('加载 API 端点:', state.apiEndpoint);
                loaded = true;
            }
            if (configData.apiType && (configData.apiType === '07Nunchaku-Qwenimage' || configData.apiType === 'qwenbg' || (configData.apiType.startsWith && configData.apiType.startsWith('custom_')))) {
                state.defaultApiType = configData.apiType;
                state.apiType = configData.apiType; // 初始化时，当前使用的API类型等于默认值
                console.log('加载 API 类型:', state.defaultApiType);
                loaded = true;
            }
            
            // 加载自定义API配置
            if (configData.customApis && Array.isArray(configData.customApis)) {
                state.customApis = configData.customApis;
                console.log('加载自定义API配置:', state.customApis.length, '个');
                loaded = true;
            }
            
            if (loaded) {
                console.log('配置加载成功:', { apiEndpoint: state.apiEndpoint, defaultApiType: state.defaultApiType, apiType: state.apiType, customApisCount: state.customApis.length });
            }
            return loaded;
        } else {
            console.log('配置文件不存在');
        }
    } catch (e) {
        // 文件不存在或其他错误，记录详细信息
        console.error('从文件系统加载配置失败:', e);
        console.error('错误堆栈:', e.stack);
    }
    return false;
}

// 检测是否为ComfyUI地址（而不是API端点地址）
function isComfyUIAddress(url) {
    if (!url || !url.trim()) {
        return false;
    }
    
    const urlLower = url.toLowerCase().trim();
    
    // 检测常见的ComfyUI地址特征
    // 1. 包含 comfyui 关键字
    if (urlLower.includes('comfyui') || urlLower.includes('comfy-ui')) {
        return true;
    }
    
    // 2. 包含常见的ComfyUI端口或路径
    if (urlLower.includes(':8188') || urlLower.includes('/comfyui-ws')) {
        return true;
    }
    
    // 3. 检测是否以"uu"开头（API端点地址通常以"uu"开头）
    // 如果地址不以"uu"开头，可能是ComfyUI地址
    try {
        let urlToCheck = urlLower;
        if (!urlToCheck.match(/^https?:\/\//i)) {
            urlToCheck = 'https://' + urlToCheck;
        }
        const urlObj = new URL(urlToCheck);
        const hostname = urlObj.hostname.toLowerCase();
        
        // API端点地址通常以"uu"开头（如 uu.example.com）
        // 如果hostname不以"uu"开头，且不是localhost/127.0.0.1，可能是ComfyUI地址
        if (!hostname.startsWith('uu') && 
            hostname !== 'localhost' && 
            !hostname.startsWith('127.0.0.1') &&
            !hostname.startsWith('192.168.') &&
            !hostname.startsWith('10.') &&
            !hostname.startsWith('172.')) {
            // 进一步检查：如果包含常见的ComfyUI特征，则判定为ComfyUI地址
            if (hostname.includes('comfy') || hostname.includes('stable-diffusion')) {
                return true;
            }
        }
    } catch (e) {
        // URL解析失败，无法判断
    }
    
    return false;
}

// 解析API代码，提取workflow_id和input_values字段
function parseApiCode(apiCode) {
    try {
        // 尝试解析JSON
        let parsed;
        if (typeof apiCode === 'string') {
            parsed = JSON.parse(apiCode);
        } else {
            parsed = apiCode;
        }
        
        if (!parsed.workflow_id) {
            throw new Error('缺少 workflow_id 字段');
        }
        
        if (!parsed.input_values || typeof parsed.input_values !== 'object') {
            throw new Error('缺少 input_values 字段或格式不正确');
        }
        
        const workflowId = parsed.workflow_id;
        const inputFields = [];
        
        // 解析input_values中的每个字段
        for (const [key, value] of Object.entries(parsed.input_values)) {
            let fieldType = 'text'; // 默认类型
            let label = key;
            
            // 根据字段名和值类型判断字段类型
            if (key.includes(':image') || value === '[需要上传图片]' || (typeof value === 'string' && value.includes('image'))) {
                fieldType = 'image';
                label = '图像上传';
            } else if (key.includes(':seed') || key.includes(':Seed')) {
                fieldType = 'seed';
                label = '随机种子';
            } else if (key.includes(':string') || key.includes(':String')) {
                fieldType = 'string';
                label = '文本输入';
            } else if (key.includes(':text') || key.includes(':Text')) {
                fieldType = 'text';
                label = '文本输入';
            } else if (key.includes(':value') || key.includes(':Value')) {
                fieldType = 'value';
                label = '数值';
            } else if (key.includes(':width') || key.includes(':Width')) {
                fieldType = 'width';
                label = '宽度';
            } else if (key.includes(':batch_size') || key.includes(':batchSize') || key.includes(':BatchSize')) {
                fieldType = 'batch_size';
                label = '批次大小';
            } else if (typeof value === 'number') {
                // 如果是数字，判断是seed还是普通数值
                if (key.toLowerCase().includes('seed')) {
                    fieldType = 'seed';
                    label = '随机种子';
                } else {
                    fieldType = 'value';
                    label = '数值';
                }
            } else if (typeof value === 'string') {
                // 如果是字符串，判断是否是图像占位符
                if (value === '[需要上传图片]' || value.toLowerCase().includes('image')) {
                    fieldType = 'image';
                    label = '图像上传';
                } else {
                    fieldType = 'text';
                    label = '文本输入';
                }
            }
            
            let defaultVal = undefined;
            if (fieldType === 'seed' || fieldType === 'value' || fieldType === 'width' || fieldType === 'batch_size') {
                if (typeof value === 'number') {
                    // 数字类型，检查是否超过安全整数范围
                    if (value > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(value)) {
                        // 大数字使用字符串存储
                        defaultVal = String(Math.floor(value));
                    } else {
                        defaultVal = Math.floor(value);
                    }
                } else if (typeof value === 'string' && value.trim() !== '') {
                    // 字符串类型，检查是否是大数字
                    const numValue = parseFloat(value);
                    const strValue = value.trim();
                    if (strValue.length > 15 || numValue > Number.MAX_SAFE_INTEGER || isNaN(numValue)) {
                        // 大数字或无效数字，使用字符串（移除非数字字符，保留数字）
                        defaultVal = strValue.replace(/[^0-9]/g, '') || undefined;
                    } else {
                        defaultVal = Math.floor(numValue) || 0;
                    }
                }
            }
            
            inputFields.push({
                key: key,
                type: fieldType,
                label: label,
                default_value: defaultVal
            });
        }
        
        return {
            workflow_id: workflowId,
            input_fields: inputFields
        };
    } catch (error) {
        throw new Error(`解析API代码失败: ${error.message}`);
    }
}

// 标准化 API 服务器地址
function normalizeApiEndpoint(url) {
    if (!url || !url.trim()) {
        return '';
    }

    let normalized = url.trim();

    // 移除末尾的斜杠
    normalized = normalized.replace(/\/+$/, '');

    // 如果包含路径（如 /api/workflow/generate），提取基础URL
    try {
        // 如果没有协议，先添加 https:// 以便解析
        let urlToParse = normalized;
        if (!normalized.match(/^https?:\/\//i)) {
            urlToParse = 'https://' + normalized;
        }

        const urlObj = new URL(urlToParse);
        // 只保留协议、主机名和端口
        normalized = urlObj.protocol + '//' + urlObj.host;
    } catch (e) {
        // 如果URL解析失败，尝试手动处理
        // 移除路径部分（从第一个斜杠开始的所有内容，但保留端口号）
        const pathMatch = normalized.match(/^([^\/]+)(\/.*)?$/);
        if (pathMatch) {
            normalized = pathMatch[1];
        }
        
        // 如果没有协议，添加 https://
        if (!normalized.match(/^https?:\/\//i)) {
            normalized = 'https://' + normalized;
        }
    }

    // 确保末尾没有斜杠
    normalized = normalized.replace(/\/+$/, '');

    return normalized;
}

// 处理 API 端点输入框变化
function handleEndpointInputChange(inputElement) {
    const originalValue = inputElement.value || '';
    
    // 检查是否为ComfyUI地址
    if (originalValue.trim() && isComfyUIAddress(originalValue)) {
        addLog('warning', '检测到可能是ComfyUI地址，请确保输入的是API端点地址（通常以"uu"开头）');
    }
    
    const normalizedValue = normalizeApiEndpoint(originalValue);
    
    // 再次检查标准化后的地址
    if (normalizedValue && isComfyUIAddress(normalizedValue)) {
        addLog('warning', '标准化后的地址仍可能是ComfyUI地址，请检查是否正确');
    }
    
    // 如果值被修正了，更新输入框和state
    if (originalValue !== normalizedValue && normalizedValue) {
        state.apiEndpoint = normalizedValue;
        inputElement.value = normalizedValue;
        addLog('info', `地址已自动修正为: ${normalizedValue}`);
        render();
    } else {
        state.apiEndpoint = originalValue;
        render();
    }
}


// 保存配置
async function saveSettings() {
    try {
        // 从输入框直接读取当前值，确保保存的是用户实际输入的值
        const endpointInput = document.getElementById('settings-api-endpoint-input');
        const apiTypeSelect = document.getElementById('settings-api-type-select');
        
        console.log('保存前 state:', { apiEndpoint: state.apiEndpoint, apiType: state.apiType });
        
        if (endpointInput) {
            const inputValue = endpointInput.value || '';
            console.log('从输入框读取的值:', inputValue);
            
            // 检查是否为ComfyUI地址
            if (inputValue.trim() && isComfyUIAddress(inputValue)) {
                addLog('warning', '警告：检测到可能是ComfyUI地址，请确保输入的是API端点地址（通常以"uu"开头）');
                addLog('warning', 'API端点地址示例：https://uu.example.com:8443');
            }
            
            // 标准化地址格式
            const normalizedValue = normalizeApiEndpoint(inputValue);
            
            // 再次检查标准化后的地址
            if (normalizedValue && isComfyUIAddress(normalizedValue)) {
                addLog('error', '错误：标准化后的地址仍可能是ComfyUI地址，请检查地址是否正确');
                state.status = '保存失败：检测到ComfyUI地址，请使用API端点地址';
                state.statusType = 'error';
                render();
                return;
            }
            
            state.apiEndpoint = normalizedValue;
            // 如果地址被修正了，更新输入框显示
            if (normalizedValue !== inputValue.trim() && normalizedValue) {
                endpointInput.value = normalizedValue;
                addLog('info', `地址已自动修正为: ${normalizedValue}`);
            }
        } else {
            console.warn('未找到 API 端点输入框');
        }
        
        if (apiTypeSelect) {
            state.defaultApiType = apiTypeSelect.value || '07Nunchaku-Qwenimage';
            console.log('从选择框读取的值:', state.defaultApiType);
        } else {
            console.warn('未找到 API 类型选择框');
        }

        console.log('保存时 state:', { apiEndpoint: state.apiEndpoint, defaultApiType: state.defaultApiType, apiType: state.apiType });

        // 验证必填字段
        if (!state.apiEndpoint || !state.apiEndpoint.trim()) {
            addLog('error', 'API 服务器地址不能为空');
            state.status = '保存失败：API 服务器地址不能为空';
            state.statusType = 'error';
            render();
            return;
        }

        addLog('info', `准备保存配置: API端点=${state.apiEndpoint}, API类型=${state.apiType}`);
        
        const result = await saveSettingsToFile();
        if (!result || !result.success) {
            throw new Error('保存配置失败');
        }

        // 保存成功后，确保 state 保持正确的值
        console.log('保存成功后 state:', { apiEndpoint: state.apiEndpoint, apiType: state.apiType });
        
        addLog('success', '配置已保存到 JSON 文件');
        addLog('info', `文件路径: ${result.filePath}`);
        addLog('info', `API端点: ${state.apiEndpoint}`);
        addLog('info', `默认API类型: ${state.defaultApiType}`);
        state.status = '配置已保存';
        state.statusType = 'success';
        
        // 保存成功后，将当前使用的API类型重置为新的默认值
        state.apiType = state.defaultApiType;
        
        // 重新初始化 API（这会使用更新后的 state）
        initAPI();
        
        // 检查 API 服务器状态（异步执行，不阻塞UI）
        // 使用 skipInitialRender=false 来显示"checking"状态，但最终只渲染一次
        checkApiServerStatus(false).catch(err => {
            console.error('检查API状态失败:', err);
        });
        
        setTimeout(() => {
            state.status = '';
            render();
        }, 2000);
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        addLog('error', `保存配置失败: ${errorMessage}`);
        addLog('error', `错误堆栈: ${e.stack || '无堆栈信息'}`);
        state.status = `保存失败: ${errorMessage}`;
        state.statusType = 'error';
        console.error('保存配置失败:', e);
        console.error('保存失败时的 state:', { apiEndpoint: state.apiEndpoint, apiType: state.apiType });
    }
    render();
}

// 切换标签页
function setActiveTab(tab) {
    state.activeTab = tab;
    
    // 清除不相关的状态消息
    // 如果切换到设置页面，清除生成相关的状态消息
    if (tab === 'settings') {
        // 只保留设置相关的状态消息（如"配置已保存"、"保存失败"等）
        const settingsRelatedStatuses = ['配置已保存', '保存失败', '保存成功'];
        const isSettingsRelated = settingsRelatedStatuses.some(s => state.status && state.status.includes(s));
        if (!isSettingsRelated && state.status) {
            state.status = '';
            state.statusType = 'processing';
        }
    } else if (tab === 'main') {
        // 切换到生成页面时，清除设置相关的状态消息
        const settingsRelatedStatuses = ['配置已保存', '保存失败'];
        const isSettingsRelated = settingsRelatedStatuses.some(s => state.status && state.status.includes(s));
        if (isSettingsRelated && state.status) {
            state.status = '';
            state.statusType = 'processing';
        }
        
        // 切换到首页时检查 API 服务器状态和 ComfyUI 状态
        // 但如果正在检查中，跳过重复检查
        if (state.apiEndpoint && state.apiEndpoint.trim() && !state.isCheckingStatus) {
            // 异步检查状态，不阻塞渲染
            checkApiServerStatus(true).catch(err => {
                console.error('检查API状态失败:', err);
            });
        }
    } else if (tab === 'logs') {
        // 切换到日志页面时，清除所有状态消息
        state.status = '';
        state.statusType = 'processing';
    }
    
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
                <div class="sp-tab ${state.activeTab === 'settings' ? 'selected' : ''}" data-tab="settings">
                    <span class="tab-text ${state.activeTab === 'settings' ? 'active' : 'inactive'}">设置</span>
                </div>
                <div class="sp-tab ${state.activeTab === 'logs' ? 'selected' : ''}" data-tab="logs">
                    <span class="tab-text ${state.activeTab === 'logs' ? 'active' : 'inactive'}">日志</span>
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

    // 绑定按钮和可点击元素的事件
    const actionElements = root.querySelectorAll('[data-action]');
    actionElements.forEach(element => {
        element.addEventListener('click', function() {
            // 如果是禁用状态，不处理点击
            if (this.hasAttribute('disabled') || (this.style && this.style.opacity === '0.5')) {
                return;
            }
            
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
                saveSettings().catch(error => {
                    console.error('保存设置时发生未处理的错误:', error);
                    addLog('error', `保存设置失败: ${error.message || String(error)}`);
                    render();
                });
            } else if (action === 'addCustomApi') {
                handleAddCustomApi();
            } else if (action === 'deleteCustomApi') {
                const apiId = this.getAttribute('data-api-id');
                handleDeleteCustomApi(apiId);
            } else if (action === 'randomSeed') {
                const fieldId = this.getAttribute('data-field-id');
                handleRandomSeed(fieldId);
            }
        });
    });
    
    // 绑定自定义API字段的输入事件
    if (state.apiType && state.apiType.startsWith('custom_')) {
        const customApi = state.customApis.find(api => api.id === state.apiType);
        if (customApi && customApi.input_fields) {
            customApi.input_fields.forEach(field => {
                const fieldId = `custom-api-field-${field.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const fieldInput = root.querySelector(`#${fieldId}`);
                if (fieldInput) {
                    // 同时监听input和change事件，确保实时更新
                    const updateValue = function() {
                        if (!state.customApiValues[state.apiType]) {
                            state.customApiValues[state.apiType] = {};
                        }
                        // 如果是seed或数值类型，确保转换为整数
                        if (field.type === 'seed' || field.type === 'value' || field.type === 'width' || field.type === 'batch_size') {
                            let finalValue;
                            if (field.type === 'seed') {
                                if (!this.value || this.value === '' || this.value.trim() === '') {
                                    // 如果是seed且为空，生成新的随机种子
                                    finalValue = Math.floor(Math.random() * 100000000);
                                } else {
                                    // 对于seed，检查是否是大数字（超过安全整数范围）
                                    const strValue = String(this.value).trim();
                                    // 尝试解析为数字
                                    const numValue = parseFloat(strValue);
                                    if (isNaN(numValue)) {
                                        finalValue = Math.floor(Math.random() * 100000000);
                                    } else if (numValue > Number.MAX_SAFE_INTEGER || strValue.length > 15) {
                                        // 大数字使用字符串存储（避免精度丢失）
                                        // 移除小数点和小数部分
                                        const intStr = strValue.split('.')[0].replace(/[^0-9]/g, '');
                                        finalValue = intStr || String(Math.floor(numValue));
                                    } else {
                                        finalValue = Math.floor(numValue);
                                    }
                                }
                            } else {
                                // 其他数值类型
                                const numValue = parseFloat(this.value);
                                if (isNaN(numValue)) {
                                    finalValue = 0;
                                } else {
                                    finalValue = Math.floor(numValue);
                                }
                            }
                            state.customApiValues[state.apiType][field.key] = finalValue;
                            // 更新输入框显示，确保显示为字符串格式（避免大数字精度丢失）
                            this.value = String(finalValue);
                        } else {
                            state.customApiValues[state.apiType][field.key] = this.value;
                        }
                    };
                    
                    fieldInput.addEventListener('change', updateValue);
                    fieldInput.addEventListener('input', updateValue);
                }
            });
        }
    }

    // 绑定生成页面的API类型选择框事件（只影响当前使用的API类型，不影响默认值）
    const apiTypeSelect = root.querySelector('#api-type-select');
    if (apiTypeSelect) {
        apiTypeSelect.addEventListener('change', function() {
            const newApiType = this.value;
            // 如果选择了已删除的 qwenbg，重置为默认值
            if (newApiType === 'qwenbg') {
                state.apiType = state.defaultApiType || '07Nunchaku-Qwenimage';
                render();
                return;
            }
            state.apiType = newApiType; // 只更新当前使用的API类型，不影响defaultApiType
            render();
        });
    }

    // 绑定设置页面的默认API类型选择框事件（只影响默认值，不影响当前使用的）
    const settingsApiTypeSelect = root.querySelector('#settings-api-type-select');
    if (settingsApiTypeSelect) {
        settingsApiTypeSelect.addEventListener('change', function() {
            state.defaultApiType = this.value; // 只更新默认API类型
            render();
        });
    }

    // 绑定设置页面的API端点输入框事件
    const settingsApiEndpointInput = root.querySelector('#settings-api-endpoint-input');
    if (settingsApiEndpointInput) {
        settingsApiEndpointInput.addEventListener('input', function() {
            state.apiEndpoint = this.value;
        });
        settingsApiEndpointInput.addEventListener('change', function() {
            handleEndpointInputChange(this);
        });
    }

    // 绑定生成页面的提示词输入框事件
    const textInput = root.querySelector('#text-input');
    if (textInput) {
        textInput.addEventListener('change', function() {
            state.text = this.value;
            render();
        });
    }

    // 绑定生成页面的批次大小输入框事件
    const batchSizeInput = root.querySelector('#batch-size-input');
    if (batchSizeInput) {
        batchSizeInput.addEventListener('change', function() {
            state.batchSize = parseInt(this.value) || 1;
            render();
        });
    }

    // 绑定"在新文档打开"复选框事件
    const openInNewDocCheckbox = root.querySelector('#open-in-new-doc-checkbox');
    if (openInNewDocCheckbox) {
        // 确保复选框状态与state同步
        openInNewDocCheckbox.checked = state.openInNewDoc;
        
        // 使用once选项或者先移除再添加，避免重复绑定
        // 由于每次render都会重新创建DOM，所以直接添加事件监听器即可
        openInNewDocCheckbox.addEventListener('change', function() {
            state.openInNewDoc = this.checked;
            console.log('"在新文档打开"状态已更新:', state.openInNewDoc);
            addLog('info', `"在新文档打开"已${state.openInNewDoc ? '勾选' : '取消勾选'}`);
        });
    }
}

// 渲染主页面
function renderMainTab() {
    return `
        <div class="sp-tab-page visible tab-page">
            <div class="container">
                <div class="form-group">
                    <div class="status-row">
                        <div class="status-item">
                            <span class="status-label">服务器：</span>
                            <span class="api-status-indicator ${state.apiServerStatus}"></span>
                        </div>
                        <div class="status-item">
                            <span class="status-label">ComfyUI：</span>
                            <span class="api-status-indicator ${state.comfyuiStatus}"></span>
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label for="api-type-select">API 类型</label>
                    <select id="api-type-select" ${state.isGenerating ? 'disabled' : ''}>
                        <option value="07Nunchaku-Qwenimage" ${state.apiType === '07Nunchaku-Qwenimage' ? 'selected' : ''}>07Nunchaku-Qwenimage</option>
                        ${state.customApis.map(api => `
                            <option value="${api.id}" ${state.apiType === api.id ? 'selected' : ''}>${api.name || api.id}</option>
                        `).join('')}
                    </select>
                </div>

                ${state.apiType === '07Nunchaku-Qwenimage' ? renderQwenImageFields() : ''}
                ${state.apiType && state.apiType.startsWith('custom_') ? renderCustomApiFields() : ''}

                <div class="form-group">
                    <label class="checkbox-label ${state.isGenerating ? 'disabled' : ''}">
                        <input type="checkbox" id="open-in-new-doc-checkbox" ${state.openInNewDoc ? 'checked' : ''} ${state.isGenerating ? 'disabled' : ''}>
                        <span>在新文档打开</span>
                    </label>
                </div>

                <div class="button-group">
                    <button data-action="generate" ${state.isGenerating || (state.apiType === '07Nunchaku-Qwenimage' && !state.text.trim()) ? 'disabled' : ''} class="button-primary">
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
            <textarea id="text-input" ${state.isGenerating ? 'disabled' : ''} placeholder="输入提示词，例如：超广角动感运营插画，3d插画风格海报...">${state.text}</textarea>
        </div>
        <div class="form-group">
            <label for="batch-size-input">批次大小 (58:batch_size)</label>
            <input id="batch-size-input" type="number" min="1" max="10" value="${state.batchSize}" ${state.isGenerating ? 'disabled' : ''}>
        </div>
    `;
}

// 渲染自定义API字段
function renderCustomApiFields() {
    const customApi = state.customApis.find(api => api.id === state.apiType);
    if (!customApi || !customApi.input_fields) {
        return '<div class="form-group"><div class="info-box-secondary">未找到自定义API配置</div></div>';
    }
    
    // 确保customApiValues对象存在
    if (!state.customApiValues[state.apiType]) {
        state.customApiValues[state.apiType] = {};
    }
    
    const fields = customApi.input_fields.map(field => {
        let inputHtml = '';
        const fieldId = `custom-api-field-${field.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const currentValue = state.customApiValues[state.apiType][field.key] || '';
        
        if (field.type === 'image') {
            inputHtml = `<div class="info-box-secondary">将使用当前 Photoshop 文档的画布或选区（如有）作为输入图像</div>`;
        } else if (field.type === 'string' || field.type === 'text') {
            inputHtml = `<input id="${fieldId}" type="text" value="${currentValue}" ${state.isGenerating ? 'disabled' : ''} placeholder="请输入${field.label || field.key}" style="width: 100%; padding: 6px;">`;
        } else if (field.type === 'seed') {
            // 确保随机种子是整数，对于大数字使用字符串存储
            let defaultValue;
            let displayValue;
            
            if (currentValue !== '' && currentValue !== null && currentValue !== undefined) {
                // 如果已有值，检查是否是字符串（大数字）
                if (typeof currentValue === 'string') {
                    // 字符串值直接使用，移除可能的非数字字符（保留数字）
                    const cleanStr = currentValue.replace(/[^0-9]/g, '');
                    defaultValue = cleanStr || currentValue;
                    displayValue = defaultValue;
                } else {
                    // 数字类型，检查是否超过安全整数范围
                    const strValue = String(currentValue);
                    const numValue = parseFloat(currentValue);
                    // 如果字符串长度超过15位或数字超过安全整数范围，使用字符串
                    if (strValue.length > 15 || numValue > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(numValue)) {
                        // 大数字使用字符串存储，移除小数点
                        defaultValue = strValue.split('.')[0].replace(/[^0-9]/g, '') || String(Math.floor(numValue));
                        displayValue = defaultValue;
                    } else {
                        defaultValue = Math.floor(numValue);
                        displayValue = String(defaultValue);
                    }
                }
            } else if (field.default_value !== null && field.default_value !== undefined && field.default_value !== '') {
                // 如果有默认值，检查是否是字符串（大数字）
                if (typeof field.default_value === 'string') {
                    defaultValue = field.default_value;
                    displayValue = field.default_value;
                } else {
                    const numValue = parseFloat(field.default_value);
                    if (numValue > Number.MAX_SAFE_INTEGER) {
                        defaultValue = String(Math.floor(numValue));
                        displayValue = defaultValue;
                    } else {
                        defaultValue = Math.floor(numValue);
                        displayValue = String(defaultValue);
                    }
                }
            } else {
                // 生成新的随机种子（8位）
                defaultValue = Math.floor(Math.random() * 100000000);
                displayValue = String(defaultValue);
            }
            
            // 确保值被保存（大数字用字符串）
            state.customApiValues[state.apiType][field.key] = defaultValue;
            // 使用text类型而不是number，避免大数字精度丢失
            // 转义HTML特殊字符，防止XSS
            const escapedValue = String(displayValue).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            const randomButtonId = `${fieldId}-random-btn`;
            inputHtml = `
                <div style="display: flex; align-items: center; gap: 6px;">
                    <input id="${fieldId}" type="text" inputmode="numeric" pattern="[0-9]*" value="${escapedValue}" ${state.isGenerating ? 'disabled' : ''} placeholder="随机种子" style="flex: 1; padding: 6px;">
                    <span id="${randomButtonId}" data-action="randomSeed" data-field-id="${fieldId}" ${state.isGenerating ? 'style="opacity: 0.5; cursor: not-allowed;"' : 'class="random-seed-icon"'} title="随机生成8位数字">🎲</span>
                </div>
            `;
        } else if (field.type === 'value' || field.type === 'width' || field.type === 'batch_size') {
            // 确保数值字段也是整数
            let defaultValue;
            if (currentValue !== '' && currentValue !== null && currentValue !== undefined) {
                defaultValue = Math.floor(parseFloat(currentValue) || 0);
            } else if (field.default_value !== null && field.default_value !== undefined && field.default_value !== '') {
                defaultValue = Math.floor(parseFloat(field.default_value) || 0);
            } else {
                defaultValue = '';
            }
            // 确保值被保存为整数（如果有值）
            if (defaultValue !== '' && defaultValue !== null && defaultValue !== undefined) {
                state.customApiValues[state.apiType][field.key] = defaultValue;
                // 使用整数格式显示
                inputHtml = `<input id="${fieldId}" type="number" step="1" value="${Math.floor(defaultValue)}" ${state.isGenerating ? 'disabled' : ''} placeholder="请输入${field.label || field.key}" style="width: 100%; padding: 6px;">`;
            } else {
                inputHtml = `<input id="${fieldId}" type="number" step="1" value="" ${state.isGenerating ? 'disabled' : ''} placeholder="请输入${field.label || field.key}" style="width: 100%; padding: 6px;">`;
            }
        }
        
        return `
            <div class="form-group">
                <label for="${fieldId}">${field.label || field.key}</label>
                ${inputHtml}
            </div>
        `;
    }).join('');
    
    return fields;
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
                        <span class="log-type-label"> [${log.type === 'error' ? '错误' : log.type === 'success' ? '成功' : log.type === 'warning' ? '警告' : '信息'}]</span>
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
                    <input id="settings-api-endpoint-input" type="text" value="${state.apiEndpoint || ''}" placeholder="https://uu.example.com:8443">
                    <div class="help-text-medium">
                        此配置将应用于所有 API 类型。修改后请点击"保存"按钮保存配置。系统会自动修正地址格式（移除路径，添加协议等）。
                        <br><strong>注意：</strong>请确保输入的是 API 端点地址（通常以"uu"开头），而不是 ComfyUI 地址。
                    </div>
                </div>

                <div class="form-group">
                    <label for="settings-api-type-select">默认 API 类型</label>
                    <select id="settings-api-type-select">
                        <option value="07Nunchaku-Qwenimage" ${state.defaultApiType === '07Nunchaku-Qwenimage' ? 'selected' : ''}>07Nunchaku-Qwenimage</option>
                        ${state.customApis.map(api => `
                            <option value="${api.id}" ${state.defaultApiType === api.id ? 'selected' : ''}>${api.name || api.id}</option>
                        `).join('')}
                    </select>
                    <div class="help-text-medium">
                        选择默认使用的 API 类型。此设置保存后，下次打开插件时会自动使用此默认值。
                    </div>
                </div>

                <div class="info-box-large">
                    <div class="info-box-title">说明：</div>
                    <div class="info-box-item">• API 服务器地址是所有 API 类型共用的配置</div>
                    <div class="info-box-item">• 配置将保存到本地 JSON 文件（autodl-config.json）</div>
                    <div class="info-box-item">• 配置保存后，下次打开插件会自动从 JSON 文件加载</div>
                </div>

                <div class="button-group-bottom">
                    <button data-action="saveSettings">
                        保存配置
                    </button>
                </div>

                ${renderCustomApisSection()}

                ${state.status && state.activeTab === 'settings' && (state.status.includes('保存') || state.status.includes('配置')) ? `<div class="status ${state.statusType} status-message-large">${state.status}</div>` : ''}
            </div>
        </div>
    `;
}

// 渲染自定义API管理区域
function renderCustomApisSection() {
    return `
        <div class="form-group" style="margin-top: 24px;">
            <h2 class="page-title-large">自定义 API 配置</h2>
            <div class="help-text-medium" style="margin-bottom: 12px;">
                添加自定义 ComfyUI workflow 配置。粘贴API代码（包含 workflow_id 和 input_values），系统会自动解析字段。
            </div>
            
            ${state.customApis.map((api, index) => `
                <div class="custom-api-item" data-api-id="${api.id}" style="margin-bottom: 16px; padding: 12px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong>${api.name || '未命名API'}</strong>
                        <div>
                            <button data-action="deleteCustomApi" data-api-id="${api.id}" style="width: auto; padding: 4px 8px; background-color: #d32f2f; font-size: 11px;">删除</button>
                        </div>
                    </div>
                    <div style="font-size: 11px; color: rgba(255,255,255,0.7);">
                        Workflow ID: ${api.workflow_id || '未设置'} | 参数数量: ${api.input_fields ? api.input_fields.length : 0}
                    </div>
                </div>
            `).join('')}
            
            <div class="form-group" style="margin-top: 16px;">
                <label>添加自定义API（粘贴API代码）</label>
                <textarea id="custom-api-code-input" placeholder='例如：\n{\n  "workflow_id": "qwenbg",\n  "input_values": {\n    "319:image": "[需要上传图片]",\n    "476:seed": 780040281973519\n  }\n}' style="min-height: 120px; font-family: monospace; font-size: 11px;"></textarea>
                <div class="help-text-medium" style="margin-top: 4px;">
                    粘贴包含 workflow_id 和 input_values 的JSON代码，系统会自动解析字段类型。
                </div>
                <button data-action="addCustomApi" style="width: auto; padding: 6px 12px; margin-top: 8px;">
                    + 添加自定义API
                </button>
            </div>
        </div>
    `;
}

// 处理添加自定义API
function handleAddCustomApi() {
    const codeInput = document.getElementById('custom-api-code-input');
    if (!codeInput) {
        addLog('error', '无法找到API代码输入框');
        return;
    }
    
    const apiCode = codeInput.value.trim();
    if (!apiCode) {
        addLog('error', '请输入API代码');
        return;
    }
    
    try {
        // 解析API代码
        const parsed = parseApiCode(apiCode);
        
        // 检查workflow_id是否已存在
        const existingApi = state.customApis.find(api => api.workflow_id === parsed.workflow_id);
        
        let apiName = parsed.workflow_id || '自定义API';
        
        // 如果workflow_id已存在，需要重命名（但workflow_id保持不变）
        if (existingApi) {
            // 生成新的名称，添加序号
            let counter = 1;
            let newName = `${apiName}_${counter}`;
            while (state.customApis.some(api => api.name === newName)) {
                counter++;
                newName = `${apiName}_${counter}`;
            }
            apiName = newName;
            addLog('warning', `检测到相同的 workflow_id "${parsed.workflow_id}"，已重命名为 "${apiName}"`);
        }
        
        // 创建自定义API对象
        const apiId = 'custom_' + Date.now();
        const customApi = {
            id: apiId,
            name: apiName,
            workflow_id: parsed.workflow_id, // workflow_id保持不变
            input_fields: parsed.input_fields
        };
        
        // 添加到列表
        state.customApis.push(customApi);
        
        // 清空输入框
        codeInput.value = '';
        
        addLog('success', `自定义API "${customApi.name}" 已添加，包含 ${customApi.input_fields.length} 个参数`);
        
        // 自动保存配置到JSON文件
        saveSettingsToFile().then(result => {
            if (result && result.success) {
                addLog('success', '自定义API已自动保存到配置文件');
            } else {
                addLog('warning', '自定义API已添加，但保存到配置文件失败，请手动保存配置');
            }
        }).catch(error => {
            addLog('warning', `自定义API已添加，但保存到配置文件失败: ${error.message}，请手动保存配置`);
        });
        
        render();
    } catch (error) {
        addLog('error', `添加自定义API失败: ${error.message}`);
    }
}

// 处理随机种子按钮点击
function handleRandomSeed(fieldId) {
    if (!fieldId) {
        return;
    }
    
    const fieldInput = document.getElementById(fieldId);
    if (!fieldInput) {
        return;
    }
    
    // 生成8位随机数字（10000000 到 99999999）
    const randomSeed = Math.floor(Math.random() * 90000000) + 10000000;
    
    // 更新输入框的值
    fieldInput.value = String(randomSeed);
    
    // 触发change事件，确保值被保存到state
    const changeEvent = new Event('change', { bubbles: true });
    fieldInput.dispatchEvent(changeEvent);
    
    addLog('info', `已生成随机种子: ${randomSeed}`);
}

// 处理删除自定义API
function handleDeleteCustomApi(apiId) {
    const index = state.customApis.findIndex(api => api.id === apiId);
    if (index !== -1) {
        const api = state.customApis[index];
        state.customApis.splice(index, 1);
        
        // 如果删除的是当前使用的API，重置为默认API
        if (state.apiType === apiId) {
            state.apiType = '07Nunchaku-Qwenimage';
        }
        if (state.defaultApiType === apiId) {
            state.defaultApiType = '07Nunchaku-Qwenimage';
        }
        
        // 删除对应的输入值
        delete state.customApiValues[apiId];
        
        addLog('info', `自定义API "${api.name || apiId}" 已删除`);
        
        // 自动保存配置到JSON文件
        saveSettingsToFile().then(result => {
            if (result && result.success) {
                addLog('success', '配置已自动保存');
            } else {
                addLog('warning', '删除成功，但保存到配置文件失败，请手动保存配置');
            }
        }).catch(error => {
            addLog('warning', `删除成功，但保存到配置文件失败: ${error.message}，请手动保存配置`);
        });
        
        render();
    }
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
                        init().catch(error => {
                            console.error('初始化失败:', error);
                        });
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
        init().catch(error => {
            console.error('初始化失败:', error);
        });
        window.__autodlMounted = true;
    }
}
