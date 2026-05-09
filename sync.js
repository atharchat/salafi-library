import fs from 'fs';
import * as cheerio from 'cheerio';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const PINECONE_API_KEY = process.env.PINECONE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY1 || ''; 

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
    console.error('Missing API Keys: يرجى التأكد من إضافة أسرار Github.');
    process.exit(1);
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index('salafi-scholar');

function parseFiles(envVar) {
    if (!envVar || envVar.trim() === '') return [];
    
    let cleaned = envVar.trim();
    
    // Remove wrapping array brackets if present
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        cleaned = cleaned.substring(1, cleaned.length - 1);
    }
    
    // Split by either comma or space
    const list = cleaned.split(/[\s,]+/);
    const parsed = list.map(function(f) {
        let s = f.trim();
        // Handle single or double quotes wrapping the filename
        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
            s = s.substring(1, s.length - 1);
        }
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
        
        // 1. Remove footnotes completely
        $('.footnote, .footnotes, .hashiya, .hasheya, .margnote, .notes, .commentary').remove();
        
        // In Shamela, footnotes are often separated by an <hr width="95">
        $('div.PageText').each(function() {
            let foundHr = false;
            $(this).contents().each(function() {
                if (foundHr) {
                    $(this).remove();
                } else if ((this.tagName === 'hr' || this.tagName === 'HR' || this.name === 'hr') && $(this).attr('width') == '95') {
                    foundHr = true;
                    $(this).remove();
                }
            });
        });
        
        $('.PageHead').remove();

        // 2. Remove Introductions and Indices
        let finalBlocks = [];
        let isSkipping = false;
        
        $('.PageText').each(function(index) {
            if (index === 0) return; // Skip metadata page

            let titles = [];
            $(this).find('.title, [data-type="title"]').each(function() {
                titles.push($(this).text().trim());
            });
            
            let isMuhaqqiqOrIndex = false;
            for (let t of titles) {
                t = t.replace(/[^ \u0600-\u06FF]/g, '').trim();
                const skipKeywords = ['مقدمة التحقيق', 'مقدمة المحقق', 'عملي في', 'ترجمة', 'فهرس', 'تقديم', 'المراجع', 'المصادر', 'فهارس', 'وصف المخطوط', 'الرموز'];
                for (const kw of skipKeywords) {
                    if (t.startsWith(kw) || t.includes('فهرس') || t.includes('المراجع') || t.includes('المصادر')) {
                        isMuhaqqiqOrIndex = true;
                        break;
                    }
                }
            }
            
            for (let t of titles) {
                t = t.replace(/[^ \u0600-\u06FF]/g, '').trim();
                if (t.match(/^(مقدمة المؤلف|كتاب|باب|فصل|القول)/)) {
                    isSkipping = false;
                }
            }

            if (isMuhaqqiqOrIndex) {
                isSkipping = true;
            } else if (titles.length > 0) {
                isSkipping = false;
            }
            
            let cleanText = $(this).text().replace(/[\u064B-\u065F]/g, '').trim();
            if (cleanText.match(/^(?:بسم لله|بسم الله|الحمد لله|قال المؤلف|أما بعد|أصول|حدثنا|أخبرنا|أخبرني|حدثني)/)) {
                isSkipping = false;
            }
            
            if (!isSkipping) {
                let text = $(this).text();
                // some extra footnote cleanups: remove lines starting with = or regex matches 
                text = text.replace(/\[\d+\]/g, ''); 
                text = text.replace(/\(\d+\)/g, ''); 
                text = text.replace(/^[([\s]*\d+[\s]*[)\]].*$/gm, '');
                text = text.replace(/^[\s]*=.*$/gm, '');
                text = text.replace(/\s+/g, ' ').trim();
                if (text.length > 0) {
                    finalBlocks.push(text);
                }
            }
        });
        
        return finalBlocks.join('\n\n');
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

    console.log("جاري حـذف الكتاب: " + sourceName + " من Pinecone...");
    try {
        await index.deleteMany({ source: sourceName });
        console.log("تم الحذف بنجاح (direct filter): " + sourceName);
    } catch (error) {
        // Fallback for older pinecone versions
        try {
            await index.deleteMany({ filter: { source: sourceName } });
            console.log("تم الحذف بنجاح (nested filter): " + sourceName);
        } catch (err2) {
            console.log("تخطي الحذف أو حدث خطأ: " + sourceName);
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
                        console.log('تم حظر المعدل (429 Rate Limit)، ننتظر 60 ثانية... (محاولة ' + (retries + 1) + ')');
                        await delay(60000);
                        retries++;
                        continue;
                    }
                    throw new Error(data.error.message);
                }
                
                if (!data.embeddings || data.embeddings.length !== batch.length) {
                    throw new Error('استجابة المتجهات غير صحيحة من جوجل.');
                }
                
                allEmbeddings.push(...data.embeddings.map(function(e){ return e.values; }));
                success = true;
                await delay(3000); // 3 seconds between batches
            } catch (err) {
                console.error("خطأ أثناء التضمين للدفعة " + i + ": ", err.message);
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
        console.log("تخطي: الملف غير موجود محلياً: " + filePath);
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

    console.log("\n📚 معالجة: " + sourceName + " (" + topic + ")");

    // Ensure older segments are deleted first
    await deleteBookVectors(filePath);

    const rawContent = fs.readFileSync(filePath, 'utf8');
    const textContent = parseContent(filePath, rawContent);
    const chunks = chunkText(textContent);

    if (chunks.length === 0) {
        console.log("تحذير: لا يوجد محتوى نصي لرفعه في " + sourceName);
        return;
    }

    console.log(">> تقسيم الكتاب لـ: " + chunks.length + " جزء. جاري إنشاء المتجهات...");
    const valuesArray = await embedChunksWithRetry(chunks, 90);
    
    console.log(">> جاري الرفع إلى Pinecone...");
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

            // Pinecone Upsert handling version differences
            try {
                await index.upsert(vectors); // newest syntax
            } catch (err) {
                if (err.message && err.message.includes('at least')) {
                    await index.upsert({ records: vectors }); // older wrapper syntax
                } else {
                    throw err;
                }
            }
            console.log("   تم رفع المتجهات " + (i+1) + " إلى " + (i + batchChunks.length));
        } catch (error) {
            console.error("خطأ خطير أثناء الرفع لدفعة " + sourceName + ":", error.message);
            process.exit(1); 
        }
    }
    console.log("✅ انتهت المزامنة بنجاح: " + sourceName);
}

async function main() {
    if (deletedFiles.length === 0 && filesToProcess.length === 0) {
        console.log('لا يوجد شيء للقيام به.');
        return;
    }

    for (const file of deletedFiles) {
        if (file.includes('books/')) {
            // Need to make sure file isn't undefined
            await deleteBookVectors(file);
        }
    }

    for (const file of filesToProcess) {
        if (file && file.includes('books/') && (file.endsWith('.txt') || file.endsWith('.htm') || file.endsWith('.html'))) {
            await processBook(file);
        }
    }
}

main().catch(function(error) {
    console.error('❌ توقف السكربت بسبب خطأ غير متوقع:', error);
    process.exit(1);
});
