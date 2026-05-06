import YahooFinance from 'yahoo-finance2';
import NodeCache from 'node-cache';
import { query } from '../db.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Her 60 saniyede bir cron/interval çalışacağı için verilerin eski kalması söz konusu değil.
// Ancak tam 60. saniyede cache temizlendiği an, API'den yanıt gelene kadar 1-2 saniye boşluk olabiliyor.
// API'den yeni veri geldiğinde zaten eski veriyi ezeceği için cache süresiz olarak ayarlandı.
const yahooCache = new NodeCache();

// Çekmek istediğimiz semboller
// const YAHOO_SYMBOLS = ['THYAO.IS', 'TRY=X', 'GC=F', 'AAPL'];

export const getYahooPrices = async () => {
    // 1. Önbellekte (cache) var mı diye kontrol et
    const cachedPrices = yahooCache.get('yahoo_prices');
    if (cachedPrices) {
        return cachedPrices;
    }

    // 2. Yoksa Yahoo'dan anlık olarak çek
    try {
        const dbAssets = await query('SELECT symbol FROM assets');
        const symbols = dbAssets.rows.map(row => row.symbol);

        // Formüllerin sağlıklı çalışması için USD/TRY kuru her ihtimale karşı zorunlu eklenir
        if (!symbols.includes('USDTRY=X') && !symbols.includes('TRY=X')) {
            symbols.push('TRY=X');
        }

        // XAUUSD=X Yahoo üzerinde spot piyasada düzgün dönmüyor. Bu yüzden garanti veren vadeli GC=F sembolü ile değiştirelim.
        const fetchSymbols = [...new Set(symbols.map(s => (s === 'XAUUSD=X' || s === 'XAU') ? 'GC=F' : s))];

        const quotes = await yahooFinance.quote(fetchSymbols);
        // Çekilen veriyi 180 saniye boyunca bellekte tut (isteğe bağlı süre devredilebilir)
        yahooCache.set('yahoo_prices', quotes, 180);
        console.log(`[Yahoo Servisi] Veriler On-Demand çekildi. Daha taze (${new Date().toLocaleTimeString('tr-TR')})`);
        return quotes;
    } catch (error) {
        console.error('[Yahoo Servisi Hatası]:', error.message);
        return [];
    }
};

export const getYahooCache = () => yahooCache;

export const getYahooChart = async (symbol, range = '1mo') => {
    // Cache anahtarını artık aralığa göre de ayırmalıyız
    const cacheKey = `chart_${symbol}_${range}`;
    const cachedData = yahooCache.get(cacheKey);

    if (cachedData) return cachedData;

    try {
        let period1;
        let interval = '1d'; // 1 ay ve üstü için günlük veri en iyisidir

        const now = Date.now();

        // Frontend'den gelen isteğe göre zamanı dinamik belirliyoruz
        if (range === '1d') {
            period1 = new Date(now - 24 * 60 * 60 * 1000);
            interval = '15m'; // 1 günlük grafikte 15 dakikalık mumlar/çizgiler
        } else if (range === '5d') {
            period1 = new Date(now - 5 * 24 * 60 * 60 * 1000);
            interval = '1h'; // 5 günlük grafikte 1 saatlik mumlar/çizgiler
        } else if (range === '1mo') {
            period1 = new Date(now - 30 * 24 * 60 * 60 * 1000);
        } else if (range === '3mo') {
            period1 = new Date(now - 90 * 24 * 60 * 60 * 1000);
        } else if (range === '6mo') {
            period1 = new Date(now - 180 * 24 * 60 * 60 * 1000);
        } else if (range === 'ytd') {
            period1 = new Date(new Date().getFullYear(), 0, 1);
        } else if (range === '1y') {
            period1 = new Date(now - 365 * 24 * 60 * 60 * 1000);
        } else if (range === '3y') {
            period1 = new Date(now - 3 * 365 * 24 * 60 * 60 * 1000);
        } else if (range === '5y') {
            period1 = new Date(now - 5 * 365 * 24 * 60 * 60 * 1000);
        }

        const chartData = await yahooFinance.chart(symbol, {
            period1: period1,
            interval: interval
        });

        // Veriyi belleğe kaydet (Grafik verisi çok sık değişmez, 5 dakika cache makuldür)
        yahooCache.set(cacheKey, chartData.quotes, 300);
        return chartData.quotes;
    } catch (error) {
        console.error(`[Yahoo Chart Hatası] ${symbol} için veri çekilemedi:`, error.message);
        return [];
    }
};

export const getYahooHistoricalPrice = async (symbol, dateStr) => {
    try {
        const dateObj = new Date(dateStr);
        const period1 = new Date(dateObj.getTime() - 4 * 24 * 60 * 60 * 1000);
        const period2 = new Date(dateObj.getTime() + 2 * 24 * 60 * 60 * 1000);
        
        const result = await yahooFinance.historical(symbol, {
            period1: period1,
            period2: period2,
            interval: '1d'
        });
        
        if (result && result.length > 0) {
            const targetTime = dateObj.getTime();
            let closestQuote = result[0];
            let minDiff = Math.abs(new Date(result[0].date).getTime() - targetTime);

            for (let i = 1; i < result.length; i++) {
                const diff = Math.abs(new Date(result[i].date).getTime() - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestQuote = result[i];
                }
            }
            return closestQuote.close;
        }
        return null;
    } catch (e) {
        console.error(`[Yahoo Historical Hatası] ${symbol} / ${dateStr}:`, e.message);
        return null;
    }
};

export const searchYahooSymbol = async (symbol) => {
    try {
        let quote = null;
        
        try {
            // Önce sembol olarak doğrudan sorgulamayı dene
            quote = await yahooFinance.quote(symbol);
            
            // Eğer quote tanımsız dönerse veya fiyatı yoksa hata fırlat ki isim aramasına geçsin
            if (!quote || quote.regularMarketPrice === undefined) {
                throw new Error("Sembol bulunamadı");
            }
        } catch (quoteError) {
            // Doğrudan bulunamazsa isim olarak aramaya geç (Fallback)
            // Yahoo'nun arama API'sindeki son değişikliklerden dolayı şema doğrulamasını (validation) devre dışı bırakıyoruz.
            const searchResults = await yahooFinance.search(symbol, {}, { validateResult: false });
            
            if (searchResults && searchResults.quotes && searchResults.quotes.length > 0) {
                // Arama sonuçlarından en alakalı olan ilk kaydın sembolünü al
                const foundSymbol = searchResults.quotes[0].symbol;
                // Bulunan sembol ile gerçek fiyatı ve detayları çek
                quote = await yahooFinance.quote(foundSymbol);
            } else {
                throw new Error("İsim araması için de sonuç bulunamadı.");
            }
        }

        if (quote && quote.regularMarketPrice !== undefined) {
            let localType = 'stock';
            const qType = (quote.quoteType || '').toUpperCase();
            if (qType === 'CRYPTOCURRENCY') localType = 'crypto';
            else if (qType === 'CURRENCY') localType = 'cash';
            else if (qType === 'ETF' || qType === 'MUTUALFUND') localType = 'finance';
            else if (qType === 'FUTURE' || qType === 'COMMODITY') localType = 'commodity';
            else if (qType === 'EQUITY') localType = 'stock';
            else if (qType === 'INDEX') localType = 'index';

            return {
                symbol: quote.symbol,
                name: quote.shortName || quote.longName || quote.symbol,
                price: quote.regularMarketPrice,
                changePercent: quote.regularMarketChangePercent || 0,
                asset_type: localType
            };
        }
        return null;
    } catch (e) {
        console.error(`[Yahoo Search Hatası] ${symbol}:`, e.message);
        return null;
    }
};