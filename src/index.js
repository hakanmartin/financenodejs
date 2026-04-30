import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { auth } from 'express-oauth2-jwt-bearer';

import { getYahooChart, getYahooHistoricalPrice, searchYahooSymbol, getYahooCache } from './services/yahooFinanceService.js';
import { getNormalizedPrices } from './services/normalizationService.js';
import { query } from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors());
app.use(express.json());

// Auth0 JWT Doğrulama Middleware'i
const jwtCheck = auth({
    audience: process.env.AUDIENCE,
    issuerBaseURL: process.env.ISSUER_BASE_URL,
    tokenSigningAlg: 'RS256'
});

// HERKESE AÇIK ENDPOINT (Sunucu testi için)
app.get('/', (req, res) => {
    res.json({ message: 'Finans Node.js API çalışıyor! 🚀' });
});

// HERKESE AÇIK ENDPOINT (Public)
app.get('/api/prices', async (req, res) => {
    const data = await getNormalizedPrices();

    if (data) {
        res.json({ success: true, data: data });
    } else {
        res.status(503).json({ success: false, message: 'Veriler henüz hazırlanıyor, lütfen bekleyin.' });
    }
});

// HERKESE AÇIK ENDPOINT: Tarihsel Grafik Verisi
app.get('/api/chart', jwtCheck, async (req, res) => {
    const { symbol, range } = req.query;

    if (!symbol) {
        return res.status(400).json({ success: false, message: 'Sembol gerekli.' });
    }

    try {
        const dbResult = await query('SELECT asset_type FROM assets WHERE symbol = $1', [symbol]);
        const isGold = dbResult.rows.length > 0 && dbResult.rows[0].asset_type === 'commodity';

        if (isGold || symbol === 'XAU' || symbol === 'XAUUSD=X') {
            const chartSymbol = 'GC=F';
            const quotes = await getYahooChart(chartSymbol, range || '1mo');
            const normalizedData = await getNormalizedPrices();
            const usdTryRate = normalizedData ? normalizedData.exchange_rate : 32.0;

            if (quotes && quotes.length > 0) {
                const modifier = usdTryRate / 31.1034768; // Ons'tan Gram'a ve USD'den TL'ye çevirici çarpan
                const gramQuotes = quotes.map(q => ({
                    ...q,
                    open: q.open ? q.open * modifier : null,
                    high: q.high ? q.high * modifier : null,
                    low: q.low ? q.low * modifier : null,
                    close: q.close ? q.close * modifier : null,
                }));
                return res.json({ success: true, data: gramQuotes });
            } else {
                return res.status(500).json({ success: false, message: 'Altın grafik verisi alınamadı.' });
            }
        }
    } catch (e) {
        // Veritabanı kapalıysa veya hata alırsak normal akışa devam et
        console.error("Altın grafik kontrolü hatası:", e);
    }

    const quotes = await getYahooChart(symbol, range || '1mo');

    if (quotes && quotes.length > 0) {
        res.json({ success: true, data: quotes });
    } else {
        res.status(500).json({ success: false, message: 'Grafik verisi alınamadı.' });
    }
});

// HERKESE AÇIK ENDPOINT: Sembol Arama (Yahoo Finance Üzerinden)
app.get('/api/search', jwtCheck, async (req, res) => {
    const { symbol } = req.query;

    if (!symbol) {
        return res.status(400).json({ success: false, message: 'Sembol gerekli.' });
    }

    try {
        const data = await searchYahooSymbol(symbol);
        if (data) {
            return res.json({ success: true, data });
        } else {
            return res.status(404).json({ success: false, message: 'Varlık bulunamadı.' });
        }
    } catch (e) {
        console.error("Arama hatası:", e);
        return res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// Tüm varlıkları getir (dropdown için)
app.get('/api/assets', jwtCheck, async (req, res) => {
    try {
        const result = await query('SELECT symbol, name, asset_type FROM assets ORDER BY asset_type, name');
        const dbAssets = result.rows;

        // Fiyatları da birleştirelim
        const normalizedData = await getNormalizedPrices();
        const prices = normalizedData ? normalizedData.assets : [];

        const merged = dbAssets.map(dbAsset => {
            const p = prices.find(priceObj =>
                priceObj.symbol === dbAsset.symbol ||
                priceObj.symbol === dbAsset.symbol.replace('.IS', '') ||
                priceObj.symbol + '.IS' === dbAsset.symbol ||
                (priceObj.type === 'commodity' && dbAsset.asset_type === 'commodity')
            );
            return {
                ...dbAsset,
                price_try: p ? p.price_try : 1,
                price_usd: p ? p.price_usd : 1
            };
        });

        res.json({ success: true, data: merged });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// HERKESE AÇIK ENDPOINT: Portföy Tarihsel Grafiği
app.get('/api/chart/portfolio', jwtCheck, async (req, res) => {
    const { email, range } = req.query;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email gerekli.' });
    }

    try {
        // Kullanıcının tüm portföy öğelerini ve history'sini çek
        const userResult = await query(
            `SELECT up.asset_symbol, a.asset_type, up.history 
             FROM user_portfolio up 
             JOIN users u ON up.user_id = u.id 
             JOIN assets a ON up.asset_symbol = a.symbol
             WHERE u.email = $1`,
            [email]
        );

        const portfolioItems = userResult.rows;

        if (portfolioItems.length === 0) {
            return res.json({ success: true, data: [] });
        }

        // Dolar kuru (Altın vb. hesaplamalar için)
        const normalizedData = await getNormalizedPrices();
        const usdTryRate = normalizedData ? normalizedData.exchange_rate : 32.0;
        const goldModifier = usdTryRate / 31.1034768;

        // Tüm sembollerin grafik verisini bağımsız olarak çek
        const chartPromises = portfolioItems.map(async (item) => {
            const isGold = item.asset_type === 'commodity' || item.asset_symbol === 'XAU' || item.asset_symbol === 'XAUUSD=X';
            const fetchSymbol = isGold ? 'GC=F' : item.asset_symbol;

            try {
                let quotes = await getYahooChart(fetchSymbol, range || '1mo');
                if (!quotes) quotes = [];

                if (isGold) {
                    quotes = quotes.map(q => ({
                        ...q,
                        open: q.open ? q.open * goldModifier : null,
                        high: q.high ? q.high * goldModifier : null,
                        low: q.low ? q.low * goldModifier : null,
                        close: q.close ? q.close * goldModifier : null,
                    }));
                }

                return { symbol: item.asset_symbol, quotes, history: item.history || [] };
            } catch (e) {
                console.error(`Grafik çekilemedi ${item.asset_symbol}:`, e);
                return { symbol: item.asset_symbol, quotes: [], history: item.history || [] };
            }
        });

        const assetsData = await Promise.all(chartPromises);

        // Tarih bazlı değerleri birleştir (her varlık için close * o tarihteki miktar)
        // İlk olarak tüm tarih havuzunu elde edelim
        const dateMap = new Map();

        assetsData.forEach(asset => {
            asset.quotes.forEach(quote => {
                if (!quote.date || quote.close === null) return;

                // Günü yyyy-mm-dd formatında al (zamanı yoksay)
                const qDate = new Date(quote.date).toISOString().split('T')[0];
                const timestamp = new Date(qDate).getTime();

                // O tarihte kullanıcının elinde o varlıktan ne kadar vardı hesaplayalım
                let quantityOnDate = 0;
                let foundAnyHistory = false;

                // History dizisi kronolojik sırayla olmalıdır
                asset.history.forEach(h => {
                    const hTime = new Date(h.date).getTime();
                    // Eğer işlem zamanı grafiğin gününden önce veya o gün içindeyse geçerlidir
                    if (hTime <= timestamp + 86400000) {
                        quantityOnDate = h.quantity;
                        foundAnyHistory = true;
                    }
                });

                // Eğer o tarihte varlık hiç eklenmemişse değere katmıyoruz
                if (!foundAnyHistory) quantityOnDate = 0;

                const valueAdd = quantityOnDate * quote.close;

                if (!dateMap.has(timestamp)) {
                    dateMap.set(timestamp, { date: quote.date, close: valueAdd });
                } else {
                    const existing = dateMap.get(timestamp);
                    existing.close += valueAdd;
                }
            });
        });

        // Map'i diziye çevirip tarihe göre sırala
        const finalChartData = Array.from(dateMap.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        // Miktarı 0 olan günleri baştan eleyip, ilk yatırım yaptıkları günden başlatabiliriz 
        const nonZeroStartData = finalChartData.filter(d => d.close > 0);

        if (nonZeroStartData.length > 0) {
            const firstValidIndex = finalChartData.findIndex(d => d.close > 0);
            const trimmedData = firstValidIndex !== -1 ? finalChartData.slice(firstValidIndex) : [];
            res.json({ success: true, data: trimmedData });
        } else {
            res.json({ success: true, data: [] });
        }

    } catch (e) {
        console.error("Portföy grafiği oluşturulurken hata:", e);
        res.status(500).json({ success: false, message: 'Portföy grafiği verisi alınamadı.' });
    }
});

// HERKESE AÇIK ENDPOINT: Portföy Varlıklarını Karşılaştırmalı Normallik (Normalize) Grafiği
app.get('/api/chart/portfolio/normalize', jwtCheck, async (req, res) => {
    const { email, range } = req.query;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email gerekli.' });
    }

    try {
        const userResult = await query(
            `SELECT up.asset_symbol, a.asset_type 
             FROM user_portfolio up 
             JOIN users u ON up.user_id = u.id 
             JOIN assets a ON up.asset_symbol = a.symbol
             WHERE u.email = $1 AND a.asset_type != 'cash'`,
            [email]
        );

        const portfolioItems = userResult.rows;

        if (portfolioItems.length === 0) {
            return res.json({ success: true, data: [] });
        }

        const normalizedData = await getNormalizedPrices();
        const usdTryRate = normalizedData ? normalizedData.exchange_rate : 32.0;
        const goldModifier = usdTryRate / 31.1034768;

        const chartPromises = portfolioItems.map(async (item) => {
            const isGold = item.asset_type === 'commodity' || item.asset_symbol === 'XAU' || item.asset_symbol === 'XAUUSD=X';
            const fetchSymbol = isGold ? 'GC=F' : item.asset_symbol;

            try {
                let quotes = await getYahooChart(fetchSymbol, range || '1mo');
                if (!quotes || quotes.length === 0) return null;

                if (isGold) {
                    // Yalnızca close'u çarpmak yeterli, normalize'da open, high, low kullanmıyoruz
                    quotes = quotes.map(q => ({
                        ...q,
                        close: q.close ? q.close * goldModifier : null,
                    }));
                }

                // Geçerli kapanışları filtrele
                const validQuotes = quotes.filter(q => q.close !== null && q.close !== undefined);
                if (validQuotes.length === 0) return null;

                const basePrice = validQuotes[0].close;

                // İlk gün 0% olmak üzere değişimi hesapla
                const normalizedQuotes = validQuotes.map(q => {
                    const percentage = ((q.close - basePrice) / basePrice) * 100;
                    return {
                        date: q.date,
                        close: percentage
                    };
                });

                return { symbol: item.asset_symbol, quotes: normalizedQuotes };
            } catch (e) {
                console.error(`Grafik çekilemedi ${item.asset_symbol}:`, e);
                return null;
            }
        });

        const assetsData = await Promise.all(chartPromises);
        const finalData = assetsData.filter(a => a !== null);

        res.json({ success: true, data: finalData });

    } catch (e) {
        console.error("Normalize portföy grafiği oluşturulurken hata:", e);
        res.status(500).json({ success: false, message: 'Normalize grafik verisi alınamadı.' });
    }
});

// Portföye varlık ekle / güncelle
app.post('/api/portfolio', jwtCheck, async (req, res) => {
    try {
        const { email, asset_symbol, quantity, purchase_date, asset_name, asset_type } = req.body;

        if (!email || !asset_symbol || quantity === undefined) {
            return res.status(400).json({ success: false, message: 'email, asset_symbol ve quantity gerekli.' });
        }

        // Önce user_id bul
        const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        const user_id = userResult.rows[0].id;

        // Varlığı on conflict do nothing ile destekle ki FK hatası çıkmasın
        const insertName = asset_name || asset_symbol;
        const insertType = asset_type || 'stock';
        await query(
            `INSERT INTO assets (symbol, name, asset_type) VALUES ($1, $2, $3) ON CONFLICT (symbol) DO NOTHING`,
            [asset_symbol, insertName, insertType]
        );

        // Her durumda (quantity <= 0 olsa bile) sıfır olarak güncelliyoruz ki tarihçesi kaybolmasın
        const finalQuantity = quantity < 0 ? 0 : quantity;
        const finalDate = purchase_date ? new Date(purchase_date).toISOString() : new Date().toISOString();

        await query(
            `INSERT INTO user_portfolio (user_id, asset_symbol, quantity, history)
             VALUES ($1, $2, $3, jsonb_build_array(jsonb_build_object('date', $4::text, 'quantity', $3::numeric)))
             ON CONFLICT (user_id, asset_symbol) 
             DO UPDATE SET 
                quantity = $3, 
                history = COALESCE(user_portfolio.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('date', $4::text, 'quantity', $3::numeric))`,
            [user_id, asset_symbol, finalQuantity, finalDate]
        );

        // Yeni asset eklenmiş olabileceği için önbelleği (cache) temizleyelim ki güncel fiyatlar yansısın
        const cache = getYahooCache();
        if (cache) cache.del('yahoo_prices');

        res.json({ success: true, message: 'Portföy güncellendi.' });
    } catch (error) {
        console.error("Add Portfolio error:", error);
        res.status(500).json({ success: false, message: error.message || 'Sunucu hatası' });
    }
});

// Kullanıcının portföyünü getir
app.get('/api/portfolio', jwtCheck, async (req, res) => {
    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email gerekli.' });
        }

        const result = await query(
            `SELECT up.asset_symbol, a.name, a.asset_type, up.quantity, up.history
             FROM user_portfolio up
             JOIN assets a ON up.asset_symbol = a.symbol
             JOIN users u ON up.user_id = u.id
             WHERE u.email = $1`,
            [email]
        );

        let portfolioData = result.rows;

        const normalizedData = await getNormalizedPrices();
        const usdTryRate = normalizedData ? normalizedData.exchange_rate : 32.0;
        const goldModifier = usdTryRate / 31.1034768;

        const enrichedData = await Promise.all(portfolioData.map(async (item) => {
            let priceAtAdd = null;
            if (item.history && item.history.length > 0 && item.asset_type !== 'cash') {
                const firstAddEntry = item.history.find(h => h.quantity > 0) || item.history[0];
                if (firstAddEntry) {
                    const isGold = item.asset_type === 'commodity' || item.asset_symbol === 'XAU' || item.asset_symbol === 'XAUUSD=X';
                    const fetchSymbol = isGold ? 'GC=F' : item.asset_symbol;

                    const historicalPriceRaw = await getYahooHistoricalPrice(fetchSymbol, firstAddEntry.date);
                    
                    if (historicalPriceRaw) {
                        if (isGold) {
                            priceAtAdd = historicalPriceRaw * goldModifier;
                        } else if (!item.asset_symbol.endsWith('.IS') && item.asset_symbol !== 'TRY=X' && item.asset_symbol !== 'USDTRY=X') {
                            // Kripto veya ABD Hissesi (USD ile fiyatlanıyor), bu nedenle o anki / şimdiki Dolar Kuru ile çarpıp TL'ye çeviriyoruz
                            priceAtAdd = historicalPriceRaw * usdTryRate;
                        } else {
                            priceAtAdd = historicalPriceRaw;
                        }
                    }
                }
            }
            
            delete item.history;
            return {
                ...item,
                priceAtAdd
            };
        }));

        res.json({ success: true, data: enrichedData });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// Portföy türüne göre varlıkları sil
app.delete('/api/portfolio/type', jwtCheck, async (req, res) => {
    try {
        const { email, asset_type } = req.query;

        if (!email || !asset_type) {
            return res.status(400).json({ success: false, message: 'Email ve asset_type gerekli.' });
        }

        const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        const user_id = userResult.rows[0].id;

        // Silmek yerine miktarı sıfırlıyoruz ve history ekliyoruz
        await query(
            `UPDATE user_portfolio 
             SET quantity = 0,
                 history = COALESCE(history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('date', CURRENT_TIMESTAMP, 'quantity', 0::numeric))
             WHERE user_id = $1 
             AND asset_symbol IN (SELECT symbol FROM assets WHERE asset_type = $2)`,
            [user_id, asset_type]
        );

        res.json({ success: true, message: 'Varlık türü başarıyla silindi.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// Tekil varlığı portföyden tamamen sil
app.delete('/api/portfolio/asset', jwtCheck, async (req, res) => {
    try {
        const { email, asset_symbol } = req.query;

        if (!email || !asset_symbol) {
            return res.status(400).json({ success: false, message: 'Email ve asset_symbol gerekli.' });
        }

        const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        const user_id = userResult.rows[0].id;

        await query(
            `DELETE FROM user_portfolio WHERE user_id = $1 AND asset_symbol = $2`,
            [user_id, asset_symbol]
        );

        res.json({ success: true, message: 'Varlık başarıyla silindi.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/sync-user', jwtCheck, async (req, res) => {
    try {
        console.log("SYNC HIT 🔥");

        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email gerekli.' });
        }

        await query(
            `INSERT INTO users (email) 
             VALUES ($1) 
             ON CONFLICT (email) DO NOTHING`,
            [email]
        );

        res.json({ success: true, message: 'Kullanıcı eklendi.' });

    } catch (error) {
        console.error('Kullanıcı senkronizasyon hatası:', error);
        res.status(500).json({ success: false });
    }
});

// Auth0 JWT Doğrulama Hatalarını Yakalama (JSON Dönmek İçin)
app.use((err, req, res, next) => {
    if (err.name === 'UnauthorizedError' || err.name === 'InvalidTokenError') {
        return res.status(401).json({ success: false, message: 'Geçersiz veya süresi dolmuş Auth0 tokeni.' });
    }
    next(err);
});

app.listen(PORT, () => {
    console.log(`Sunucu http://0.0.0.0:${PORT} portunda çalışıyor.`);
});
