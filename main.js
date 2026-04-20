// main.js
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const { getChartData, getTechnicalSignal, getAIDecision } = require('./logic');
const {
    buyMarket,
    sellMarket,
    sellLimit,
    getOpenOrders,
    cancelOrder,
    getOrder,
    getAccounts,
    getMarketVolume,
    getLiveAccountSummary
} = require('./order');
const {
    saveTrade,
    saveAILog,
    getOpenPosition,
    listOpenPositions,
    createOpenPosition,
    updateOpenPosition,
    closePosition,
    upsertSyncReport
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
const MIN_STOP_PCT_INPUT = Number(process.env.MIN_STOP_PCT || 2.0);
const MIN_STOP_PCT_FLOOR = Number(process.env.MIN_STOP_PCT_FLOOR || 1.5);
const MIN_STOP_PCT = Math.max(MIN_STOP_PCT_INPUT, MIN_STOP_PCT_FLOOR);
const CONFIRM_REAL_TRADING = process.env.CONFIRM_REAL_TRADING === 'true';
const BOT_CRON = process.env.BOT_CRON || '0 * * * *';
const PRICE_MONITOR_CRON = process.env.PRICE_MONITOR_CRON || '*/1 * * * *';
const POSITION_SYNC_CRON = process.env.POSITION_SYNC_CRON || '5 0 * * *';
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 1.8);
const TAKE_PROFIT_SELL_RATIO = Number(process.env.TAKE_PROFIT_SELL_RATIO || 0.3);
const AGGRESSIVE_TEST_MODE = process.env.AGGRESSIVE_TEST_MODE !== 'false';
const ENTRY_SCORE_THRESHOLD = Number(process.env.ENTRY_SCORE_THRESHOLD || 55);
const EXIT_SCORE_THRESHOLD = Number(process.env.EXIT_SCORE_THRESHOLD || 45);
const TECH_MIN_CONFIDENCE = Number(process.env.TECH_MIN_CONFIDENCE || 35);
const INCLUDE_ACCOUNT_HOLDINGS_MARKETS = process.env.INCLUDE_ACCOUNT_HOLDINGS_MARKETS !== 'false';
const TARGET_MARKETS = (process.env.TARGET_MARKETS || 'KRW-BTC,KRW-ETH,KRW-XRP')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
const ENABLE_SURGING_ALT_MARKETS = process.env.ENABLE_SURGING_ALT_MARKETS !== 'false';
const SURGING_ALT_COUNT = Number(process.env.SURGING_ALT_COUNT || 5);
const SURGING_ALT_MIN_CHANGE_PCT = Number(process.env.SURGING_ALT_MIN_CHANGE_PCT || 3.0);
const SURGING_ALT_MIN_24H_KRW = Number(process.env.SURGING_ALT_MIN_24H_KRW || 10000000000);
const SURGING_ALT_EXCLUDE = (process.env.SURGING_ALT_EXCLUDE || 'BTC,ETH,XRP')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
const DUST_CLOSE_KRW = Number(process.env.DUST_CLOSE_KRW || 2000);
const MARKET_LOOP_DELAY_MS = Number(process.env.MARKET_LOOP_DELAY_MS || 500);
const CANCEL_SETTLE_DELAY_MS = Number(process.env.CANCEL_SETTLE_DELAY_MS || 1000);
const LIMIT_FILL_CHECK_DELAY_MS = Number(process.env.LIMIT_FILL_CHECK_DELAY_MS || 2500);
const PARTIAL_TP_ORDER_TTL_MS = Number(process.env.PARTIAL_TP_ORDER_TTL_MS || 300000);
const POSITION_SYNC_ON_START = process.env.POSITION_SYNC_ON_START !== 'false';
const BLOCK_TRADING_UNTIL_SYNC = process.env.BLOCK_TRADING_UNTIL_SYNC !== 'false';
const POSITION_SYNC_DUST_QTY = Number(process.env.POSITION_SYNC_DUST_QTY || 0.00001);
const SYNC_REPORT_AS_AI_LOG = process.env.SYNC_REPORT_AS_AI_LOG !== 'false';
const AUTO_STOP_MINUTES = Number(process.env.AUTO_STOP_MINUTES || 0);

if (MIN_STOP_PCT_INPUT < MIN_STOP_PCT_FLOOR) {
    console.log(`⚠️ MIN_STOP_PCT=${MIN_STOP_PCT_INPUT}% 가 너무 낮아 ${MIN_STOP_PCT}%로 상향 보정했습니다.`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function normalizeKrwPriceUnit(price) {
    if (price >= 2000000) return Math.round(price / 1000) * 1000;
    if (price >= 1000000) return Math.round(price / 500) * 500;
    if (price >= 500000) return Math.round(price / 100) * 100;
    if (price >= 100000) return Math.round(price / 50) * 50;
    if (price >= 10000) return Math.round(price / 10) * 10;
    if (price >= 1000) return Math.round(price);
    if (price >= 100) return Math.round(price * 10) / 10;
    if (price >= 10) return Math.round(price * 100) / 100;
    if (price >= 1) return Math.round(price * 1000) / 1000;
    return Math.round(price * 10000) / 10000;
}

function computeTakeProfitLimitPrice(currentPrice, takeProfitPrice) {
    // 목표가 이상을 유지하되, 과도한 고가 지정으로 미체결될 가능성을 줄인다.
    const conservative = Math.max(takeProfitPrice, currentPrice * 0.999);
    return normalizeKrwPriceUnit(conservative);
}

function getBaseCurrency(market) {
    return market.split('-')[1];
}

function uniqueMarkets(markets) {
    return [...new Set(markets.filter((m) => typeof m === 'string' && m.startsWith('KRW-')))];
}

async function getSurgingAltMarkets(baseMarkets) {
    if (!ENABLE_SURGING_ALT_MARKETS || SURGING_ALT_COUNT <= 0) {
        return [];
    }

    try {
        const baseSet = new Set(baseMarkets);
        const marketRes = await axios.get('https://api.upbit.com/v1/market/all', {
            params: { isDetails: false }
        });

        const allKrwMarkets = (marketRes.data || [])
            .map((m) => m.market)
            .filter((m) => typeof m === 'string' && m.startsWith('KRW-'))
            .filter((m) => !baseSet.has(m))
            .filter((m) => !SURGING_ALT_EXCLUDE.includes(getBaseCurrency(m)));

        if (!allKrwMarkets.length) {
            return [];
        }

        const tickerRes = await axios.get('https://api.upbit.com/v1/ticker', {
            params: { markets: allKrwMarkets.join(',') }
        });

        const minChange = SURGING_ALT_MIN_CHANGE_PCT / 100;
        const tickerList = tickerRes.data || [];
        const picked = tickerList
            .filter((t) => Number(t.signed_change_rate || 0) >= minChange)
            .filter((t) => Number(t.acc_trade_price_24h || 0) >= SURGING_ALT_MIN_24H_KRW)
            .sort((a, b) => {
                const changeDiff = Number(b.signed_change_rate || 0) - Number(a.signed_change_rate || 0);
                if (Math.abs(changeDiff) > 0.000001) return changeDiff;
                return Number(b.acc_trade_price_24h || 0) - Number(a.acc_trade_price_24h || 0);
            })
            .slice(0, SURGING_ALT_COUNT)
            .map((t) => t.market);

        return picked;
    } catch (error) {
        console.error('⚠️ 급등 잡코인 스캔 실패, 고정 마켓만 사용합니다:', error.response?.data || error.message);
        return [];
    }
}

async function getAccountHoldingMarkets() {
    if (DRY_RUN || !INCLUDE_ACCOUNT_HOLDINGS_MARKETS) {
        return [];
    }

    try {
        const accounts = await getAccounts();
        const holdingMarkets = (accounts || [])
            .filter((a) => a.unit_currency === 'KRW' && a.currency !== 'KRW')
            .map((a) => {
                const qty = Number(a.balance || 0) + Number(a.locked || 0);
                return {
                    market: `KRW-${a.currency}`,
                    qty
                };
            })
            .filter((h) => h.qty > POSITION_SYNC_DUST_QTY)
            .map((h) => h.market);

        return uniqueMarkets(holdingMarkets);
    } catch (error) {
        console.error('⚠️ 실계좌 보유 마켓 조회 실패, 기본 대상만 사용합니다:', error.response?.data || error.message);
        return [];
    }
}

async function fetchTickerByMarkets(markets, context = 'general') {
    const validMarkets = uniqueMarkets(markets);
    const tickerByMarket = new Map();

    if (!validMarkets.length) {
        return tickerByMarket;
    }

    try {
        const tickersRes = await axios.get('https://api.upbit.com/v1/ticker', {
            params: { markets: validMarkets.join(',') }
        });
        for (const t of tickersRes.data || []) {
            if (t?.market) tickerByMarket.set(t.market, t);
        }
        return tickerByMarket;
    } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data || error.message;

        if (status !== 404) {
            throw error;
        }

        console.error(`⚠️ [${context}] 티커 일괄 조회 404, 개별 마켓으로 재시도합니다:`, detail);
        const invalidMarkets = [];

        for (const market of validMarkets) {
            try {
                const res = await axios.get('https://api.upbit.com/v1/ticker', {
                    params: { markets: market }
                });
                const first = Array.isArray(res.data) ? res.data[0] : null;
                if (first?.market) {
                    tickerByMarket.set(first.market, first);
                } else {
                    invalidMarkets.push(market);
                }
            } catch (singleError) {
                if (singleError.response?.status === 404) {
                    invalidMarkets.push(market);
                    continue;
                }
                console.error(`⚠️ [${context}] 티커 조회 실패(${market}):`, singleError.response?.data || singleError.message);
            }
        }

        if (invalidMarkets.length > 0) {
            console.error(`⚠️ [${context}] 유효하지 않은 마켓 제외: ${invalidMarkets.join(', ')}`);
        }

        return tickerByMarket;
    }
}

async function resolveTargetMarkets(includeOpenPositionMarkets = true) {
    const baseMarkets = uniqueMarkets(TARGET_MARKETS);
    const surgingAltMarkets = await getSurgingAltMarkets(baseMarkets);
    const holdingMarkets = await getAccountHoldingMarkets();
    const markets = uniqueMarkets([...baseMarkets, ...surgingAltMarkets, ...holdingMarkets]);

    if (!includeOpenPositionMarkets) {
        return markets;
    }

    const openPositions = await listOpenPositions();
    const openMarkets = uniqueMarkets((openPositions || []).map((p) => p.market));
    return uniqueMarkets([...markets, ...openMarkets]);
}

function parseOrderExecution(order, fallbackPrice = 0, fallbackVolume = 0) {
    const executedVolume = Number(order?.executed_volume || fallbackVolume || 0);
    const paidFee = Number(order?.paid_fee || 0);
    const avgPriceCandidate = Number(order?.avg_price || 0);

    const trades = Array.isArray(order?.trades) ? order.trades : [];
    const tradesFunds = trades.reduce((sum, t) => sum + Number(t.funds || 0), 0);
    const fundsFromField = Number(order?.executed_funds || 0);

    const grossFunds = tradesFunds > 0
        ? tradesFunds
        : fundsFromField > 0
            ? fundsFromField
            : executedVolume * (avgPriceCandidate > 0 ? avgPriceCandidate : fallbackPrice);

    const avgPrice = executedVolume > 0
        ? grossFunds / executedVolume
        : (avgPriceCandidate > 0 ? avgPriceCandidate : fallbackPrice);

    const netProceeds = Math.max(0, grossFunds - paidFee);

    return {
        executedVolume,
        avgPrice,
        grossFunds,
        paidFee,
        netProceeds
    };
}

function computeCostBasis(positionInvested, positionQty, executedVolume) {
    if (positionQty <= 0 || executedVolume <= 0) return 0;
    const ratio = clamp(executedVolume / positionQty, 0, 1);
    return positionInvested * ratio;
}

function isOrderStale(order, ttlMs) {
    const createdAt = new Date(order.created_at).getTime();
    if (Number.isNaN(createdAt)) return false;
    return Date.now() - createdAt >= ttlMs;
}

async function managePartialTakeProfitOrders(market) {
    if (DRY_RUN) {
        return { hasActiveFreshOrder: false, canceledCount: 0 };
    }

    const openAskOrders = await getOpenOrders(market, 'ask');
    if (!openAskOrders.length) {
        return { hasActiveFreshOrder: false, canceledCount: 0 };
    }

    const staleOrders = openAskOrders.filter((o) => isOrderStale(o, PARTIAL_TP_ORDER_TTL_MS));
    const freshOrders = openAskOrders.filter((o) => !isOrderStale(o, PARTIAL_TP_ORDER_TTL_MS));

    let canceledCount = 0;
    if (staleOrders.length > 0) {
        console.log(`♻️ [${market}] TTL 경과 미체결 주문 ${staleOrders.length}건을 취소하고 재호가 준비합니다.`);
        for (const order of staleOrders) {
            try {
                await cancelOrder(order.uuid);
                canceledCount += 1;
                console.log(`✅ TTL 취소 완료: ${order.uuid}`);
            } catch (error) {
                console.error(`❌ TTL 취소 실패(${order.uuid}):`, error.response?.data || error.message);
            }
        }

        if (canceledCount > 0) {
            await sleep(CANCEL_SETTLE_DELAY_MS);
        }
    }

    return {
        hasActiveFreshOrder: freshOrders.length > 0,
        canceledCount
    };
}

async function cancelOpenAskOrders(market) {
    if (DRY_RUN) return 0;

    const openAskOrders = await getOpenOrders(market, 'ask');
    if (!openAskOrders.length) return 0;

    console.log(`⚠️ [${market}] 미체결 매도 주문 ${openAskOrders.length}건 취소를 시작합니다.`);

    let canceled = 0;
    for (const order of openAskOrders) {
        try {
            await cancelOrder(order.uuid);
            canceled += 1;
            console.log(`✅ 미체결 주문 취소 완료: ${order.uuid}`);
        } catch (error) {
            console.error(`❌ 주문 취소 실패(${order.uuid}):`, error.response?.data || error.message);
        }
    }

    if (canceled > 0) {
        await sleep(CANCEL_SETTLE_DELAY_MS);
    }

    return canceled;
}

async function executeExitFlow({ market, currentPrice, positionQty, positionInvested, positionId, exitReason }) {
    let sold = DRY_RUN;
    let executed = {
        executedVolume: positionQty,
        avgPrice: currentPrice,
        grossFunds: positionInvested,
        paidFee: 0,
        netProceeds: positionInvested
    };

    if (!DRY_RUN) {
        await cancelOpenAskOrders(market);

        const volume = await getMarketVolume(market);
        if (volume <= 0) {
            console.log(`⚠️ 실제 보유 수량이 없어 매도 주문을 생략합니다. (${market})`);
            return false;
        }

        const estimatedNotional = volume * currentPrice;
        if (estimatedNotional < MIN_ORDER_KRW) {
            if (estimatedNotional <= DUST_CLOSE_KRW) {
                await closePosition(positionId, currentPrice, `${exitReason} | 최소주문 미달 잔량(DUST ${Math.round(estimatedNotional)}원) 정리`);
                console.log(`🧹 [${market}] 최소주문 미달 잔량(${Math.round(estimatedNotional)}원)을 DB에서 정리했습니다.`);
                return true;
            }

            console.log(`⚠️ [${market}] 예상 매도금액 ${Math.round(estimatedNotional)}원이 최소주문 ${MIN_ORDER_KRW}원 미만이라 청산을 보류합니다.`);
            return false;
        }

        try {
            const sellRes = await sellMarket(market, volume);
            console.log('✅ 매도 주문 완료:', sellRes.uuid || '(uuid 없음)');

            await sleep(LIMIT_FILL_CHECK_DELAY_MS);
            const orderInfo = sellRes.uuid ? await getOrder(sellRes.uuid) : null;
            executed = parseOrderExecution(orderInfo || sellRes, currentPrice, volume);
            sold = true;
        } catch (error) {
            console.error(`❌ 시장가 청산 실패(${market}):`, error.response?.data || error.message);
            return false;
        }
    } else {
        console.log('🧪 DRY_RUN 모드: 실제 매도 주문은 생략했습니다.');
    }

    if (!sold) return false;

    const executedVolume = clamp(executed.executedVolume, 0, positionQty);
    if (!DRY_RUN && executedVolume <= POSITION_SYNC_DUST_QTY) {
        console.log(`⚠️ [${market}] 체결수량이 0에 가까워 DB 청산을 보류합니다.`);
        return false;
    }

    const costBasis = DRY_RUN
        ? positionInvested
        : computeCostBasis(positionInvested, positionQty, executedVolume);
    const realizedPnl = executed.netProceeds - costBasis;
    const remainQty = Math.max(0, positionQty - executedVolume);
    const remainInvested = Math.max(0, positionInvested - costBasis);

    await saveTrade({
        side: 'sell',
        price: executed.avgPrice,
        amount: DRY_RUN ? positionInvested : executed.netProceeds,
        reason: `[${market}] ${exitReason} | exec_qty=${executedVolume.toFixed(8)} | fee=${Math.round(executed.paidFee)} | pnl=${Math.round(realizedPnl)}`,
        is_simulated: DRY_RUN
    });

    if (remainQty <= POSITION_SYNC_DUST_QTY) {
        await closePosition(positionId, executed.avgPrice, `${exitReason} | 실현손익=${Math.round(realizedPnl)}원`);
        console.log(`✅ 포지션 종료 및 DB 기록 완료 (${market})`);
    } else {
        await updateOpenPosition(positionId, {
            quantity_btc: remainQty,
            invested_krw: remainInvested,
            highest_price: currentPrice,
            trailing_stop_price: Math.max(currentPrice - computeTrailingDistance(currentPrice, null), 1)
        });
        console.log(`⚠️ 부분 체결(${market}): 잔여 수량 ${remainQty.toFixed(8)} BTC 유지, 다음 루프에서 재청산 시도`);
    }

    return true;
}

async function hasPendingAskOrder(market) {
    if (DRY_RUN) return false;
    const openAskOrders = await getOpenOrders(market, 'ask');
    return openAskOrders.length > 0;
}

async function reconcilePositions() {
    const activeMarkets = await resolveTargetMarkets();

    if (DRY_RUN) {
        console.log('🧪 DRY_RUN 모드: 실계좌-DB 동기화 점검은 생략합니다.');
        return {
            checkedMarkets: activeMarkets.length,
            mismatches: 0,
            recoveredCount: 0,
            closedCount: 0,
            qtyAdjustedCount: 0
        };
    }

    console.log('🔄 업비트 계좌와 DB 포지션 동기화 점검 시작...');

    const report = {
        checkedMarkets: 0,
        mismatches: 0,
        recoveredCount: 0,
        closedCount: 0,
        qtyAdjustedCount: 0
    };

    const accounts = await getAccounts();
    const accountByCurrency = new Map(accounts.map((a) => [a.currency, a]));

    if (!activeMarkets.length) {
        console.log('⚠️ 동기화 대상 마켓이 없어 점검을 건너뜁니다.');
        return report;
    }

    const tickerRawByMarket = await fetchTickerByMarkets(activeMarkets, 'position-sync');
    const tickerByMarket = new Map(
        [...tickerRawByMarket.entries()].map(([market, ticker]) => [market, Number(ticker?.trade_price || 0)])
    );

    for (const market of activeMarkets) {
        report.checkedMarkets += 1;
        const dbPosition = await getOpenPosition(market, DRY_RUN);
        const currency = getBaseCurrency(market);
        const account = accountByCurrency.get(currency);

        const balance = Number(account?.balance || 0);
        const locked = Number(account?.locked || 0);
        const actualQty = balance + locked;
        const currentPrice = tickerByMarket.get(market) || 0;
        const avgBuyPrice = Number(account?.avg_buy_price || 0);

        if (actualQty > POSITION_SYNC_DUST_QTY && !dbPosition) {
            report.mismatches += 1;
            report.recoveredCount += 1;
            const entryPrice = avgBuyPrice > 0 ? avgBuyPrice : currentPrice;
            const trailDistance = computeTrailingDistance(entryPrice, null);
            const trailingStop = Math.max(entryPrice - trailDistance, 1);

            await createOpenPosition({
                market,
                entry_price: entryPrice,
                quantity_btc: actualQty,
                invested_krw: actualQty * entryPrice,
                highest_price: currentPrice > 0 ? currentPrice : entryPrice,
                trailing_stop_price: trailingStop,
                atr_at_entry: null,
                entry_reason: `[${market}] SYSTEM_RECOVERY: 실계좌 보유분을 DB에 복구`,
                is_simulated: DRY_RUN,
                take_profit_done: false
            });

            console.log(`✅ 동기화 복구(${market}): 실계좌 보유분을 DB OPEN 포지션으로 생성`);
            continue;
        }

        if (actualQty <= POSITION_SYNC_DUST_QTY && dbPosition) {
            report.mismatches += 1;
            report.closedCount += 1;
            const exitPrice = currentPrice > 0 ? currentPrice : Number(dbPosition.entry_price);
            await closePosition(dbPosition.id, exitPrice, `[${market}] SYSTEM_SYNC: 실계좌 잔고 없음으로 포지션 종료`);
            console.log(`✅ 동기화 정리(${market}): DB OPEN 포지션을 종료`);
            continue;
        }

        if (actualQty > POSITION_SYNC_DUST_QTY && dbPosition) {
            const dbQty = Number(dbPosition.quantity_btc || 0);
            const qtyGap = Math.abs(actualQty - dbQty);
            const tolerance = Math.max(POSITION_SYNC_DUST_QTY, actualQty * 0.02);

            if (qtyGap > tolerance) {
                report.mismatches += 1;
                report.qtyAdjustedCount += 1;
                await updateOpenPosition(dbPosition.id, {
                    quantity_btc: actualQty,
                    invested_krw: actualQty * Number(dbPosition.entry_price)
                });
                console.log(`✅ 동기화 보정(${market}): 수량 차이 ${qtyGap.toFixed(8)}를 DB에 반영`);
            }
        }
    }

    const details = `checked=${report.checkedMarkets}, mismatches=${report.mismatches}, recovered=${report.recoveredCount}, closed=${report.closedCount}, adjusted=${report.qtyAdjustedCount}`;
    await upsertSyncReport({
        report_date: new Date().toISOString().slice(0, 10),
        is_simulated: DRY_RUN,
        checked_markets: report.checkedMarkets,
        mismatches: report.mismatches,
        recovered_count: report.recoveredCount,
        closed_count: report.closedCount,
        qty_adjusted_count: report.qtyAdjustedCount,
        details
    });

    if (SYNC_REPORT_AS_AI_LOG) {
        await saveAILog({
            decision: 'HOLD',
            sentiment_score: clamp(report.mismatches * 10, 0, 100),
            analysis_reason: `[SYNC-REPORT] ${details}`,
            is_simulated: DRY_RUN
        });
    }

    console.log(`🧾 동기화 리포트: ${details}`);
    console.log('✅ 계좌-DB 동기화 점검 완료');
    return report;
}

function combineDecision(aiResult, technicalSignal) {
    const aiScore = aiResult.decision === 'BUY'
        ? aiResult.percentage
        : aiResult.decision === 'SELL'
            ? -aiResult.percentage
            : 0;

    const techScore = technicalSignal.decision === 'BUY'
        ? technicalSignal.confidence
        : technicalSignal.decision === 'SELL'
            ? -technicalSignal.confidence
            : 0;

    // 공격형 테스트 모드에서는 기술신호 가중치를 높여 진입 기회를 늘린다.
    const wAi = AGGRESSIVE_TEST_MODE ? 0.4 : 0.55;
    const wTech = AGGRESSIVE_TEST_MODE ? 0.6 : 0.45;
    const combinedScore = aiScore * wAi + techScore * wTech;

    const aiNotBearish = aiResult.decision !== 'SELL';
    const aiNotBullish = aiResult.decision !== 'BUY';

    if (
        combinedScore >= ENTRY_SCORE_THRESHOLD
        || (
            technicalSignal.decision === 'BUY'
            && technicalSignal.confidence >= TECH_MIN_CONFIDENCE
            && aiNotBearish
            && aiResult.percentage >= BUY_CONFIDENCE_THRESHOLD
        )
    ) {
        return {
            finalDecision: 'BUY',
            reason: `가중 합산 점수 ${combinedScore.toFixed(1)}로 매수 진입 조건 충족`
        };
    }

    if (
        combinedScore <= -EXIT_SCORE_THRESHOLD
        || (
            technicalSignal.decision === 'SELL'
            && technicalSignal.confidence >= TECH_MIN_CONFIDENCE
            && aiNotBullish
            && aiResult.percentage >= SELL_CONFIDENCE_THRESHOLD
        )
    ) {
        return {
            finalDecision: 'SELL',
            reason: `가중 합산 점수 ${combinedScore.toFixed(1)}로 매도 조건 충족`
        };
    }

    return {
        finalDecision: 'HOLD',
        reason: `가중 합산 점수 ${combinedScore.toFixed(1)}가 관망 구간입니다.`
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
        const activeMarkets = await resolveTargetMarkets();
        if (!activeMarkets.length) {
            console.log('⚠️ 분석 대상 마켓이 없어 이번 루프를 종료합니다.');
            return;
        }

        const tickerByMarket = await fetchTickerByMarkets(activeMarkets, 'run-bot');
        const accountByCurrency = DRY_RUN
            ? new Map()
            : new Map((await getAccounts()).map((a) => [a.currency, a]));

        const sharedNews = '';

        for (const market of activeMarkets) {
            const ticker = tickerByMarket.get(market);
            if (!ticker) {
                console.log(`⚠️ 현재가 없음(${market}): 해당 마켓은 건너뜁니다.`);
                await sleep(MARKET_LOOP_DELAY_MS);
                continue;
            }

            const currentPrice = ticker.trade_price;
            console.log(`\n================ ${market} ================`);
            console.log(`📊 현재 가격: ${currentPrice.toLocaleString()}원`);

            const news = sharedNews;

            console.log(`📈 차트 데이터 수집 중... (${market})`);
            const chartData = await getChartData(market);
            const technicalSignal = getTechnicalSignal(chartData);

            console.log(`🧠 Gemini AI 분석 중... (${market})`);
            const aiResult = await getAIDecision(currentPrice, news, chartData, technicalSignal, market);

            const combined = combineDecision(aiResult, technicalSignal);
            let openPosition = await getOpenPosition(market, DRY_RUN);

            // 실계좌 상태를 우선 확인해 DB와 어긋났으면 즉시 복구/정리 후 이번 루프 거래는 건너뛴다.
            if (!DRY_RUN) {
                const currency = getBaseCurrency(market);
                const account = accountByCurrency.get(currency);
                const actualQty = Number(account?.balance || 0) + Number(account?.locked || 0);
                const avgBuyPrice = Number(account?.avg_buy_price || 0);

                if (actualQty > POSITION_SYNC_DUST_QTY && !openPosition) {
                    const entryPrice = avgBuyPrice > 0 ? avgBuyPrice : currentPrice;
                    const trailDistance = computeTrailingDistance(entryPrice, technicalSignal.atr);
                    const trailingStop = Math.max(entryPrice - trailDistance, 1);

                    await createOpenPosition({
                        market,
                        entry_price: entryPrice,
                        quantity_btc: actualQty,
                        invested_krw: actualQty * entryPrice,
                        highest_price: currentPrice,
                        trailing_stop_price: trailingStop,
                        atr_at_entry: technicalSignal.atr,
                        entry_reason: `[${market}] LIVE_GUARD_RECOVERY: 실계좌 보유분 반영`,
                        is_simulated: false,
                        take_profit_done: false
                    });

                    console.log(`🧩 [${market}] 실계좌 보유가 확인되어 DB 포지션을 복구했습니다. 이번 루프는 거래를 건너뜁니다.`);
                    await sleep(MARKET_LOOP_DELAY_MS);
                    continue;
                }

                if (actualQty <= POSITION_SYNC_DUST_QTY && openPosition) {
                    await closePosition(openPosition.id, currentPrice, `[${market}] LIVE_GUARD_SYNC: 실계좌 잔고 없음 확인`);
                    console.log(`🧩 [${market}] 실계좌 잔고가 없어 DB 포지션을 종료했습니다. 이번 루프는 거래를 건너뜁니다.`);
                    await sleep(MARKET_LOOP_DELAY_MS);
                    continue;
                }

                if (actualQty > POSITION_SYNC_DUST_QTY && openPosition) {
                    const dbQty = Number(openPosition.quantity_btc || 0);
                    const qtyGap = Math.abs(actualQty - dbQty);
                    const tolerance = Math.max(POSITION_SYNC_DUST_QTY, actualQty * 0.02);

                    if (qtyGap > tolerance) {
                        await updateOpenPosition(openPosition.id, {
                            quantity_btc: actualQty,
                            invested_krw: actualQty * Number(openPosition.entry_price)
                        });
                        console.log(`🧩 [${market}] 실계좌 수량 기준으로 DB 포지션을 보정했습니다. (gap=${qtyGap.toFixed(8)})`);
                        await sleep(MARKET_LOOP_DELAY_MS);
                        continue;
                    }
                }
            }

            console.log(`--- AI 분석: ${aiResult.decision} (${aiResult.percentage}%) ---`);
            console.log(`이유: ${aiResult.reason}`);
            console.log(`--- 기술 신호: ${technicalSignal.decision} (${technicalSignal.confidence}%) ---`);
            console.log(`요약: ${technicalSignal.reason}`);
            console.log(`--- 최종 의사결정: ${combined.finalDecision} ---`);
            console.log(`근거: ${combined.reason}`);

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

                    console.log(`📉 [청산:${market}] ${exitReason}`);

                    const exited = await executeExitFlow({
                        market,
                        currentPrice,
                        positionQty,
                        positionInvested,
                        positionId: openPosition.id,
                        exitReason
                    });

                    if (!exited) {
                        console.log(`⚠️ [${market}] 청산 실패로 포지션을 유지하고 다음 루프에서 재시도합니다.`);
                    }

                    await sleep(MARKET_LOOP_DELAY_MS);
                    continue;
                }

                const takeProfitPrice = entryPrice * (1 + (TAKE_PROFIT_PCT / 100));
                const takeProfitTriggered = !takeProfitDone && currentPrice >= takeProfitPrice;

                if (takeProfitTriggered) {
                    const partialRatio = clamp(TAKE_PROFIT_SELL_RATIO, 0.1, 0.9);
                    const partialQty = positionQty * partialRatio;
                    const limitPrice = computeTakeProfitLimitPrice(currentPrice, takeProfitPrice);

                    console.log(`💸 [부분익절:${market}] 목표가 도달: ${Math.round(takeProfitPrice).toLocaleString()}원 (${TAKE_PROFIT_PCT}%)`);

                    if (!DRY_RUN) {
                        const tpOrderStatus = await managePartialTakeProfitOrders(market);
                        if (tpOrderStatus.hasActiveFreshOrder) {
                            console.log(`⏳ [${market}] 이미 미체결 매도 주문이 있어 추가 부분익절 주문은 생략합니다.`);
                            await sleep(MARKET_LOOP_DELAY_MS);
                            continue;
                        }

                        const volume = await getMarketVolume(market);
                        const sellQty = Math.min(volume, partialQty);
                        if (sellQty > 0) {
                            const estimatedNotional = sellQty * limitPrice;
                            if (estimatedNotional < MIN_ORDER_KRW) {
                                console.log(`⚠️ [${market}] 부분익절 예상금액 ${Math.round(estimatedNotional)}원이 최소주문 ${MIN_ORDER_KRW}원 미만이라 생략합니다.`);
                                await updateOpenPosition(openPosition.id, {
                                    take_profit_done: true,
                                    highest_price: nextHighest,
                                    trailing_stop_price: nextStop
                                });
                                await sleep(MARKET_LOOP_DELAY_MS);
                                continue;
                            }

                            let sellRes;
                            try {
                                sellRes = await sellLimit(market, sellQty.toFixed(8), limitPrice);
                            } catch (error) {
                                console.error(`❌ 부분익절 주문 실패(${market}):`, error.response?.data || error.message);
                                await sleep(MARKET_LOOP_DELAY_MS);
                                continue;
                            }

                            console.log(`✅ 부분익절 지정가 주문 완료: ${limitPrice.toLocaleString()}원`, sellRes.uuid || '(uuid 없음)');

                            await sleep(LIMIT_FILL_CHECK_DELAY_MS);
                            const orderState = await getOrder(sellRes.uuid);
                            if (orderState?.state !== 'done') {
                                console.log(`⏳ [${market}] 부분익절 지정가가 아직 미체결(state=${orderState?.state || 'unknown'})입니다. 다음 루프에서 TTL 재호가를 검토합니다.`);
                                await sleep(MARKET_LOOP_DELAY_MS);
                                continue;
                            }

                            const executed = parseOrderExecution(orderState, currentPrice, sellQty);
                            if (executed.executedVolume <= POSITION_SYNC_DUST_QTY) {
                                console.log(`⚠️ [${market}] 체결수량이 0에 가까워 DB 반영을 보류합니다.`);
                                await sleep(MARKET_LOOP_DELAY_MS);
                                continue;
                            }

                            const costBasis = computeCostBasis(positionInvested, positionQty, executed.executedVolume);
                            const remainQty = Math.max(0, positionQty - executed.executedVolume);
                            const remainInvested = Math.max(0, positionInvested - costBasis);
                            const realizedPnl = executed.netProceeds - costBasis;

                            await saveTrade({
                                side: 'sell',
                                price: executed.avgPrice,
                                amount: executed.netProceeds,
                                reason: `[${market}] 부분익절 체결 | exec_qty=${executed.executedVolume.toFixed(8)} | fee=${Math.round(executed.paidFee)} | pnl=${Math.round(realizedPnl)} | limit=${limitPrice}`,
                                is_simulated: DRY_RUN
                            });

                            if (remainQty <= POSITION_SYNC_DUST_QTY) {
                                await closePosition(openPosition.id, executed.avgPrice, `[${market}] 부분익절 체결로 전량 종료 | pnl=${Math.round(realizedPnl)}`);
                                console.log(`✅ 부분익절 체결로 포지션 종료(${market})`);
                            } else {
                                await updateOpenPosition(openPosition.id, {
                                    quantity_btc: remainQty,
                                    invested_krw: remainInvested,
                                    take_profit_done: true,
                                    highest_price: nextHighest,
                                    trailing_stop_price: nextStop
                                });
                                console.log(`✅ 부분익절 체결 반영(${market}): exec=${executed.executedVolume.toFixed(8)} BTC, 잔여=${remainQty.toFixed(8)} BTC`);
                            }
                        } else {
                            console.log('⚠️ 부분익절 가능한 보유 수량이 없어 주문을 생략합니다.');
                            await sleep(MARKET_LOOP_DELAY_MS);
                            continue;
                        }
                    } else {
                        console.log('🧪 DRY_RUN 모드: 부분익절 주문은 생략했습니다.');

                        const remainQty = Math.max(0, positionQty - partialQty);
                        const partialInvested = computeCostBasis(positionInvested, positionQty, partialQty);
                        const remainInvested = Math.max(0, positionInvested - partialInvested);

                        await saveTrade({
                            side: 'sell',
                            price: currentPrice,
                            amount: partialInvested,
                            reason: `[${market}] 부분익절 ${Math.round(partialRatio * 100)}% 실행(지정가 ${limitPrice})`,
                            is_simulated: DRY_RUN
                        });

                        await updateOpenPosition(openPosition.id, {
                            quantity_btc: remainQty,
                            invested_krw: remainInvested,
                            take_profit_done: true,
                            highest_price: nextHighest,
                            trailing_stop_price: nextStop
                        });

                        console.log(`✅ 부분익절 완료(${market}): 잔여 수량=${remainQty.toFixed(8)} BTC`);
                    }

                    await sleep(MARKET_LOOP_DELAY_MS);
                    continue;
                }

                console.log(`🛡️ 보유 포지션 유지(${market}): 청산 조건이 아직 충족되지 않았습니다.`);
                await sleep(MARKET_LOOP_DELAY_MS);
                continue;
            }

            await saveAILog({
                decision: combined.finalDecision,
                sentiment_score: aiResult.percentage,
                analysis_reason: `[${market}] ${aiResult.reason} | TECH: ${technicalSignal.reason} | FINAL: ${combined.reason}`,
                is_simulated: DRY_RUN
            });

            if (combined.finalDecision === 'BUY') {
                if (!DRY_RUN) {
                    const openBidOrders = await getOpenOrders(market, 'bid');
                    if (openBidOrders.length > 0) {
                        console.log(`⏳ [${market}] 미체결 매수 주문(${openBidOrders.length}건)이 있어 신규 진입을 건너뜁니다.`);
                        await sleep(MARKET_LOOP_DELAY_MS);
                        continue;
                    }
                }

                const orderKrw = computeOrderSizeKrw(currentPrice, technicalSignal);
                const qty = orderKrw / currentPrice;
                const initialStop = currentPrice - computeTrailingDistance(currentPrice, technicalSignal.atr);

                console.log(`💰 [실행:${market}] 신규 진입: ${orderKrw.toLocaleString()}원 (변동성 기반) 매수 시도.`);

                if (!DRY_RUN) {
                    try {
                        const orderRes = await buyMarket(market, orderKrw);
                        console.log('✅ 매수 주문 완료:', orderRes.uuid || '(uuid 없음)');
                    } catch (error) {
                        console.error(`❌ 매수 주문 실패(${market}):`, error.response?.data || error.message);
                        await sleep(MARKET_LOOP_DELAY_MS);
                        continue;
                    }
                } else {
                    console.log('🧪 DRY_RUN 모드: 실제 주문은 생략했습니다.');
                }

                await saveTrade({
                    side: 'buy',
                    price: currentPrice,
                    amount: orderKrw,
                    reason: `[${market}] ${aiResult.reason} | ${technicalSignal.reason} | stop=${Math.round(initialStop)}`,
                    is_simulated: DRY_RUN
                });

                const createdPosition = await createOpenPosition({
                    market,
                    entry_price: currentPrice,
                    quantity_btc: qty,
                    invested_krw: orderKrw,
                    highest_price: currentPrice,
                    trailing_stop_price: initialStop,
                    atr_at_entry: technicalSignal.atr,
                    entry_reason: `[${market}] ${aiResult.reason} | ${technicalSignal.reason}`,
                    is_simulated: DRY_RUN,
                    take_profit_done: false
                });

                if (!createdPosition) {
                    console.log(`🚨 [${market}] DB 포지션 생성 실패. 다음 동기화 점검에서 실계좌 기준으로 복구를 시도합니다.`);
                } else {
                    console.log(`✅ 매수 기록 DB 저장 완료 (${market})`);
                }
            }
            else {
                console.log(`😴 [대기:${market}] 매매 조건이 충족되지 않았습니다.`);
            }

            await sleep(MARKET_LOOP_DELAY_MS);
        }

        if (!DRY_RUN) {
            const live = await getLiveAccountSummary();
            console.log('\n💼 ====== 1시간 실계좌 요약 ======');
            console.log(`총 투자금액(보유코인 매수원금): ${Math.round(live.totalInvested).toLocaleString()}원`);
            console.log(`번 돈(평가손익+): ${Math.round(live.totalEarned).toLocaleString()}원`);
            console.log(`잃은 돈(평가손익-): ${Math.round(live.totalLost).toLocaleString()}원`);
            console.log(`원화 잔고(가용+주문중): ${Math.round(live.krwTotal).toLocaleString()}원`);
            console.log(`코인 평가금액: ${Math.round(live.coinEvalTotal).toLocaleString()}원`);
            console.log(`총 자산 평가금액: ${Math.round(live.totalAssetValue).toLocaleString()}원`);
            console.log(`미실현 손익: ${Math.round(live.unrealizedPnl).toLocaleString()}원`);
            console.log('================================\n');
        } else {
            console.log('\n💼 DRY_RUN 모드에서는 실계좌 요약을 생략합니다.\n');
        }
    } catch (err) {
        console.error('❌ 봇 실행 중 치명적 오류:', err.response?.data || err.message);
    }
}

let isRunning = false;
let isMonitorRunning = false;
let isSyncRunning = false;
let hasCompletedInitialSync = !BLOCK_TRADING_UNTIL_SYNC;

async function runBotSafely() {
    if (BLOCK_TRADING_UNTIL_SYNC && !hasCompletedInitialSync) {
        console.log('🛑 초기 동기화 완료 전이라 매매 루프를 건너뜁니다.');
        return;
    }

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

async function runPriceMonitor() {
    try {
        const activeMarkets = await resolveTargetMarkets();
        if (!activeMarkets.length) {
            return;
        }

        const tickerByMarket = await fetchTickerByMarkets(activeMarkets, 'price-monitor');

        for (const market of activeMarkets) {
            const openPosition = await getOpenPosition(market, DRY_RUN);
            if (!openPosition) {
                await sleep(MARKET_LOOP_DELAY_MS);
                continue;
            }

            const ticker = tickerByMarket.get(market);
            if (!ticker) {
                console.log(`⚠️ 모니터링 현재가 없음(${market})`);
                await sleep(MARKET_LOOP_DELAY_MS);
                continue;
            }

            const currentPrice = Number(ticker.trade_price);
            const positionQty = Number(openPosition.quantity_btc);
            const positionInvested = Number(openPosition.invested_krw);
            const entryPrice = Number(openPosition.entry_price);
            const takeProfitDone = Boolean(openPosition.take_profit_done);
            const prevHighest = Number(openPosition.highest_price);
            const prevStop = Number(openPosition.trailing_stop_price);
            const nextHighest = Math.max(prevHighest, currentPrice);
            const trailDistance = computeTrailingDistance(currentPrice, Number(openPosition.atr_at_entry));
            const recalculatedStop = nextHighest - trailDistance;
            const nextStop = Math.max(prevStop, recalculatedStop);

            if (nextHighest !== prevHighest || Math.abs(nextStop - prevStop) > 0.1) {
                await updateOpenPosition(openPosition.id, {
                    highest_price: nextHighest,
                    trailing_stop_price: nextStop
                });
            }

            const stopTriggered = currentPrice <= nextStop;

            if (stopTriggered) {
                const exitReason = `모니터링 트레일링 스탑 발동: 현재가(${Math.round(currentPrice)}) <= 스탑(${Math.round(nextStop)})`;
                console.log(`📉 [모니터링 청산:${market}] ${exitReason}`);

                const exited = await executeExitFlow({
                    market,
                    currentPrice,
                    positionQty,
                    positionInvested,
                    positionId: openPosition.id,
                    exitReason
                });

                if (!exited) {
                    console.log(`⚠️ [${market}] 모니터링 청산 실패로 포지션을 유지하고 다음 루프에서 재시도합니다.`);
                }

                await sleep(MARKET_LOOP_DELAY_MS);
                continue;
            }

            const takeProfitPrice = entryPrice * (1 + (TAKE_PROFIT_PCT / 100));
            const takeProfitTriggered = !takeProfitDone && currentPrice >= takeProfitPrice;

            if (takeProfitTriggered) {
                const partialRatio = clamp(TAKE_PROFIT_SELL_RATIO, 0.1, 0.9);
                const partialQty = positionQty * partialRatio;
                const limitPrice = computeTakeProfitLimitPrice(currentPrice, takeProfitPrice);

                console.log(`💸 [모니터링 부분익절:${market}] 목표가 도달: ${Math.round(takeProfitPrice).toLocaleString()}원 (${TAKE_PROFIT_PCT}%)`);

                if (!DRY_RUN) {
                    const tpOrderStatus = await managePartialTakeProfitOrders(market);
                    if (tpOrderStatus.hasActiveFreshOrder) {
                        console.log(`⏳ [${market}] 이미 미체결 매도 주문이 있어 추가 부분익절 주문은 생략합니다.`);
                        await sleep(MARKET_LOOP_DELAY_MS);
                        continue;
                    }

                    const volume = await getMarketVolume(market);
                    const sellQty = Math.min(volume, partialQty);
                    if (sellQty > 0) {
                        const estimatedNotional = sellQty * limitPrice;
                        if (estimatedNotional < MIN_ORDER_KRW) {
                            console.log(`⚠️ [${market}] 모니터링 부분익절 예상금액 ${Math.round(estimatedNotional)}원이 최소주문 ${MIN_ORDER_KRW}원 미만이라 생략합니다.`);
                            await updateOpenPosition(openPosition.id, {
                                take_profit_done: true,
                                highest_price: nextHighest,
                                trailing_stop_price: nextStop
                            });
                            await sleep(MARKET_LOOP_DELAY_MS);
                            continue;
                        }

                        let sellRes;
                        try {
                            sellRes = await sellLimit(market, sellQty.toFixed(8), limitPrice);
                        } catch (error) {
                            console.error(`❌ 모니터링 부분익절 주문 실패(${market}):`, error.response?.data || error.message);
                            await sleep(MARKET_LOOP_DELAY_MS);
                            continue;
                        }

                        console.log(`✅ 모니터링 부분익절 지정가 주문 완료: ${limitPrice.toLocaleString()}원`, sellRes.uuid || '(uuid 없음)');

                        await sleep(LIMIT_FILL_CHECK_DELAY_MS);
                        const orderState = await getOrder(sellRes.uuid);
                        if (orderState?.state !== 'done') {
                            console.log(`⏳ [${market}] 부분익절 지정가가 아직 미체결(state=${orderState?.state || 'unknown'})입니다. 다음 루프에서 TTL 재호가를 검토합니다.`);
                            await sleep(MARKET_LOOP_DELAY_MS);
                            continue;
                        }

                        const executed = parseOrderExecution(orderState, currentPrice, sellQty);
                        if (executed.executedVolume <= POSITION_SYNC_DUST_QTY) {
                            console.log(`⚠️ [${market}] 체결수량이 0에 가까워 DB 반영을 보류합니다.`);
                            await sleep(MARKET_LOOP_DELAY_MS);
                            continue;
                        }

                        const costBasis = computeCostBasis(positionInvested, positionQty, executed.executedVolume);
                        const remainQty = Math.max(0, positionQty - executed.executedVolume);
                        const remainInvested = Math.max(0, positionInvested - costBasis);
                        const realizedPnl = executed.netProceeds - costBasis;

                        await saveTrade({
                            side: 'sell',
                            price: executed.avgPrice,
                            amount: executed.netProceeds,
                            reason: `[${market}] 모니터링 부분익절 체결 | exec_qty=${executed.executedVolume.toFixed(8)} | fee=${Math.round(executed.paidFee)} | pnl=${Math.round(realizedPnl)} | limit=${limitPrice}`,
                            is_simulated: DRY_RUN
                        });

                        if (remainQty <= POSITION_SYNC_DUST_QTY) {
                            await closePosition(openPosition.id, executed.avgPrice, `[${market}] 모니터링 부분익절 체결로 전량 종료 | pnl=${Math.round(realizedPnl)}`);
                            console.log(`✅ 모니터링 부분익절 체결로 포지션 종료(${market})`);
                        } else {
                            await updateOpenPosition(openPosition.id, {
                                quantity_btc: remainQty,
                                invested_krw: remainInvested,
                                take_profit_done: true,
                                highest_price: nextHighest,
                                trailing_stop_price: nextStop
                            });
                            console.log(`✅ 모니터링 부분익절 체결 반영(${market}): exec=${executed.executedVolume.toFixed(8)} BTC, 잔여=${remainQty.toFixed(8)} BTC`);
                        }
                    } else {
                        console.log('⚠️ 부분익절 가능한 보유 수량이 없어 주문을 생략합니다.');
                        await sleep(MARKET_LOOP_DELAY_MS);
                        continue;
                    }
                } else {
                    console.log('🧪 DRY_RUN 모드: 부분익절 주문은 생략했습니다.');

                    const remainQty = Math.max(0, positionQty - partialQty);
                    const partialInvested = computeCostBasis(positionInvested, positionQty, partialQty);
                    const remainInvested = Math.max(0, positionInvested - partialInvested);

                    await saveTrade({
                        side: 'sell',
                        price: currentPrice,
                        amount: partialInvested,
                        reason: `[${market}] 모니터링 부분익절 ${Math.round(partialRatio * 100)}% 실행(지정가 ${limitPrice})`,
                        is_simulated: DRY_RUN
                    });

                    await updateOpenPosition(openPosition.id, {
                        quantity_btc: remainQty,
                        invested_krw: remainInvested,
                        take_profit_done: true,
                        highest_price: nextHighest,
                        trailing_stop_price: nextStop
                    });
                }
            }

            await sleep(MARKET_LOOP_DELAY_MS);
        }
    } catch (err) {
        console.error('❌ 가격 모니터링 중 오류:', err.response?.data || err.message);
    }
}

async function runPriceMonitorSafely() {
    if (BLOCK_TRADING_UNTIL_SYNC && !hasCompletedInitialSync) {
        console.log('🛑 초기 동기화 완료 전이라 가격 모니터링 루프를 건너뜁니다.');
        return;
    }

    if (isMonitorRunning) {
        console.log('⏭️ 이전 가격 모니터링이 아직 진행 중이라 이번 스케줄은 건너뜁니다.');
        return;
    }

    isMonitorRunning = true;
    try {
        await runPriceMonitor();
    } finally {
        isMonitorRunning = false;
    }
}

async function runReconciliationSafely() {
    if (isSyncRunning) {
        console.log('⏭️ 이전 동기화 점검이 아직 진행 중이라 이번 점검은 건너뜁니다.');
        return false;
    }

    isSyncRunning = true;
    try {
        const report = await reconcilePositions();
        if (!hasCompletedInitialSync) {
            hasCompletedInitialSync = true;
            console.log('🔓 초기 동기화 완료: 이제 매수/매도 루프를 허용합니다.');
        }
        if (report) {
            console.log(`📣 일일 동기화 알림: 점검 ${report.checkedMarkets}개 마켓, 불일치 ${report.mismatches}건, 복구 ${report.recoveredCount}건, 종료 ${report.closedCount}건, 수량보정 ${report.qtyAdjustedCount}건`);
        }
        return true;
    } catch (err) {
        console.error('❌ 포지션 동기화 점검 중 오류:', err.response?.data || err.message);
        return false;
    } finally {
        isSyncRunning = false;
    }
}

if (RUN_ONCE) {
    (async () => {
        if (POSITION_SYNC_ON_START || BLOCK_TRADING_UNTIL_SYNC) {
            await runReconciliationSafely();
        }
        await runBotSafely();
    })();
} else {
    cron.schedule(BOT_CRON, async () => {
        console.log(`⏰ 정각 스케줄 실행(${BOT_CRON}): ${new Date().toLocaleString()}`);
        await runBotSafely();
    });

    cron.schedule(PRICE_MONITOR_CRON, async () => {
        await runPriceMonitorSafely();
    });

    cron.schedule(POSITION_SYNC_CRON, async () => {
        console.log(`🧭 포지션 동기화 점검 실행(${POSITION_SYNC_CRON}): ${new Date().toLocaleString()}`);
        await runReconciliationSafely();
    });

    console.log(`🤖 봇 대기 중... 스케줄러 작동 시작 (BOT_CRON=${BOT_CRON}, PRICE_MONITOR_CRON=${PRICE_MONITOR_CRON}, POSITION_SYNC_CRON=${POSITION_SYNC_CRON})`);
    (async () => {
        if (POSITION_SYNC_ON_START || BLOCK_TRADING_UNTIL_SYNC) {
            await runReconciliationSafely();
        } else {
            hasCompletedInitialSync = true;
        }
        await runBotSafely();
        await runPriceMonitorSafely();
    })();

    if (AUTO_STOP_MINUTES > 0) {
        console.log(`⏳ 자동 종료 예약: ${AUTO_STOP_MINUTES}분 후 프로세스를 종료합니다.`);
        setTimeout(() => {
            console.log('🛑 테스트 시간이 종료되어 봇을 종료합니다.');
            process.exit(0);
        }, AUTO_STOP_MINUTES * 60 * 1000);
    }
}