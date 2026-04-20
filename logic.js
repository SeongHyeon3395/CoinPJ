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

function summarizePriceAction(chartData) {
    const candles = (chartData || []).slice(-12);
    if (candles.length < 4) {
        return {
            marketStructure: 'unknown',
            lastCandle: null,
            avgBodyPct: null,
            avgUpperWickPct: null,
            avgLowerWickPct: null,
            wickBias: 'neutral',
            expansionRangePct: null,
            contractionRangePct: null,
            trapRisk: 'unknown'
        };
    }

    const safePct = (num, base) => {
        if (!base || base <= 0) return 0;
        return (num / base) * 100;
    };

    const highs = candles.map((c) => Number(c.high || 0));
    const lows = candles.map((c) => Number(c.low || 0));
    const closes = candles.map((c) => Number(c.close || 0));
    const volumes = candles.map((c) => Number(c.vol || 0));

    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prevHigh = Math.max(...highs.slice(0, -1));
    const prevLow = Math.min(...lows.slice(0, -1));

    const bodyRatios = [];
    const upperWickRatios = [];
    const lowerWickRatios = [];
    const rangePcts = [];

    for (const c of candles) {
        const open = Number(c.open || 0);
        const high = Number(c.high || 0);
        const low = Number(c.low || 0);
        const close = Number(c.close || 0);
        const range = Math.max(high - low, 0);
        const body = Math.abs(close - open);
        const upper = Math.max(high - Math.max(open, close), 0);
        const lower = Math.max(Math.min(open, close) - low, 0);

        if (range > 0) {
            bodyRatios.push((body / range) * 100);
            upperWickRatios.push((upper / range) * 100);
            lowerWickRatios.push((lower / range) * 100);
        }
        rangePcts.push(safePct(range, close || open));
    }

    const average = (arr) => {
        if (!arr.length) return null;
        return arr.reduce((sum, n) => sum + n, 0) / arr.length;
    };

    const highHigher = highs[candles.length - 1] > highs[candles.length - 4];
    const lowHigher = lows[candles.length - 1] > lows[candles.length - 4];
    const highLower = highs[candles.length - 1] < highs[candles.length - 4];
    const lowLower = lows[candles.length - 1] < lows[candles.length - 4];

    const marketStructure = highHigher && lowHigher
        ? 'uptrend'
        : highLower && lowLower
            ? 'downtrend'
            : 'range';

    const recentAvgVol = average(volumes.slice(-6, -1)) || 0;
    const latestVol = Number(latest.vol || 0);
    const volSpike = recentAvgVol > 0 && latestVol >= recentAvgVol * 1.3;

    const breakout = Number(latest.close || 0) > prevHigh;
    const breakdown = Number(latest.close || 0) < prevLow;

    const latestRange = Math.max(Number(latest.high || 0) - Number(latest.low || 0), 0);
    const latestBody = Math.abs(Number(latest.close || 0) - Number(latest.open || 0));
    const bodyRatio = latestRange > 0 ? latestBody / latestRange : 0;

    const trapRisk = (breakout && (!volSpike || bodyRatio < 0.35))
        ? 'bull_trap_risk'
        : (breakdown && (!volSpike || bodyRatio < 0.35))
            ? 'bear_trap_risk'
            : 'low';

    const avgUpperWickPct = average(upperWickRatios);
    const avgLowerWickPct = average(lowerWickRatios);
    const wickBias = avgLowerWickPct !== null && avgUpperWickPct !== null
        ? (avgLowerWickPct - avgUpperWickPct > 6
            ? 'buy_rejection'
            : avgUpperWickPct - avgLowerWickPct > 6
                ? 'sell_rejection'
                : 'neutral')
        : 'neutral';

    return {
        marketStructure,
        lastCandle: {
            open: Number(latest.open || 0),
            high: Number(latest.high || 0),
            low: Number(latest.low || 0),
            close: Number(latest.close || 0),
            volume: Number(latest.vol || 0),
            bodyPctOfRange: Number((bodyRatio * 100).toFixed(2)),
            upperWickPctOfRange: Number((latestRange > 0 ? ((Number(latest.high || 0) - Math.max(Number(latest.open || 0), Number(latest.close || 0))) / latestRange) * 100 : 0).toFixed(2)),
            lowerWickPctOfRange: Number((latestRange > 0 ? ((Math.min(Number(latest.open || 0), Number(latest.close || 0)) - Number(latest.low || 0)) / latestRange) * 100 : 0).toFixed(2))
        },
        avgBodyPct: average(bodyRatios) === null ? null : Number(average(bodyRatios).toFixed(2)),
        avgUpperWickPct: avgUpperWickPct === null ? null : Number(avgUpperWickPct.toFixed(2)),
        avgLowerWickPct: avgLowerWickPct === null ? null : Number(avgLowerWickPct.toFixed(2)),
        wickBias,
        expansionRangePct: Number(((rangePcts[rangePcts.length - 1] || 0)).toFixed(3)),
        contractionRangePct: Number((average(rangePcts.slice(0, -1)) || 0).toFixed(3)),
        trapRisk
    };
}

async function getAIDecision(currentPrice, news, chartData, technicalSignal, market = 'KRW-BTC') {
    const asset = getAssetContext(market);
    const candleUnit = Number(process.env.CHART_CANDLE_UNIT_MINUTES || 60);
    const priceActionSummary = summarizePriceAction(chartData);

    const chartString = (chartData || []).slice(-12).map((d) => (
        `${d.time}: 시가=${d.open}, 고가=${d.high}, 저가=${d.low}, 종가=${d.close}, 거래량=${d.vol.toFixed(2)}`
    )).join('\n');
    
    const prompt = `
        당신은 '프라이스 액션(Price Action)'과 '시장 구조(Market Structure)' 분석의 마스터이자 최고 수준의 단기 퀀트 트레이더입니다.
        외부 뉴스, 재료, 소문은 전부 무시하고 오직 제공된 캔들(OHLCV) 흐름과 기술 지표만으로 판단하세요.
        
        [마켓]: ${market}
        [현재 가격]: ${currentPrice}원

        [최근 ${candleUnit}분봉 12개 흐름 (시간, 시가, 고가, 저가, 종가, 거래량)]:
        ${chartString || '차트 데이터 없음'}

        [기술 지표 및 추세 요약(JSON)]:
        ${JSON.stringify(technicalSignal)}

        [프라이스 액션 요약(JSON)]:
        ${JSON.stringify(priceActionSummary)}
        
        분석 규칙 (절대 엄수):
        1. [캔들과 꼬리 분석] 아래 꼬리가 길고 거래량이 동반되면 강한 지지 유입으로 해석하고 매수 후보를 검토하세요. 거래량이 동반된 긴 위 꼬리는 매도 압력으로 간주하여 SELL 또는 HOLD를 우선하세요.
        2. [가짜 돌파 회피] 전고점/전저점 돌파가 발생해도 거래량 급증(volSpike)이나 몸통 강도(bodyPctOfRange)가 약하면 불트랩/베어트랩 위험으로 간주하고 HOLD를 선택하세요.
        3. [시장 구조 우선] 최근 12개 캔들의 고점/저점 구조가 higher-high/higher-low면 상승 구조, lower-high/lower-low면 하락 구조로 판단하세요.
        4. [추세와 모멘텀] EMA20/EMA50 배열과 RSI를 반드시 함께 보세요. RSI가 70 이상이면 추격 매수를 금지하고 확신도를 낮추세요.
        5. [리스크 관리] 거래량이 마르고 방향성이 불분명한 횡보 구간이면 억지 진입하지 말고 HOLD로 자본을 보호하세요.
        
        반드시 아래 JSON 형식으로만 답변하세요. 다른 텍스트는 절대 출력하지 마세요:
        {
            "decision": "BUY" | "SELL" | "HOLD",
            "percentage": 0~100 (판단에 대한 확신도),
            "reason": "캔들 꼬리, 거래량, 돌파/트랩 리스크를 포함한 핵심 근거 한 문장 (한국어)"
        }
    `;

    try {
        const response = await requestGeminiSingleModel({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                response_mime_type: 'application/json'
            }
        });

        const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!aiResponse) {
            return { decision: 'HOLD', percentage: 0, reason: 'AI 응답 비어 있음' };
        }

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