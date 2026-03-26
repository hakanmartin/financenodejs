import { getYahooPrices } from './yahooFinanceService.js';

export const getNormalizedPrices = async () => {
    const yahooData = await getYahooPrices();

    if (!yahooData || yahooData.length === 0) {
        return null;
    }

    // 1. Güncel Dolar Kurunu Bul
    const usdTryItem = yahooData.find(item => item.symbol === 'TRY=X' || item.symbol === 'USDTRY=X');
    const usdTryRate = usdTryItem ? usdTryItem.regularMarketPrice : 32.00;

    const normalizedPortfolio = [];

    yahooData.forEach(quote => {
        const sym = quote.symbol;

        // Döviz (USDTRY=X veya TRY=X) ise 1 Birimi = USD Cinsinden 1 kabul edip TRY karşılığını aktaralım
        if (sym === 'TRY=X' || sym === 'USDTRY=X') {
            normalizedPortfolio.push({
                symbol: sym,
                name: quote.shortName || sym,
                type: 'currency',
                price_usd: 1, // 1 USD
                price_try: usdTryRate
            });
            return;
        }

        // BIST Hisseleri
        if (sym.endsWith('.IS')) {
            const priceTry = quote.regularMarketPrice;
            normalizedPortfolio.push({
                symbol: sym, // .IS silinmiyor ki DB ile sorunsuz eşleşsin
                name: quote.shortName || sym,
                type: 'stock',
                price_usd: priceTry / usdTryRate, // TL'den USD'ye çeviriyoruz
                price_try: priceTry
            });
            return;
        }

        // Altın Emmtiaları (GC=F, XAUUSD=X vb.) 
        if (sym === 'GC=F' || sym === 'XAUUSD=X' || sym === 'XAU') {
            const ounceUsd = quote.regularMarketPrice;
            const gramUsd = ounceUsd / 31.1034768; // ONS -> Gram
            normalizedPortfolio.push({
                symbol: sym,
                name: 'Gram Altın',
                type: 'commodity',
                price_usd: gramUsd,
                price_try: gramUsd * usdTryRate
            });
            return;
        }

        // Geriye kalanlar ABD Hissesidir ya da Kriptodur (Örn. BTC-USD, AAPL)
        const priceUsd = quote.regularMarketPrice;
        normalizedPortfolio.push({
            symbol: sym,
            name: quote.shortName || sym,
            type: 'generic_usd_asset',
            price_usd: priceUsd,
            price_try: priceUsd * usdTryRate
        });
    });

    return {
        exchange_rate: usdTryRate,
        assets: normalizedPortfolio
    };
};