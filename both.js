const express = require('express');
const axios = require('axios');
const cors = require('cors');
const Parser = require('rss-parser');
const mysql = require('mysql2/promise');

const app = express();
const port = process.env.PORT || 3000;
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'media:content'],
      ['media:thumbnail', 'media:thumbnail'],
      ['enclosure', 'enclosure']
    ]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// API Configuration from environment variables
const DIFFBOT_API_TOKEN = process.env.DIFFBOT_API_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Database Connection from environment variables
const createDbConnection = async () => {
  return mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
};

// Fetch active RSS feeds with their category IDs from database
const fetchRSSFeeds = async (db) => {
    const [rows] = await db.query("SELECT rss_url, category_id FROM rss_feeds WHERE status = 1");
    return rows;
};

// Check if news is already processed
const isNewsProcessed = async (db, url) => {
    const [rows] = await db.query("SELECT source_link FROM blogs WHERE source_link = ?", [url]);
    return rows.length > 0;
};

// Function to check if news is from today
const isNewsFromToday = (pubDate) => {
    if (!pubDate) return false;
    
    const newsDate = new Date(pubDate);
    const today = new Date();
    
    return newsDate.getDate() === today.getDate() && 
           newsDate.getMonth() === today.getMonth() && 
           newsDate.getFullYear() === today.getFullYear();
};

/**
 * Extract media URL from RSS item
 * This function handles various ways RSS parsers may represent media content
 */
function extractMediaUrl(item) {
    let imageUrl = '';
    
    // Method 1: Check for media:content as direct property
    if (item['media:content']) {
        const mediaContent = item['media:content'];
        
        if (Array.isArray(mediaContent)) {
            // Find image in array of media content
            const imageMedia = mediaContent.find(media => 
                media.$ && (media.$.medium === 'image' || (media.$.type && media.$.type.startsWith('image/'))));
            
            if (imageMedia && imageMedia.$) {
                imageUrl = imageMedia.$.url;
            } else if (mediaContent[0] && mediaContent[0].$) {
                // Take first media content if no image type specified
                imageUrl = mediaContent[0].$.url;
            }
        } else if (mediaContent && mediaContent.$) {
            // Handle single media content object
            imageUrl = mediaContent.$.url;
        } else if (typeof mediaContent === 'object') {
            // Some parsers might flatten attributes
            imageUrl = mediaContent.url || mediaContent['@_url'] || '';
        }
    }
    
    // Method 2: Check for media namespace structure
    if (!imageUrl && item.media && item.media.content) {
        const mediaContent = item.media.content;
        if (Array.isArray(mediaContent)) {
            const media = mediaContent.find(m => 
                m.$ && (m.$.medium === 'image' || (m.$.type && m.$.type.startsWith('image/')))) || mediaContent[0];
            imageUrl = media && media.$ ? media.$.url : '';
        } else if (mediaContent && mediaContent.$) {
            imageUrl = mediaContent.$.url;
        }
    }
    
    // Method 3: Check for media:thumbnail
    if (!imageUrl && item['media:thumbnail']) {
        const thumbnail = item['media:thumbnail'];
        if (thumbnail && thumbnail.$) {
            imageUrl = thumbnail.$.url;
        } else if (typeof thumbnail === 'object') {
            imageUrl = thumbnail.url || thumbnail['@_url'] || '';
        }
    }
    
    // Method 4: Check for enclosure
    if (!imageUrl && item.enclosure) {
        if (Array.isArray(item.enclosure)) {
            const imageEnclosure = item.enclosure.find(e => 
                e.$ && e.$.type && e.$.type.startsWith('image/'));
            if (imageEnclosure && imageEnclosure.$) {
                imageUrl = imageEnclosure.$.url;
            }
        } else if (item.enclosure.$ && 
                  item.enclosure.$.type && 
                  item.enclosure.$.type.startsWith('image/')) {
            imageUrl = item.enclosure.$.url;
        } else if (typeof item.enclosure === 'object') {
            // Handle flattened attributes
            if (item.enclosure.type && item.enclosure.type.startsWith('image/')) {
                imageUrl = item.enclosure.url || '';
            }
        }
    }
    
    return imageUrl;
}

// Summarize content with retry logic for short summaries
async function summarizeContent(articleText, retryCount = 0) {
    try {
        let prompt;
        
        if (retryCount === 0) {
            // First attempt
            prompt = `Summarize the following news article **in exactly 60 words** (minimum 55, maximum 65).

            - Ensure the summary covers **who, what, where, when, and why**.
            - **Do not omit key details**—expand on critical aspects.
            - **No promotional text, opinions, or extra commentary**.
            - **Write in a neutral, factual tone**.
            - **No calls to action** (e.g., "subscribe for more", "read more on our website").
            - **Rephrase rather than shorten** if necessary.

            **Article:**\n\n${articleText}`;
        } else {
            // Retry with stronger emphasis on length requirement
            prompt = `I need a PRECISE summary of exactly 50-65 words for this news article. Your previous summary was too short.
            
            Please provide a more comprehensive summary that:
            - Captures the essential information (who, what, where, when, why)
            - Maintains factual accuracy and balanced tone
            - Uses complete sentences with proper context
            - MUST be between 50-65 words - this is critical
            
            **Article:**\n\n${articleText}`;
        }
        
        const summarizationResponse = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'meta-llama/llama-3.3-70b-instruct:free',
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            },
            { headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` } }
        );

        const summary = summarizationResponse.data.choices?.[0]?.message?.content?.trim();
        const wordCount = summary ? summary.split(/\s+/).length : 0;
        
        // If summary is too short and we haven't retried too many times
        if (summary && wordCount < 50 && retryCount < 4) {
            console.log(`Summary too short (${wordCount} words). Retrying...`);
            return summarizeContent(articleText, retryCount + 1);
        }
        
        return summary;
    } catch (error) {
        console.error('Summarization error:', error.message);
        return null;
    }
}

// Function to fetch and process news
const processNews = async (db, newsItem) => {
    try {
        if (await isNewsProcessed(db, newsItem.link)) {
            console.log('Skipping (already processed):', newsItem.link);
            return null;
        }

        // Skip if not today's news
        if (!isNewsFromToday(newsItem.pubDate)) {
            console.log('Skipping (not today\'s news):', newsItem.link);
            return null;
        }

        console.log('Processing:', newsItem.link);

        // Step 1: Extract full news content
        const diffbotResponse = await axios.get('https://api.diffbot.com/v3/article', {
            params: { url: newsItem.link, token: DIFFBOT_API_TOKEN }
        });

        const article = diffbotResponse.data.objects?.[0];
        if (!article || !article.text) {
            console.log('No article content found, skipping:', newsItem.link);
            return null;
        }

        // Step 2: Summarize news content with retry logic
        const summary = await summarizeContent(article.text);
        
        if (!summary || summary.split(/\s+/).length < 50) {
            console.log('Summarization failed or still too short after retries, skipping:', newsItem.link);
            return null;
        }

        // Step 3: Insert summarized news into database
        const insertQuery = `
            INSERT INTO blogs (type, title, description, source_img, source_name, source_link, created_by, status, pub_date) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await db.execute(insertQuery, [
            'post',                // type
            newsItem.title,        // title (from RSS feed)
            summary,               // description (final summarized text)
            newsItem.image,        // source_img (from RSS feed media:content)
            newsItem.source,       // source_name (from RSS feed)
            newsItem.link,         // source_link (from RSS feed)
            1,                     // created_by (admin user)
            1,                     // status (published)
            newsItem.pubDate       // pub_date (from RSS feed)
        ]);

        // Get the inserted blog ID
        const insertedBlogId = result.insertId;
        
        // Insert category relationship
        if (insertedBlogId && newsItem.categoryId) {
            await db.execute(
                "INSERT INTO blog_categories (blog_id, category_id, type) VALUES (?, ?, ?)", 
                [insertedBlogId, newsItem.categoryId, "category"]
            );
        }

        console.log(`✅ News inserted: "${newsItem.title}" with ID ${insertedBlogId} and category ${newsItem.categoryId}`);
        return insertedBlogId;

    } catch (error) {
        console.error('Processing error:', error.message);
        return null;
    }
};

// Fetch RSS feeds, extract news links, and process
const fetchAndProcessNews = async () => {
    const db = await createDbConnection();
    try {
        const rssFeeds = await fetchRSSFeeds(db);
        let newsLinks = [];
        
        for (const feed of rssFeeds) {
            try {
                const parsedFeed = await parser.parseURL(feed.rss_url);
                parsedFeed.items.forEach(item => {
                    // Extract image using the enhanced function
                    const imageUrl = extractMediaUrl(item);

                    newsLinks.push({ 
                        title: item.title, 
                        link: item.link, 
                        source: parsedFeed.title, 
                        image: imageUrl,
                        categoryId: feed.category_id, // Store category ID from RSS feed
                        pubDate: item.pubDate || new Date().toISOString()
                    });
                });
            } catch (error) {
                console.error(`Error fetching RSS from ${feed.rss_url}:`, error.message);
            }
        }

        console.log(`Found ${newsLinks.length} items from RSS feeds`);
        
        // Process only 3 items per run
        const itemsToProcess = Math.min(3, newsLinks.length);
        console.log(`Processing up to ${itemsToProcess} of today's news items`);
        
        let processedCount = 0;
        for (let i = 0; i < newsLinks.length && processedCount < itemsToProcess; i++) {
            const result = await processNews(db, newsLinks[i]);
            if (result !== null) {
                processedCount++;
                if (processedCount < itemsToProcess) {
                    await new Promise(resolve => setTimeout(resolve, 12000)); // 12 sec delay to respect API limit
                }
            }
        }
        
        console.log(`Completed processing ${processedCount} news items`);
        return processedCount;
    } finally {
        // Close the database connection
        await db.end();
    }
};

// API endpoint to trigger news processing (can be called from your Hostinger cron job)
app.get('/api/process-news', async (req, res) => {
    // Optional: Add a secret key check for security
    const secretKey = req.query.key;
    if (secretKey !== process.env.CRON_SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('Starting news processing...');
    try {
        const processedCount = await fetchAndProcessNews();
        return res.status(200).json({ 
            success: true, 
            message: `Successfully processed ${processedCount} news items.`
        });
    } catch (error) {
        console.error('Error in news processing:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// Keep the test endpoint for development
app.get('/test-news-processing', async (req, res) => {
    console.log('Fetching and processing news...');
    try {
        const processedCount = await fetchAndProcessNews();
        res.send(`News processing completed. Processed ${processedCount} items. Check console for output.`);
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Vercel serverless handler
module.exports = app;

// Only start the server if running directly (not importing as a module)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
    });
}