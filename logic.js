require('dotenv').config();
const axios = require('axios');

function getAssetContext(market) {
    const mapping = {
        'KRW-BTC': { symbol: 'BTC', english: 'bitcoin', korean: '비트코인' },
        'KRW-ETH': { symbol: 'ETH', english: 'ethereum', korean: '이더리움' },
        'KRW-XRP': { symbol: 'XRP', english: 'ripple', korean: '리플' }
    };
    if (mapping[market]) return mapping[market];

    const symbol = market.replace('KRW-', '');
    return {
        symbol,
        english: `${symbol.toLowerCase()} crypto`,
        korean: `${symbol} 코인`
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function calculateEMA(values, period) {
    if (!values.length) return null;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i += 1) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return null;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i += 1) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i += 1) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? Math.abs(diff) : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(chartData, period = 14) {
    if (!chartData || chartData.length < period + 1) return null;
    const trs = [];

    for (let i = 1; i < chartData.length; i += 1) {
        const current = chartData[i];
        const prev = chartData[i - 1];
        const tr = Math.max(
            current.high - current.low,
            Math.abs(current.high - prev.close),
            Math.abs(current.low - prev.close)
        );
        trs.push(tr);
    }

    const slice = trs.slice(-period);
    return slice.reduce((sum, n) => sum + n, 0) / period;
}

// 1. Tavily를 이용한 실시간 뉴스 수집
async function getCryptoNews(market = 'KRW-BTC') {
    try {
        const asset = getAssetContext(market);
        const response = await axios.post('https://api.tavily.com/search', {
            api_key: process.env.TAVILY_API_KEY,
            query: `latest ${asset.english} (${asset.symbol}) price movement news and crypto market sentiment`,
            search_depth: "advanced",
            max_results: 5
        });
        
        // 검색 결과들을 하나의 문자열로 합침
        return response.data.results.map(r => r.content).join('\n---\n');
    } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data || error.message;
        console.error(`❌ 뉴스 수집 실패(${market}):`, status, detail);
        return "뉴스를 가져오지 못했습니다.";
    }
}

// 2. 업비트 OHLCV(1시간봉) 수집
async function getChartData(market = 'KRW-BTC') {
    try {
        const candleUnit = Number(process.env.CHART_CANDLE_UNIT_MINUTES || 60);
        const count = Number(process.env.CHART_CANDLE_COUNT || 48);

        const response = await axios.get(`https://api.upbit.com/v1/candles/minutes/${candleUnit}`, {
            params: { market, count }
        });

        // 업비트 캔들은 최신순이라 과거 -> 현재 순으로 뒤집어 둔다.
        return response.data.reverse().map((c) => ({
            time: c.candle_date_time_kst,
            open: c.opening_price,
            high: c.high_price,
            low: c.low_price,
            close: c.trade_price,
            vol: c.candle_acc_trade_volume
        }));
    } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data || error.message;
        console.error(`❌ 차트 데이터 수집 실패(${market}):`, status, detail);
        return [];
    }
}

// 3. 차트 기반 기술적 신호 계산
function getTechnicalSignal(chartData) {
    if (!chartData || chartData.length < 30) {
        return {
            decision: 'HOLD',
            confidence: 0,
            trend: 'unknown',
            breakout: false,
            breakdown: false,
            rsi: null,
            ema20: null,
            ema50: null,
            atr: null,
            reason: '차트 데이터가 부족하여 기술 신호를 계산할 수 없습니다.'
        };
    }

    const closes = chartData.map((c) => c.close);
    const volumes = chartData.map((c) => c.vol);

    const latest = chartData[chartData.length - 1];
    const ema20 = calculateEMA(closes.slice(-20), 20);
    const ema50 = calculateEMA(closes.slice(-50), 50);
    const rsi = calculateRSI(closes, 14);
    const atr = calculateATR(chartData, 14);

    const lookback = chartData.slice(-21, -1);
    const prevHigh = Math.max(...lookback.map((c) => c.high));
    const prevLow = Math.min(...lookback.map((c) => c.low));

    const volWindow = volumes.slice(-20);
    const volAvg20 = volWindow.reduce((sum, n) => sum + n, 0) / volWindow.length;
    const volSpike = latest.vol > volAvg20 * 1.2;

    const trend = ema20 > ema50 ? 'up' : 'down';
    const breakout = latest.close > prevHigh;
    const breakdown = latest.close < prevLow;

    let score = 50;
    if (trend === 'up') score += 15;
    if (trend === 'down') score -= 15;
    if (breakout) score += 15;
    if (breakdown) score -= 15;
    if (volSpike && breakout) score += 10;
    if (rsi !== null && rsi >= 75) score -= 12;
    if (rsi !== null && rsi <= 30) score += 8;
    if (rsi !== null && rsi >= 45 && rsi <= 65) score += 6;

    const confidence = clamp(Math.round(Math.abs(score - 50) * 2), 0, 100);

    let decision = 'HOLD';
    if (score >= 62) decision = 'BUY';
    else if (score <= 38) decision = 'SELL';

    return {
        decision,
        confidence,
        trend,
        breakout,
        breakdown,
        rsi: rsi === null ? null : Number(rsi.toFixed(2)),
        ema20: Number(ema20.toFixed(2)),
        ema50: Number(ema50.toFixed(2)),
        atr: atr === null ? null : Number(atr.toFixed(2)),
        volSpike,
        latestClose: latest.close,
        reason: `trend=${trend}, breakout=${breakout}, breakdown=${breakdown}, rsi=${rsi?.toFixed(2)}`
    };
}

// 4. 뉴스 + 차트 + 기술지표를 함께 Gemini에 전달
async function requestGeminiSingleModel(payload) {
    const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const response = await axios.post(url, payload, { timeout: 25000 });
    console.log(`✅ Gemini 모델 사용(단일): ${model}`);
    return response;
}

async function getAIDecision(currentPrice, news, chartData, technicalSignal, market = 'KRW-BTC') {
    const asset = getAssetContext(market);
    const candleUnit = Number(process.env.CHART_CANDLE_UNIT_MINUTES || 60);

    const chartString = (chartData || []).slice(-12).map((d) => (
        `${d.time}: O=${d.open}, H=${d.high}, L=${d.low}, C=${d.close}, V=${d.vol.toFixed(2)}`
    )).join('\n');
    
    const prompt = `
        당신은 리스크 관리를 최우선으로 하는 ${asset.korean}(${asset.symbol}) 단기 트레이더입니다. 아래 데이터를 종합해 판단하세요.
        
        [마켓]: ${market}
        [현재 가격]: ${currentPrice}원
        [최신 시장 뉴스]:
        ${news}

        [최근 ${candleUnit}분봉 12개 OHLCV]:
        ${chartString || '차트 데이터 없음'}

        [기술 신호 요약(JSON)]:
        ${JSON.stringify(technicalSignal)}
        
        분석 규칙:
        1. 뉴스 심리와 차트 추세가 같은 방향일 때만 강한 확신도를 부여하세요.
        2. 과열 구간(RSI 과매수)에서는 매수 확신도를 낮추세요.
        3. 1~4시간 관점에서 HOLD를 적극적으로 사용하세요.
        
        반드시 아래 JSON 형식으로만 답변하세요. 다른 텍스트는 절대 출력하지 마세요:
        {
            "decision": "BUY" | "SELL" | "HOLD",
            "percentage": 0~100 (판단에 대한 확신도),
            "reason": "뉴스+차트 근거 한 문장 (한국어)"
        }
    `;

    try {
        const response = await requestGeminiSingleModel({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                response_mime_type: 'application/json'
            }
        });
        
        const aiResponse = response.data.candidates[0].content.parts[0].text;
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiResponse);

        const decision = ['BUY', 'SELL', 'HOLD'].includes(parsed.decision) ? parsed.decision : 'HOLD';
        const percentage = clamp(Number(parsed.percentage || 0), 0, 100);
        const reason = parsed.reason || 'AI 응답 파싱 보정';
        return { decision, percentage, reason };
    } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data || error.message;
        console.error(`❌ Gemini 분석 실패(${market}):`, status, detail);
        return { decision: "HOLD", percentage: 0, reason: "AI 분석 에러" };
    }
}

module.exports = { getCryptoNews, getChartData, getTechnicalSignal, getAIDecision };