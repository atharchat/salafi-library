import fs from 'fs';
import * as cheerio from 'cheerio';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const PINECONE_API_KEY = process.env.PINECONE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY1 || '';

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
    console.error('Missing API Keys');
    process.exit(1);
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index('salafi-scholar');

function parseFiles(envVar) {
    if (!envVar || envVar.trim() === '') return [];
    let cleaned = envVar.trim();
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        cleaned = cleaned.substring(1, cleaned.length - 1);
    }
    const list = cleaned.split(/[\s,]+/);
    const parsed = list.map(function(f) {
        let s = f.trim();
        if (s.startsWith('\'') && s.endsWith('\'')) { s = s.substring(1, s.length - 1); }
        else if (s.startsWith('\"') && s.endsWith('\"')) { s = s.substring(1, s.length - 1); }
        return s;
    }).filter(function(f) { return f !== ''; });
    return parsed;
}

const addedFiles = parseFiles(process.env.ADDED_FILES);
const modifiedFiles = parseFiles(process.env.MODIFIED_FILES);
const deletedFiles = parseFiles(process.env.DELETED_FILES);
const filesToProcess = Array.from(new Set([...addedFiles, ...modifiedFiles]));

console.log('============= بدء المزامنة =============');
console.log('الملفات المطلوب رفعها:', filesToProcess);
console.log('الملفات المطلوب حذفها:', deletedFiles);
console.log('========================================');

function parseContent(filePath, content) {
    if (filePath.endsWith('.htm') || filePath.endsWith('.html')) {
        const $ = cheerio.load(content);
        return $.text().replace(/\s+/g, ' ').trim();
    }
    return content;
}

function chunkText(text, chunkSize = 1500, overlap = 200) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let chunk = text.slice(i, i + chunkSize);
        if (chunk.trim().length > 0) chunks.push(chunk);
        i += chunkSize - overlap;
    }
    return chunks;
}

async function deleteBookVectors(filePath) {
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1];
    const sourceName = fileName.replace(/\.[^/.]+$/, '');
    console.log('جاري حـذف الكتاب: ' + sourceName + ' من Pinecone...');
    try {
        await index.deleteMany({ source: sourceName });
        console.log('تم الحذف بنجاح (direct filter): ' + sourceName);
    } catch (error) {
        try {
            await index.deleteMany({ filter: { source: sourceName } });
            console.log('تم الحذف بنجاح (nested filter): ' + sourceName);
        } catch (err2) {
            console.log('تخطي الحذف أو حدث خطأ: ' + sourceName);
        }
    }
}

const delay = function(ms) { return new Promise(function(res) { setTimeout(res, ms); }); };

async function embedChunksWithRetry(chunks, batchSize) {
    if (!batchSize) batchSize = 90;
    let allEmbeddings = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        let success = false;
        let retries = 0;
        while (!success) {
            try {
                const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=' + GEMINI_API_KEY;
                const requests = batch.map(function(text) { return {
                    model: 'models/gemini-embedding-2',
                    content: { parts: [{ text: text }] },
                    outputDimensionality: 768
                };});
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requests: requests })
                });
                const data = await res.json();
                if (data.error) {
                    if (data.error.code === 429) {
                        console.log('Rate limit ' + (retries + 1));
                        await delay(60000);
                        retries++;
                        continue;
                    }
                    throw new Error(data.error.message);
                }
                if (!data.embeddings || data.embeddings.length !== batch.length) {
                    throw new Error('استجابة المتجهات غير صحيحة من جوجل.');
                }
                for (let j = 0; j < data.embeddings.length; j++) {
                    allEmbeddings.push(data.embeddings[j].values);
                }
                success = true;
                await delay(3000);
            } catch (err) {
                console.error('Error embedding batch ' + i + ': ', err.message);
                retries++;
                if (retries > 3) throw err;
                await delay(5000 * retries);
            }
        }
    }
    return allEmbeddings;
}

async function processBook(filePath) {
    if (!fs.existsSync(filePath)) {
        console.log('تخطي: الملف غير موجود محلياً: ' + filePath);
        return;
    }
    const parts = filePath.split('/');
    let topicFolder = 'aqeedah';
    if (parts.length > 2 && parts[0] === 'test_sync') topicFolder = parts[2].toLowerCase();
    else if (parts.length > 1) topicFolder = parts[1].toLowerCase();
    const fileName = parts[parts.length - 1];
    const sourceName = fileName.replace(/\.[^/.]+$/, '');
    const topicMap = {
        'aqeedah': 'عقيدة',
        'tafsir': 'تفسير',
        'hadith': 'حديث',
        'fiqh': 'فقه',
        'seerah': 'سيرة وتراجم',
        'history': 'تاريخ'
    };
    const topic = topicMap[topicFolder] || 'عقيدة';
    console.log('>> معالجة: ' + sourceName + ' (' + topic + ')');
    await deleteBookVectors(filePath);
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const textContent = parseContent(filePath, rawContent);
    const chunks = chunkText(textContent);
    if (chunks.length === 0) {
        console.log('تحذير: لا يوجد محتوى نصي لرفعه في ' + sourceName);
        return;
    }
    console.log('>> تقسيم الكتاب لـ: ' + chunks.length + ' جزء. جاري إنشاء المتجهات...');
    const valuesArray = await embedChunksWithRetry(chunks, 90);
    console.log('>> جاري الرفع إلى Pinecone...');
    for (let i = 0; i < chunks.length; i += 50) {
        const batchChunks = chunks.slice(i, i + 50);
        const batchValues = valuesArray.slice(i, i + 50);
        try {
            const vectors = batchChunks.map(function(text, idx) {
                const vectorId = crypto.createHash('md5').update(sourceName + '-' + (i + idx)).digest('hex');
                const vals = (batchValues[idx] && batchValues[idx].length === 768) ? batchValues[idx] : Array(768).fill(0);
                return {
                    id: vectorId,
                    values: vals,
                    metadata: {
                        source: sourceName,
                        topic: topic,
                        text: text
                    }
                };
            });
            try {
                await index.upsert(vectors);
            } catch (err) {
                if (err.message && err.message.includes('at least')) {
                    await index.upsert({ records: vectors });
                } else {
                    throw err;
                }
            }
            console.log('   تم رفع المتجهات ' + (i+1) + ' إلى ' + (i + batchChunks.length));
        } catch (error) {
            console.error('Error uploading ' + sourceName + ':', error.message);
            process.exit(1);
        }
    }
    console.log('✅ انتهت المزامنة بنجاح: ' + sourceName);
}

async function main() {
    if (deletedFiles.length === 0 && filesToProcess.length === 0) {
        console.log('لا يوجد شيء للقيام به.');
        return;
    }
    for (let i = 0; i < deletedFiles.length; i++) {
        if (deletedFiles[i] && deletedFiles[i].includes('books/')) {
            await deleteBookVectors(deletedFiles[i]);
        }
    }
    for (let i = 0; i < filesToProcess.length; i++) {
        const f = filesToProcess[i];
        if (f && f.includes('books/') && (f.endsWith('.txt') || f.endsWith('.htm') || f.endsWith('.html'))) {
            await processBook(f);
        }
    }
}

main().catch(function(error) {
    console.error('❌ Error:', error);
    process.exit(1);
});
