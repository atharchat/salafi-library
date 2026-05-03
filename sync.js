import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const indexName = process.env.PINECONE_INDEX_NAME || 'salafi-scholar';
const index = pc.index(indexName);

// دالة لمعالجة ورفع الكتاب
async function processFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  console.log(`جارِ معالجة: ${filePath}`);
  
  const text = fs.readFileSync(filePath, 'utf-8');
  // استخراج اسم الكتاب من اسم الملف (ويُفضل أن يكون اسم الملف هو اسم الكتاب لتسهيل الحذف اللاحق)
  let bookTitle = path.basename(filePath, path.extname(filePath));
  const topic = path.basename(path.dirname(filePath)); // مثلا: books/عقيدة/كتاب.html -> التخصص: عقيدة
  
  let chunks = [];
  if (filePath.endsWith('.html')) {
    const $ = cheerio.load(text);
    // إذا وجدنا عنواناً بداخله نأخذه، وإلا نستخدم اسم الملف
    bookTitle = $('title').first().text().trim() || bookTitle;
    
    $('.PageText').each((i, el) => {
      const pageTextDiv = $(el);
      const pageHead = pageTextDiv.find('.PageHead');
      const pageNumStr = pageHead.find('.PageNumber').text().replace(/[^\d١-٩]/g, '').trim(); 
      pageHead.remove(); 
      
      const pageText = pageTextDiv.text().replace(/\s+/g, ' ').trim();
      if (pageText) {
        chunks.push({
          id: crypto.randomUUID(),
          text: pageText,
          metadata: { source: bookTitle, topic: topic, page: pageNumStr || '' }
        });
      }
    });
  }

  if(chunks.length === 0) return;
  console.log(`تم التقسيم إلى ${chunks.length} صفحة. جار الرفع...`);
  
  const batchSize = 50;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    // استخراج البصمات (Embeddings)
    const embeddingsRes = await Promise.all(batch.map(c => 
      ai.models.embedContent({ model: "gemini-embedding-2", contents: c.text, config: { outputDimensionality: 768 } })
    ));
    
    const vectors = batch.map((c, idx) => ({
      id: c.id,
      values: embeddingsRes[idx].embeddings[0].values,
      metadata: { text: c.text, ...c.metadata }
    }));
    
    await index.upsert({ records: vectors });
    console.log(`تم رفع الدفعة ${i + batch.length} من ${chunks.length}`);
  }
}

// دالة לחذف الكتاب
async function removeFile(filePath) {
  // الاعتماد على اسم الملف لحذفه من باينكون
  const bookTitle = path.basename(filePath, path.extname(filePath));
  console.log(`حذف صفحات كتاب: ${bookTitle}`);
  try {
    await index.deleteMany({ filter: { source: { $eq: bookTitle } } });
    console.log(`تم الحذف بنجاح.`);
  } catch (error) {
    console.error("حدث خطأ أثناء الحذف:", error);
  }
}

// الدالة الأساسية التي تستلم أسماء الملفات التي تغيرت عبر Github
async function run() {
  const added = (process.env.ADDED_FILES || '').split(' ').filter(Boolean);
  const modified = (process.env.MODIFIED_FILES || '').split(' ').filter(Boolean);
  const deleted = (process.env.DELETED_FILES || '').split(' ').filter(Boolean);

  // 1. معالجة المحذوف
  for (const f of deleted) await removeFile(f);
  
  // 2. معالجة المُعدل (نحذفه القديم ثم نرفعه من جديد)
  for (const f of modified) {
    await removeFile(f); 
    await processFile(f);
  }
  
  // 3. معالجة المُضاف حديثاً
  for (const f of added) await processFile(f);
}

run().catch(console.error);
