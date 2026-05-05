import fs from 'fs';
import * as cheerio from 'cheerio';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY1; 

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
    console.error("Missing API Keys: يرجى التأكد من إضافة أسرار Github.");
    process.exit(1);
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index("salafi-scholar");

const addedFiles = process.env.ADDED_FILES ? process.env.ADDED_FILES.split(' ') : [];
const modifiedFiles = process.env.MODIFIED_FILES ? process.env.MODIFIED_FILES.split(' ') : [];
const deletedFiles = process.env.DELETED_FILES ? process.env.DELETED_FILES.split(' ') : [];

const filesToProcess = [...addedFiles, ...modifiedFiles].filter(f => f.trim() !== '');
const filesToDelete = deletedFiles.filter(f => f.trim() !== '');

console.log("الملفات المطلوب مزامنتها:", filesToProcess);
console.log("الملفات المطلوب حذفها:", filesToDelete);

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
    const sourceName = fileName.replace(/\.[^/.]+$/, ""); 

    console.log(`جاري حـذف الكتاب: ${sourceName} من Pinecone...`);
    try {
        await index.deleteMany({ filter: { source: sourceName } });
        console.log(`تم الحذف بنجاح: ${sourceName}`);
    } catch (error) {
        console.log(`لم يتم العثور على أجزاء لحذفها، أو حدث خطأ: ${sourceName}`, error.message);
    }
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function embedChunksWithRetry(chunks, batchSize = 90) {
    let allEmbeddings = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        let success = false;
        let retries = 0;
        
        while (!success) {
            try {
                const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=' + GEMINI_API_KEY;
                const requests = batch.map(text => ({
                    model: 'models/gemini-embedding-2', 
                    content: { parts: [{ text }] },
                    outputDimensionality: 768
                }));
                
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requests })
                });
                
                const data = await res.json();
                
                if (data.error) {
                    if (data.error.code === 429) {
                        console.log('تم حظر المعدل (429 Rate Limit)، ننتظر 60 ثانية قبل إعادة المحاولة...');
                        await delay(60000);
                        retries++;
                        continue;
                    }
                    throw new Error(data.error.message);
                }
                
                if (!data.embeddings || data.embeddings.length !== batch.length) {
                    console.log('Data error context:', data);
                    throw new Error('استجابة غير متطابقة من مزود خدمة التضمين.');
                }
                
                allEmbeddings.push(...data.embeddings.map(e => e.values));
                success = true;
                
                // انتظار بسيط لمدة ثانيتين بين كل 90 جزء (طلب واحد فقط لـ Gemini)
                await delay(2000);
            } catch (err) {
                console.error('خطأ أثناء طلب التضمين:', err.message);
                retries++;
                if (retries > 3) throw err;
                await delay(5000);
            }
        }
    }
    return allEmbeddings;
}

async function processBook(filePath) {
    const parts = filePath.split('/');
    let topicFolder = 'aqeedah';
    if (parts.length > 2 && parts[0] === 'test_sync') topicFolder = parts[2].toLowerCase();
    else if (parts.length > 1) topicFolder = parts[1].toLowerCase();

    const fileName = parts[parts.length - 1];
    const sourceName = fileName.replace(/\.[^/.]+$/, "");

    const topicMap = {
        'aqeedah': 'عقيدة',
        'tafsir': 'تفسير',
        'hadith': 'حديث',
        'fiqh': 'فقه',
        'seerah': 'سيرة وتراجم',
        'history': 'تاريخ'
    };
    const topic = topicMap[topicFolder] || 'عقيدة';

    console.log(`جاري معالجة الكـتـاب >> ${sourceName} | التخصص >> ${topic}`);

    await deleteBookVectors(filePath);

    if (!fs.existsSync(filePath)) {
        console.log(`الملف غير موجود محلياً (قد يكون تم حذفه): ${filePath}`);
        return;
    }

    const rawContent = fs.readFileSync(filePath, 'utf8');
    const textContent = parseContent(filePath, rawContent);
    const chunks = chunkText(textContent);

    console.log(`تم تقسيم الكتاب لـ: ${chunks.length} جزء (Chunk)`);

    // إرسال حتى 90 جزء في طلب API واحد لـ Gemini
    const valuesArray = await embedChunksWithRetry(chunks, 90);
    
    // رفع الدفعات لـ Pinecone (50 متجه في كل دفعة مع البيانات الوصفية)
    for (let i = 0; i < chunks.length; i += 50) {
        const batchChunks = chunks.slice(i, i + 50);
        const batchValues = valuesArray.slice(i, i + 50);
        try {
            const vectors = batchChunks.map((text, idx) => {
                const vectorId = crypto.createHash('md5').update(sourceName + "-chunk-" + (i + idx)).digest('hex');
                return {
                    id: vectorId,
                    values: batchValues[idx],
                    metadata: {
                        source: sourceName,
                        topic: topic,
                        text: text
                    }
                };
            });

            await index.upsert(vectors);
            console.log(`تم رفع المتجهات الدفعة ${Math.floor(i / 50) + 1} لكتاب ${sourceName}`);
            
        } catch (error) {
            console.error(`خطأ حرج أثناء رفع المتجهات لكتاب ${sourceName}:`, error.message);
            process.exit(1); 
        }
    }
    console.log(`✅ انتهت مزامنة كتاب: ${sourceName}`);
}

async function main() {
    for (const file of filesToDelete) {
        if (file.includes('books/')) {
            await deleteBookVectors(file);
        }
    }

    for (const file of filesToProcess) {
        if (file.includes('books/') && (file.endsWith('.txt') || file.endsWith('.htm') || file.endsWith('.html'))) {
            await processBook(file);
        }
    }
}

main().catch(error => {
    console.error("فشل السكريبت بشدة:", error);
    process.exit(1);
});
