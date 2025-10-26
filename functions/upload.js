import { errorHandling, telemetryData } from "./utils/middleware";
import { parseMultipartFormData } from "./utils/multipart-parser";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // 验证 Authorization Token
        if (env.API_TOKEN) {
            const authHeader = request.headers.get('Authorization');
            const expectedToken = `Bearer ${env.API_TOKEN}`;
            
            if (!authHeader || authHeader !== expectedToken) {
                return new Response(
                    JSON.stringify({
                        status: false,
                        message: "Unauthorized: Invalid or missing API token",
                        data: null
                    }),
                    {
                        status: 401,
                        headers: { 'Content-Type': 'application/json' }
                    }
                );
            }
        }

        const clonedRequest = request.clone();
        
        // 尝试解析 FormData，支持标准格式和原始 multipart 格式
        let formData;
        try {
            formData = await clonedRequest.formData();
        } catch (error) {
            // 如果标准解析失败，尝试手动解析原始 multipart 数据
            console.log('Standard formData parsing failed, trying manual parsing...');
            formData = await parseMultipartFormData(request.clone());
        }

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            telegramFormData.append("photo", uploadFile);
            apiEndpoint = 'sendPhoto';
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else if (uploadFile.type.startsWith('video/')) {
            telegramFormData.append("video", uploadFile);
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }

        // 构建完整的 URL
        const domain = env.API_DOMAIN || 'https://your-domain.pages.dev';
        const fullUrl = `${domain}/file/${fileId}.${fileExtension}`;
        
        // 返回 Lsky-Pro 兼容格式
        return new Response(
            JSON.stringify({
                status: true,
                message: "success",
                data: {
                    key: fileId,
                    name: `${fileId}.${fileExtension}`,
                    pathname: `/file/${fileId}.${fileExtension}`,
                    origin_name: fileName,
                    size: uploadFile.size,
                    mimetype: uploadFile.type,
                    extension: fileExtension,
                    links: {
                        url: fullUrl,
                        html: `<img src="${fullUrl}" alt="${fileName}" />`,
                        bbcode: `[img]${fullUrl}[/img]`,
                        markdown: `![${fileName}](${fullUrl})`,
                        markdown_with_link: `[![${fileName}](${fullUrl})](${fullUrl})`,
                        thumbnail_url: fullUrl
                    }
                }
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({
                status: false,
                message: error.message,
                data: null
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}