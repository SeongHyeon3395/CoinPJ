// main.js
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const { getCryptoNews, getChartData, getTechnicalSignal, getAIDecision } = require('./logic');
const { buyMarket, sellMarket, getMarketVolume } = require('./order');
const {
    saveTrade,
    saveAILog,
    getOpenPosition,
    createOpenPosition,
    updateOpenPosition,
    closePosition
} = require('./db');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const BUY_AMOUNT_KRW = Number(process.env.BUY_AMOUNT_KRW || 10000);
const BUY_CONFIDENCE_THRESHOLD = Number(process.env.BUY_CONFIDENCE_THRESHOLD || 75);
const SELL_CONFIDENCE_THRESHOLD = Number(process.env.SELL_CONFIDENCE_THRESHOLD || 70);
const ACCOUNT_CAPITAL_KRW = Number(process.env.ACCOUNT_CAPITAL_KRW || 100000);
const RISK_PER_TRADE_PCT = Number(process.env.RISK_PER_TRADE_PCT || 1);
const STOP_ATR_MULTIPLIER = Number(process.env.STOP_ATR_MULTIPLIER || 2.0);
const TRAILING_ATR_MULTIPLIER = Number(process.env.TRAILING_ATR_MULTIPLIER || 2.0);
const MIN_ORDER_KRW = Number(process.env.MIN_ORDER_KRW || 5000);
const MAX_ORDER_KRW = Number(process.env.MAX_ORDER_KRW || 20000);
const MIN_STOP_PCT = Number(process.env.MIN_STOP_PCT || 1.0);
const CONFIRM_REAL_TRADING = process.env.CONFIRM_REAL_TRADING === 'true';
const BOT_CRON = process.env.BOT_CRON || '*/30 * * * *';
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 1.8);
const TAKE_PROFIT_SELL_RATIO = Number(process.env.TAKE_PROFIT_SELL_RATIO || 0.3);

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function roundToKRW(value) {
    return Math.max(MIN_ORDER_KRW, Math.round(value / 1000) * 1000);
}

function computeOrderSizeKrw(currentPrice, technicalSignal) {
    const atr = technicalSignal.atr;
    if (!atr) {
        return roundToKRW(clamp(BUY_AMOUNT_KRW, MIN_ORDER_KRW, MAX_ORDER_KRW));
    }

    const riskBudget = ACCOUNT_CAPITAL_KRW * (RISK_PER_TRADE_PCT / 100);
    const stopDistance = Math.max(atr * STOP_ATR_MULTIPLIER, currentPrice * (MIN_STOP_PCT / 100));
    const quantity = riskBudget / stopDistance;
    const rawOrderKrw = quantity * currentPrice;
    const clamped = clamp(rawOrderKrw, MIN_ORDER_KRW, MAX_ORDER_KRW);

    return roundToKRW(clamped);
}

function computeTrailingDistance(currentPrice, atr) {
    const fallback = currentPrice * (MIN_STOP_PCT / 100);
    if (!atr) return fallback;
    return Math.max(atr * TRAILING_ATR_MULTIPLIER, fallback);
}

function combineDecision(aiResult, technicalSignal) {
    const agreeBuy = aiResult.decision === 'BUY' && technicalSignal.decision === 'BUY';
    const agreeSell = aiResult.decision === 'SELL' && technicalSignal.decision === 'SELL';

    if (agreeBuy && aiResult.percentage >= BUY_CONFIDENCE_THRESHOLD && technicalSignal.confidence >= 55) {
        return {
            finalDecision: 'BUY',
            reason: 'AI 신호와 기술 신호가 동시에 매수 방향으로 정렬되었습니다.'
        };
    }

    if (agreeSell && aiResult.percentage >= SELL_CONFIDENCE_THRESHOLD && technicalSignal.confidence >= 55) {
        return {
            finalDecision: 'SELL',
            reason: 'AI 신호와 기술 신호가 동시에 매도 방향으로 정렬되었습니다.'
        };
    }

    return {
        finalDecision: 'HOLD',
        reason: '신호 불일치 또는 확신도 부족으로 관망합니다.'
    };
}

async function runBot() {
    console.log("🚀 봇 가동! 시장 분석을 시작합니다...");
    if (DRY_RUN) {
        console.log("🧪 DRY_RUN=true: 실제 주문 없이 시뮬레이션만 진행합니다.");
    } else if (!CONFIRM_REAL_TRADING) {
        throw new Error('실거래 모드 차단: CONFIRM_REAL_TRADING=true 를 설정해야 주문이 실행됩니다.');
    }

    try {
        // 1. 현재가 조회
        const priceRes = await axios.get('https://api.upbit.com/v1/ticker?markets=KRW-BTC');
        const currentPrice = priceRes.data[0].trade_price;
        console.log(`📊 현재 비트코인 가격: ${currentPrice.toLocaleString()}원`);

        // 2. 뉴스/차트 수집 및 AI 판단
        console.log("🔍 최신 뉴스 수집 중...");
        const news = await getCryptoNews();

        console.log("📈 차트 데이터 수집 중...");
        const chartData = await getChartData();
        const technicalSignal = getTechnicalSignal(chartData);

        console.log("🧠 Gemini AI 분석 중...");
        const aiResult = await getAIDecision(currentPrice, news, chartData, technicalSignal);

        const combined = combineDecision(aiResult, technicalSignal);
        const openPosition = await getOpenPosition('KRW-BTC', DRY_RUN);

        console.log(`\n--- AI 분석: ${aiResult.decision} (${aiResult.percentage}%) ---`);
        console.log(`이유: ${aiResult.reason}\n`);
        console.log(`--- 기술 신호: ${technicalSignal.decision} (${technicalSignal.confidence}%) ---`);
        console.log(`요약: ${technicalSignal.reason}`);
        console.log(`--- 최종 의사결정: ${combined.finalDecision} ---`);
        console.log(`근거: ${combined.reason}\n`);

        if (openPosition) {
            const positionQty = Number(openPosition.quantity_btc);
            const positionInvested = Number(openPosition.invested_krw);
            const entryPrice = Number(openPosition.entry_price);
            const takeProfitDone = Boolean(openPosition.take_profit_done);
            const prevHighest = Number(openPosition.highest_price);
            const prevStop = Number(openPosition.trailing_stop_price);
            const nextHighest = Math.max(prevHighest, currentPrice);
            const trailDistance = computeTrailingDistance(currentPrice, technicalSignal.atr || Number(openPosition.atr_at_entry));
            const recalculatedStop = nextHighest - trailDistance;
            const nextStop = Math.max(prevStop, recalculatedStop);

            if (nextHighest !== prevHighest || Math.abs(nextStop - prevStop) > 0.1) {
                await updateOpenPosition(openPosition.id, {
                    highest_price: nextHighest,
                    trailing_stop_price: nextStop
                });
            }

            console.log(`📌 보유 포지션 추적: 최고가=${Math.round(nextHighest).toLocaleString()} / 스탑=${Math.round(nextStop).toLocaleString()}`);

            const stopTriggered = currentPrice <= nextStop;
            const aiExitTriggered = combined.finalDecision === 'SELL';

            if (stopTriggered || aiExitTriggered) {
                const exitReason = stopTriggered
                    ? `트레일링 스탑 발동: 현재가(${Math.round(currentPrice)}) <= 스탑(${Math.round(nextStop)})`
                    : `AI/기술 결합 매도 신호: ${combined.reason}`;

                console.log(`📉 [청산] ${exitReason}`);

                if (!DRY_RUN) {
                    const volume = await getMarketVolume('KRW-BTC');
                    if (volume <= 0) {
                        console.log('⚠️ 실제 보유 수량이 없어 매도 주문을 생략합니다.');
                        return;
                    }

                    const sellRes = await sellMarket('KRW-BTC', volume);
                    console.log('✅ 매도 주문 완료:', sellRes.uuid || '(uuid 없음)');
                } else {
                    console.log('🧪 DRY_RUN 모드: 실제 매도 주문은 생략했습니다.');
                }

                await saveTrade({
                    side: 'sell',
                    price: currentPrice,
                    amount: positionInvested,
                    reason: exitReason,
                    is_simulated: DRY_RUN
                });

                await closePosition(openPosition.id, currentPrice, exitReason);
                console.log('✅ 포지션 종료 및 DB 기록 완료');
                return;
            }

            const takeProfitPrice = entryPrice * (1 + (TAKE_PROFIT_PCT / 100));
            const takeProfitTriggered = !takeProfitDone && currentPrice >= takeProfitPrice;

            if (takeProfitTriggered) {
                const partialRatio = clamp(TAKE_PROFIT_SELL_RATIO, 0.1, 0.9);
                const partialQty = positionQty * partialRatio;
                const remainQty = positionQty - partialQty;
                const partialInvested = positionInvested * partialRatio;
                const remainInvested = positionInvested - partialInvested;

                console.log(`💸 [부분익절] 목표가 도달: ${Math.round(takeProfitPrice).toLocaleString()}원 (${TAKE_PROFIT_PCT}%)`);

                if (!DRY_RUN) {
                    const volume = await getMarketVolume('KRW-BTC');
                    const sellQty = Math.min(volume, partialQty);
                    if (sellQty > 0) {
                        const sellRes = await sellMarket('KRW-BTC', sellQty.toFixed(8));
                        console.log('✅ 부분익절 주문 완료:', sellRes.uuid || '(uuid 없음)');
                    } else {
                        console.log('⚠️ 부분익절 가능한 보유 수량이 없어 주문을 생략합니다.');
                    }
                } else {
                    console.log('🧪 DRY_RUN 모드: 부분익절 주문은 생략했습니다.');
                }

                await saveTrade({
                    side: 'sell',
                    price: currentPrice,
                    amount: partialInvested,
                    reason: `부분익절 ${Math.round(partialRatio * 100)}% 실행`,
                    is_simulated: DRY_RUN
                });

                await updateOpenPosition(openPosition.id, {
                    quantity_btc: remainQty,
                    invested_krw: remainInvested,
                    take_profit_done: true,
                    highest_price: nextHighest,
                    trailing_stop_price: nextStop
                });

                console.log(`✅ 부분익절 완료: 잔여 수량=${remainQty.toFixed(8)} BTC`);
                return;
            }

            console.log('🛡️ 보유 포지션 유지: 청산 조건이 아직 충족되지 않았습니다.');
            return;
        }

        // 3. AI 로그 저장
        await saveAILog({
            decision: combined.finalDecision,
            sentiment_score: aiResult.percentage,
            analysis_reason: `${aiResult.reason} | TECH: ${technicalSignal.reason} | FINAL: ${combined.reason}`,
            is_simulated: DRY_RUN
        });

        // 4. 신규 진입 로직
        if (combined.finalDecision === 'BUY') {
            const orderKrw = computeOrderSizeKrw(currentPrice, technicalSignal);
            const qty = orderKrw / currentPrice;
            const initialStop = currentPrice - computeTrailingDistance(currentPrice, technicalSignal.atr);

            console.log(`💰 [실행] 신규 진입: ${orderKrw.toLocaleString()}원 (변동성 기반) 매수 시도.`);

            if (!DRY_RUN) {
                const orderRes = await buyMarket('KRW-BTC', orderKrw);
                console.log('✅ 매수 주문 완료:', orderRes.uuid || '(uuid 없음)');
            } else {
                console.log('🧪 DRY_RUN 모드: 실제 주문은 생략했습니다.');
            }

            await saveTrade({
                side: 'buy',
                price: currentPrice,
                amount: orderKrw,
                reason: `${aiResult.reason} | ${technicalSignal.reason} | stop=${Math.round(initialStop)}`,
                is_simulated: DRY_RUN
            });

            await createOpenPosition({
                market: 'KRW-BTC',
                entry_price: currentPrice,
                quantity_btc: qty,
                invested_krw: orderKrw,
                highest_price: currentPrice,
                trailing_stop_price: initialStop,
                atr_at_entry: technicalSignal.atr,
                entry_reason: `${aiResult.reason} | ${technicalSignal.reason}`,
                is_simulated: DRY_RUN,
                take_profit_done: false
            });

            console.log('✅ 매수 기록 DB 저장 완료');
        }
        else {
            console.log('😴 [대기] 매매 조건이 충족되지 않았습니다.');
        }
    } catch (err) {
        console.error('❌ 봇 실행 중 치명적 오류:', err.response?.data || err.message);
    }
}

let isRunning = false;

async function runBotSafely() {
    if (isRunning) {
        console.log('⏭️ 이전 실행이 아직 진행 중이라 이번 스케줄은 건너뜁니다.');
        return;
    }

    isRunning = true;
    try {
        await runBot();
    } finally {
        isRunning = false;
    }
}

if (RUN_ONCE) {
    runBotSafely();
} else {
    cron.schedule(BOT_CRON, async () => {
        console.log(`⏰ 스케줄 실행: ${new Date().toLocaleString()}`);
        await runBotSafely();
    });

    console.log(`🤖 봇 대기 중... 스케줄러 작동 시작 (BOT_CRON=${BOT_CRON})`);
    runBotSafely();
}