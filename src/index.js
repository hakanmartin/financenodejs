import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { auth } from 'express-oauth2-jwt-bearer';

import { getYahooChart } from './services/yahooFinanceService.js';
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

// Portföye varlık ekle / güncelle
app.post('/api/portfolio', jwtCheck, async (req, res) => {
    try {
        const { email, asset_symbol, quantity } = req.body;

        if (!email || !asset_symbol || quantity === undefined) {
            return res.status(400).json({ success: false, message: 'email, asset_symbol ve quantity gerekli.' });
        }

        // Önce user_id bul
        const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        const user_id = userResult.rows[0].id;

        if (quantity <= 0) {
            // Sıfır veya negatifse sil
            await query(
                'DELETE FROM user_portfolio WHERE user_id = $1 AND asset_symbol = $2',
                [user_id, asset_symbol]
            );
        } else {
            // Varsa güncelle, yoksa ekle
            await query(
                `INSERT INTO user_portfolio (user_id, asset_symbol, quantity)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, asset_symbol) 
                 DO UPDATE SET quantity = $3`,
                [user_id, asset_symbol, quantity]
            );
        }

        res.json({ success: true, message: 'Portföy güncellendi.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
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
            `SELECT up.asset_symbol, a.name, a.asset_type, up.quantity
             FROM user_portfolio up
             JOIN assets a ON up.asset_symbol = a.symbol
             JOIN users u ON up.user_id = u.id
             WHERE u.email = $1`,
            [email]
        );

        res.json({ success: true, data: result.rows });
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

        await query(
            `DELETE FROM user_portfolio 
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
    console.log(`Sunucu http://localhost:${PORT} portunda çalışıyor.`);
});
