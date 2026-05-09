// [مهم] هذا الملف يستخدم لمزامنة الكتب من وإلى قاعدة البيانات بصيغة المتجهات Pinecone 
// يتم استدعاؤه سواء في السيرفر أو عبر الـ Github Actions
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { Pinecone } from '@pinecone-database/pinecone';
import * as cheerio from 'cheerio';

const TOPICS = ["عقيدة", "تفسير", "حديث", "فقه", "سيرة وتراجم", "تاريخ", "General"];

function parseFiles(envVar) {
    if (!envVar || envVar.trim() === '') return [];
    
    let cleaned = envVar.trim();
    
    // Remove wrapping array brackets if present
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        cleaned = cleaned.substring(1, cleaned.length - 1);
    }
    
    // Match quoted strings or non-space words
    const list = cleaned.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    
    const parsed = list.map(function(f) {
        let s = f.trim();
        // Handle single or double quotes wrapping the filename
        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
            s = s.substring(1, s.length - 1);
        }
        
        let bytes = [];
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '\\' && i + 3 < s.length && /[0-7]{3}/.test(s.substring(i+1, i+4))) {
                bytes.push(parseInt(s.substring(i+1, i+4), 8));
                i += 3;
            } else {
                bytes.push(s.charCodeAt(i));
            }
        }
        return Buffer.from(bytes).toString('utf8');
    }).filter(function(f) { return f !== ''; });
    
    return parsed;
}

function parseContent(filePath, content) {
    if (filePath.endsWith('.htm') || filePath.endsWith('.html')) {
        const $ = cheerio.load(content);
        
        $('.footnote, .footnotes, .hashiya, .hasheya, .margnote, .notes, .commentary').remove();
        
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

        let finalBlocks = [];
        let isSkipping = false;
        
        $('.PageText').each(function(index) {
            if (index === 0) return;

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
                text = text.replace(/\[\d+\]/g, ''); 
                text = text.replace(/\(\d+\)/g, ''); 
                text = text.replace(/^([\s]*\d+[\s]*[)\]])/gm, '');
                text = text.replace(/^[\s]*=.*/gm, '');
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

function chunkText(text) {
    const maxWords = 700;
    const overlap = 70;
    const blocks = text.split('\n\n').filter(b => b.trim() !== '');
    const chunks = [];
    
    let currentChunkWords = [];
    
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockWords = block.split(/\s+/);
        
        if (currentChunkWords.length + blockWords.length <= maxWords) {
            currentChunkWords = currentChunkWords.concat(blockWords);
        } else {
            if (currentChunkWords.length > 0) {
                chunks.push(currentChunkWords.join(' '));
                const overlapWords = currentChunkWords.slice(-overlap);
                currentChunkWords = overlapWords.concat(blockWords);
            } else {
                let currentPos = 0;
                while (currentPos < blockWords.length) {
                    const chunkPart = blockWords.slice(currentPos, currentPos + maxWords);
                    chunks.push(chunkPart.join(' '));
                    currentPos += maxWords - overlap;
                }
                if (chunks.length > 0) {
                    const lastChunk = chunks[chunks.length - 1].split(/\s+/);
                    currentChunkWords = lastChunk.slice(-overlap);
                }
            }
        }
    }
    
    if (currentChunkWords.length > 0) {
        chunks.push(currentChunkWords.join(' '));
    }
    
    return chunks;
}

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = "knowledge-base";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;

if (!PINECONE_API_KEY || !GEMINI_API_KEY) {
    console.error("يرجى التأكد من توفر PINECONE_API_KEY و GEMINI_API_KEY في المتغيرات البيئية.");
    process.exit(1);
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.Index(PINECONE_INDEX_NAME);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function embedChunksWithRetry(chunks, maxConcurrent = 100) {
    let results = new Array(chunks.length);
    let activePromises = [];
    
    for (let i = 0; i < chunks.length; i++) {
        const p = (async () => {
            let retries = 0;
            const maxRetries = 5;
            let delay = 2000;
            while (retries < maxRetries) {
                try {
                    const response = await ai.models.embedContent({
                        model: 'text-embedding-004',
                        contents: chunks[i],
                    });
                    results[i] = response.embeddings[0].values;
                    break;
                } catch (error) {
                    if (error.message && (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED'))) {
                        retries++;
                        console.log(`[Rate Limit] تأخير ${delay}ms وإعادة المحاولة للجزء ${i}...`);
                        await new Promise(res => setTimeout(res, delay));
                        delay *= 2;
                    } else {
                        throw error;
                    }
                }
            }
        })();
        
        activePromises.push(p);
        
        if (activePromises.length >= maxConcurrent) {
            await Promise.race(activePromises);
            activePromises = activePromises.filter(p => {
                const inspect = process.binding('util').getPromiseDetails(p);
                return inspect[0] === 0; // 0 = pending
            });
        }
    }
    
    await Promise.all(activePromises);
    return results;
}

async function handleAddedOrModified(filePath) {
    console.log(`> جاري البدء بمعالجة: ${filePath}`);
    const sourceName = path.basename(filePath);
    let topic = "General";
    
    const parts = filePath.split('/');
    if (parts.length > 2 && parts[0] === 'books') {
        const t = parts[1];
        const topicMap = {
            "aqeedah": "عقيدة",
            "tafsir": "تفسير",
            "hadeeth": "حديث",
            "fiqh": "فقه",
            "seerah": "سيرة وتراجم",
            "history": "تاريخ"
        };
        topic = topicMap[t] || "General";
    }

    const rawContent = fs.readFileSync(filePath, 'utf8');
    const textContent = parseContent(filePath, rawContent);
    const chunks = chunkText(textContent);

    let arabicTitle = sourceName;
    if (filePath.endsWith('.htm') || filePath.endsWith('.html')) {
        const cheerio = await import('cheerio');
        const $ = cheerio.load(rawContent);
        const parsedTitle = $('title').first().text().trim();
        if (parsedTitle && parsedTitle.length > 0) {
            arabicTitle = parsedTitle;
        }
    }

    if (chunks.length === 0) {
        console.log("تحذير: لا يوجد محتوى نصي لرفعه في " + sourceName);
        return;
    }

    console.log(">> تقسيم الكتاب لـ: " + chunks.length + " جزء. جاري إنشاء المتجهات...");
    const valuesArray = await embedChunksWithRetry(chunks, 90);
    
    console.log(">> جاري الرفع إلى Pinecone المسمى: " + arabicTitle + "...");
    for (let i = 0; i < chunks.length; i += 50) {
        const batchChunks = chunks.slice(i, i + 50);
        const batchValues = valuesArray.slice(i, i + 50);
        
        const vectors = batchChunks.map((text, idx) => {
            const vals = batchValues[idx];
            return {
                id: `${sourceName}-chunk-${i + idx}`,
                values: vals,
                metadata: {
                    source: sourceName,
                    book_title: arabicTitle,
                    topic: topic,
                    text: text
                }
            };
        });
        
        await index.upsert(vectors);
    }
    console.log(`تم رفع ${filePath} بنجاح.`);
}

async function handleDeleted(filePath) {
    const sourceName = path.basename(filePath);
    console.log(`> جاري حذف المتجهات المرتبطة بـ: ${sourceName}`);
    
    try {
        let hasMore = true;
        let totalDeleted = 0;
        
        while (hasMore) {
            const queryResponse = await index.query({
                topK: 100,
                vector: new Array(768).fill(0), // Dummy vector
                filter: { "source": { "$eq": sourceName } },
                includeMetadata: false
            });
            
            if (queryResponse.matches.length === 0) {
                hasMore = false;
            } else {
                const idsToDelete = queryResponse.matches.map(m => m.id);
                await index.deleteMany(idsToDelete);
                totalDeleted += idsToDelete.length;
            }
        }
        
        console.log(`تم حذف ${totalDeleted} متجه من كتاب ${sourceName} بنجاح.`);
    } catch (error) {
         console.error("خطأ أثناء الحذف:", error);
    }
}

async function main() {
    console.log("============= بدء المزامنة =============");
    const addedStr = process.env.ADDED_FILES || "";
    const modifiedStr = process.env.MODIFIED_FILES || "";
    const deletedStr = process.env.DELETED_FILES || "";

    const added = parseFiles(addedStr);
    const modified = parseFiles(modifiedStr);
    const deleted = parseFiles(deletedStr);

    console.log("الملفات المطلوب رفعها:", [...added, ...modified]);
    console.log("الملفات المطلوب حذفها:", deleted);
    console.log("========================================");

    if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
        console.log("لا يوجد شيء للقيام به.");
        return;
    }

    // Handle deleted files
    for (const f of deleted) {
        if(f.startsWith("books/")) {
             await handleDeleted(f);
        }
    }

    // Handle added/modified
    const toUpload = [...added, ...modified];
    for (const f of toUpload) {
        if (f.startsWith("books/")) {
            if (fs.existsSync(f)) {
                 await handleDeleted(f); // delete old vectors first if modified
                 await handleAddedOrModified(f);
            } else {
                 console.log("الملف غير موجود " + f + " قد يكون تم حذفه.");
            }
        }
    }
    console.log("============= اكتملت المزامنة =============");
}

main().catch(console.error);
