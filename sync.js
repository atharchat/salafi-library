import fs from 'fs';
import * as cheerio from 'cheerio';
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import crypto from 'crypto'; // مكتبة مدمجة لتشفير المعرفات إلى أرقام وإنجليزي

dotenv.config();

// 1. إعداد الروابط والمفاتيح
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY1; 

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
    console.error("Missing API Keys: يرجى التأكد من إضافة أسرار Github.");
    process.exit(1);
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index("salafi-scholar");
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// استخراج الملفات عبر Action
const addedFiles = process.env.ADDED_FILES ? process.env.ADDED_FILES.split(' ') : [];
const modifiedFiles = process.env.MODIFIED_FILES ? process.env.MODIFIED_FILES.split(' ') : [];
const deletedFiles = process.env.DELETED_FILES ? process.env.DELETED_FILES.split(' ') : [];

const filesToProcess = [...addedFiles, ...modifiedFiles].filter(f => f.trim() !== '');
const filesToDelete = deletedFiles.filter(f => f.trim() !== '');

console.log("الملفات المطلوب مزامنتها:", filesToProcess);
console.log("الملفات المطلوب حذفها:", filesToDelete);

// دالة لتنظيف ملفات HTM و HTML
function parseContent(filePath, content) {
    if (filePath.endsWith('.htm') || filePath.endsWith('.html')) {
        const $ = cheerio.load(content);
        return $.text().replace(/\s+/g, ' ').trim(); 
    }
    return content;
}

// دالة تقسيم النص
function chunkText(text, chunkSize = 1500, overlap = 200) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        chunks.push(text.slice(i, i + chunkSize));
        i += chunkSize - overlap;
    }
    return chunks;
}

// معالجة حذف ملف
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

// معالجة رفع/تعديل ملف
async function processBook(filePath) {
    const parts = filePath.split('/');
    const topicFolder = parts.length > 1 ? parts[1].toLowerCase() : 'aqeedah';
    const fileName = parts[parts.length - 1];
    const sourceName = fileName.replace(/\.[^/.]+$/, "");

    // تحويل المجلد لاسم التخصص بالعربي ليخزن في Pinecone
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

    // حذف المتجهات السابقة لهذا الكتاب (لتفادي التكرار عند التعديل)
    await deleteBookVectors(filePath);

    if (!fs.existsSync(filePath)) {
        console.log(`الملف غير موجود محلياً (قد يكون تم حذفه): ${filePath}`);
        return;
    }

    const rawContent = fs.readFileSync(filePath, 'utf8');
    const textContent = parseContent(filePath, rawContent);
    const chunks = chunkText(textContent);

    console.log(`تم تقسيم الكتاب لـ: ${chunks.length} جزء (Chunk)`);

    // دفع المتجهات (Batches) لمراعاة نظام التسعير والآداء للذكاء
    for (let i = 0; i < chunks.length; i += 10) {
        const batchChunks = chunks.slice(i, i + 10);
        try {
            const vectors = await Promise.all(batchChunks.map(async (text, idx) => {
                const response = await ai.models.embedContent({
                    model: 'gemini-embedding-2',
                    contents: text,
                    config: { outputDimensionality: 768 }
                });
                
                // استخدام MD5 Hash لصناعة ID من حروف وأرقام إنجليزية فقط (يحل مشكلة الحروف العربية)
                const vectorId = crypto.createHash('md5').update(sourceName + "-chunk-" + (i + idx)).digest('hex');
                
                return {
                    id: vectorId,
                    values: response.embeddings[0].values,
                    metadata: {
                        source: sourceName,
                        topic: topic,
                        text: text
                    }
                };
            }));

            // استخدام الصيغة الجديدة الموافقة لمكتبة ^4.0.0
            await index.upsert({ records: vectors });
            console.log(`تم رفع الدفعة ${i / 10 + 1} لكتاب ${sourceName}`);
        } catch (error) {
            console.error(`خطأ أثناء رفع كتاب ${sourceName}:`, error.message);
        }
    }
    console.log(`✅ انتهت مزامنة كتاب: ${sourceName}`);
}

// التشغيل الأساسي
async function main() {
    // 1- تنفيذ الحذف للملفات الملغاة
    for (const file of filesToDelete) {
        if (file.startsWith('books/')) {
            await deleteBookVectors(file);
        }
    }

    // 2- معالجة الجديد والمُعَدّل
    for (const file of filesToProcess) {
        if (file.startsWith('books/') && (file.endsWith('.txt') || file.endsWith('.htm') || file.endsWith('.html'))) {
            await processBook(file);
        }
    }
}

main().catch(console.error);
