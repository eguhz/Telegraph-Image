/**
 * 解析原始的 multipart/form-data 请求体
 * 支持 --data-raw 格式的请求
 */
export async function parseMultipartFormData(request) {
    const contentType = request.headers.get('Content-Type');
    
    if (!contentType || !contentType.includes('multipart/form-data')) {
        throw new Error('Content-Type must be multipart/form-data');
    }

    // 提取 boundary
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (!boundaryMatch) {
        throw new Error('No boundary found in Content-Type');
    }

    const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '');
    const arrayBuffer = await request.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // 转换为字符串以便查找边界
    const textDecoder = new TextDecoder('utf-8', { fatal: false });
    const bodyText = textDecoder.decode(uint8Array);

    const parts = parseMultipartParts(uint8Array, boundary);
    
    // 构建 FormData 对象
    const formData = new FormData();
    
    for (const part of parts) {
        if (part.filename) {
            // 文件字段
            const blob = new Blob([part.data], { type: part.contentType || 'application/octet-stream' });
            const file = new File([blob], part.filename, { type: part.contentType || 'application/octet-stream' });
            formData.append(part.name, file);
        } else {
            // 普通字段
            const value = new TextDecoder().decode(part.data);
            formData.append(part.name, value);
        }
    }

    return formData;
}

/**
 * 解析 multipart 各个部分
 */
function parseMultipartParts(uint8Array, boundary) {
    const parts = [];
    const boundaryBytes = new TextEncoder().encode('--' + boundary);
    const crlfBytes = new Uint8Array([13, 10]); // \r\n

    let position = 0;

    // 查找第一个边界
    position = findBoundary(uint8Array, boundaryBytes, position);
    if (position === -1) {
        return parts;
    }

    position += boundaryBytes.length;

    while (position < uint8Array.length) {
        // 跳过 CRLF
        if (uint8Array[position] === 13 && uint8Array[position + 1] === 10) {
            position += 2;
        }

        // 查找下一个边界
        const nextBoundaryPos = findBoundary(uint8Array, boundaryBytes, position);
        if (nextBoundaryPos === -1) {
            break;
        }

        // 提取这一部分的数据
        const partData = uint8Array.slice(position, nextBoundaryPos);
        const part = parsePart(partData);
        
        if (part) {
            parts.push(part);
        }

        position = nextBoundaryPos + boundaryBytes.length;

        // 检查是否是最后一个边界 (--boundary--)
        if (uint8Array[position] === 45 && uint8Array[position + 1] === 45) {
            break;
        }
    }

    return parts;
}

/**
 * 解析单个 part
 */
function parsePart(partData) {
    // 查找头部和内容的分隔符 (\r\n\r\n)
    const headerEndPos = findSequence(partData, new Uint8Array([13, 10, 13, 10]));
    
    if (headerEndPos === -1) {
        return null;
    }

    const headerBytes = partData.slice(0, headerEndPos);
    const contentBytes = partData.slice(headerEndPos + 4);

    // 移除末尾的 \r\n
    let contentEnd = contentBytes.length;
    if (contentEnd >= 2 && contentBytes[contentEnd - 2] === 13 && contentBytes[contentEnd - 1] === 10) {
        contentEnd -= 2;
    }
    const actualContent = contentBytes.slice(0, contentEnd);

    // 解析头部
    const headerText = new TextDecoder().decode(headerBytes);
    const headers = parseHeaders(headerText);

    const contentDisposition = headers['content-disposition'];
    if (!contentDisposition) {
        return null;
    }

    const nameMatch = contentDisposition.match(/name="([^"]+)"/);
    const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);

    return {
        name: nameMatch ? nameMatch[1] : '',
        filename: filenameMatch ? filenameMatch[1] : null,
        contentType: headers['content-type'] || null,
        data: actualContent
    };
}

/**
 * 解析头部字段
 */
function parseHeaders(headerText) {
    const headers = {};
    const lines = headerText.split(/\r?\n/);

    for (const line of lines) {
        const colonPos = line.indexOf(':');
        if (colonPos > 0) {
            const key = line.substring(0, colonPos).trim().toLowerCase();
            const value = line.substring(colonPos + 1).trim();
            headers[key] = value;
        }
    }

    return headers;
}

/**
 * 查找边界位置
 */
function findBoundary(data, boundary, startPos = 0) {
    return findSequence(data, boundary, startPos);
}

/**
 * 在字节数组中查找子序列
 */
function findSequence(data, sequence, startPos = 0) {
    const seqLen = sequence.length;
    const dataLen = data.length;

    for (let i = startPos; i <= dataLen - seqLen; i++) {
        let found = true;
        for (let j = 0; j < seqLen; j++) {
            if (data[i + j] !== sequence[j]) {
                found = false;
                break;
            }
        }
        if (found) {
            return i;
        }
    }

    return -1;
}
