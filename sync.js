import fs from 'fs';
import path from 'path';
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import * as cheerio from 'cheerio';

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
  console.error("Missing API keys! Please set them in GitHub Secrets.");
  process.exit(1);
}

// الاتصال بقواعد البيانات
const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index("salafi-scholar"); // تأكد أن اسم الـ index مطابق لما لديك في Pinecone
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// استلام الملفات المعدلة والمحذوفة من GitHub Actions (مفصولة بعلامة | لتفادي مشاكل المسافات في أسماء الملفات)
const addedModified = process.env.ADDED_MODIFIED ? process.env.ADDED_MODIFIED.split('|').filter(Boolean) : [];
const deleted = process.env.DELETED ? process.env.DELETED.split('|').filter(Boolean) : [];

// دالة لتنظيف ملفات HTM/HTML وتحويلها لنص صافي
function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $('script, style').remove(); // إزالة أي أكواد
  let text = $('body').text() || $.text();
  // تنظيف المسافات الزائدة
  return text.replace(/\s+/g, ' ').trim();
}

// دالة تقسيم النص إلى فقرات (Chunking)
function chunkText(text, chunkSize = 500) {
  const words = text.split(' ');
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  return chunks;
}

// معالجة ملف تمت إضافته أو تعديله
async function processFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const fileName = path.basename(filePath, path.extname(filePath)); // اسم الكتاب بدون امتداد
  const ext = path.extname(filePath).toLowerCase();
  const topic = path.basename(path.dirname(filePath)); // المجلد الداخلي مثل aqeedah

  console.log(`جارِ معالجة الكتاب: ${fileName}`);
  let content = fs.readFileSync(filePath, 'utf-8');
  
  if (ext === '.htm' || ext === '.html') {
    content = extractTextFromHtml(content);
  }

  // حذف أجزاء الكتاب القديمة أولاً في حال كان هذا تعديلاً لكتاب موجود
  await index.deleteMany({ filter: { source: { $eq: fileName } } }).catch(() => {});

  const chunks = chunkText(content);
  console.log(`تم تقسيم الكتاب إلى ${chunks.length} جزء.`);

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${fileName}_chunk_${i}`;
    const textChunk = chunks[i];
    
    try {
      const response = await ai.models.embedContent({
        model: 'text-embedding-004',
        contents: textChunk,
      });
      const embedding = response.embeddings[0].values;

      await index.upsert([{
        id: chunkId,
        values: embedding,
        metadata: {
          text: textChunk,
          source: fileName,
          topic: topic
        }
      }]);
      console.log(`- تم رفع الجزء ${i+1}/${chunks.length}`);
    } catch (e) {
      console.error(`حدث خطأ أثناء رفع الجزء ${i} للكتاب ${fileName}:`, e.message);
    }
  }
}

// معالجة ملف تم حذفه
async function deleteFile(filePath) {
  const fileName = path.basename(filePath, path.extname(filePath));
  console.log(`جارِ حذف الكتاب من Pinecone: ${fileName}`);
  try {
    await index.deleteMany({ filter: { source: { $eq: fileName } } });
    console.log(`تم الحذف بنجاح.`);
  } catch (e) {
    console.warn(`فشل الحذف:`, e.message);
  }
}

// الدالة الرئيسية
async function main() {
  console.log("الملفات المضافة:", addedModified);
  console.log("الملفات المحذوفة:", deleted);

  for (const file of deleted) {
    if (file && file.startsWith('books/')) await deleteFile(file);
  }

  for (const file of addedModified) {
    if (file && file.startsWith('books/')) await processFile(file);
  }
}

main().catch(console.error);
