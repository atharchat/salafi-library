import fs from 'fs';
import * as cheerio from 'cheerio';
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY1; 

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
    console.error("Missing API Keys: يرجى التأكد من إضافة أسرار Github.");
    process.exit(1); // إغلاق النظام مع رمز خطأ ليعرف Github أن العملية فشلت
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index("salafi-scholar");
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
        chunks.push(text.slice(i, i + chunkSize));
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
        await index.deleteMany({ filter: { source: { $eq: sourceName } } });
        console.log(`تم الحذف بنجاح: ${sourceName}`);
    } catch (error) {
        console.log(`لم يتم العثور على أجزاء لحذفها، أو حدث خطأ: ${sourceName}`, error.message);
    }
}

// دالة تأخير لمنع تجاوز معدل API
const delay = ms => new Promise(res => setTimeout(res, ms));

async function processBook(filePath) {
    const parts = filePath.split('/');
    const topicFolder = parts.length > 1 ? parts[1].toLowerCase() : 'aqeedah';
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

    for (let i = 0; i < chunks.length; i += 10) {
        const batchChunks = chunks.slice(i, i + 10);
        try {
            // استخدام قدرة Gemini على تضمين مصفوفة كاملة في طلب واحد بدلاً من 10 طلبات متوازية
            const response = await ai.models.embedContent({
                model: 'gemini-embedding-2',
                contents: batchChunks, 
                config: { outputDimensionality: 768 }
            });
            
            const vectors = batchChunks.map((text, idx) => {
                const vectorId = crypto.createHash('md5').update(sourceName + "-chunk-" + (i + idx)).digest('hex');
                return {
                    id: vectorId,
                    values: response.embeddings[idx].values,
                    metadata: {
                        source: sourceName,
                        topic: topic,
                        text: text
                    }
                };
            });

            await index.upsert(vectors); // في Pinecone ^4.0.0 نضع المصفوفة مباشرة هكذا
            console.log(`تم رفع الدفعة ${i / 10 + 1} لكتاب ${sourceName}`);
            
            // إيقاف مؤقت لمدة 4.5 ثوانٍ لتفادي تجاوز حد 15 طلب في الدقيقة للـ Free Tier
            await delay(4500); 

        } catch (error) {
            console.error(`خطأ حرج أثناء رفع كتاب ${sourceName}:`, error.message);
            process.exit(1); // إغلاق النظام مع رمز خطأ ليعرف Github ويفشل علنياً
        }
    }
    console.log(`✅ انتهت مزامنة كتاب: ${sourceName}`);
}

async function main() {
    for (const file of filesToDelete) {
        if (file.startsWith('books/')) {
            await deleteBookVectors(file);
        }
    }

    for (const file of filesToProcess) {
        if (file.startsWith('books/') && (file.endsWith('.txt') || file.endsWith('.htm') || file.endsWith('.html'))) {
            await processBook(file);
        }
    }
}

main().catch(error => {
    console.error("فشل السكريبت:", error);
    process.exit(1);
});
