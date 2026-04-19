// order.js
require('dotenv').config();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const querystring = require('querystring');

const access_key = process.env.UPBIT_ACCESS_KEY;
const secret_key = process.env.UPBIT_SECRET_KEY;

function validateOrderEnv() {
    if (!access_key || !secret_key) {
        throw new Error('UPBIT_ACCESS_KEY/UPBIT_SECRET_KEY가 설정되어야 합니다.');
    }
}

function buildToken(payloadData = {}) {
    const payload = {
        access_key: access_key,
        nonce: uuidv4(),
        ...payloadData
    };
    return jwt.sign(payload, secret_key);
}

async function requestUpbit(method, path, options = {}) {
    validateOrderEnv();

    const params = options.params || null;
    const body = options.body || null;

    const queryObject = method === 'GET' ? params : body;
    const tokenPayload = {};

    if (queryObject && Object.keys(queryObject).length > 0) {
        const query = querystring.stringify(queryObject);
        const hash = crypto.createHash('sha512');
        const queryHash = hash.update(query, 'utf-8').digest('hex');
        tokenPayload.query_hash = queryHash;
        tokenPayload.query_hash_alg = 'SHA512';
    }

    const token = buildToken(tokenPayload);

    return axios({
        method,
        url: `https://api.upbit.com${path}`,
        headers: {
            Authorization: `Bearer ${token}`
        },
        params,
        data: body
    });
}

// 시장가 매수 함수
async function buyMarket(market, amount) {
    const normalizedAmount = Number(amount);
    const body = {
        market: market,
        side: 'bid', // 매수
        price: String(normalizedAmount), // 시장가 매수 시에는 'price'가 주문 총액
        ord_type: 'price', // 시장가 매수
    };

    try {
        const res = await requestUpbit('POST', '/v1/orders', { body });
        return res.data;
    } catch (error) {
        console.error("❌ 매수 주문 에러:", error.response?.data || error.message);
        throw error;
    }
}

// 시장가 매도 함수 (전량 매도)
async function sellMarket(market, volume) {
    const normalizedVolume = Number(volume);
    const body = {
        market: market,
        side: 'ask', // 매도
        volume: String(normalizedVolume), // 매도 수량
        ord_type: 'market', // 시장가 매도
    };

    try {
        const res = await requestUpbit('POST', '/v1/orders', { body });
        return res.data;
    } catch (error) {
        console.error("❌ 매도 주문 에러:", error.response?.data || error.message);
        throw error;
    }
}

// 지정가 매도 함수
async function sellLimit(market, volume, price) {
    const normalizedVolume = Number(volume);
    const normalizedPrice = Number(price);
    const body = {
        market: market,
        side: 'ask', // 매도
        volume: String(normalizedVolume), // 매도 수량
        price: String(normalizedPrice), // 지정가
        ord_type: 'limit' // 지정가 매도
    };

    try {
        const res = await requestUpbit('POST', '/v1/orders', { body });
        return res.data;
    } catch (error) {
        console.error('❌ 지정가 매도 주문 에러:', error.response?.data || error.message);
        throw error;
    }
}

// 미체결 주문 조회 함수
async function getOpenOrders(market, side = null) {
    const params = {
        market,
        state: 'wait'
    };

    if (side) {
        params.side = side;
    }

    try {
        const res = await requestUpbit('GET', '/v1/orders', { params });
        return Array.isArray(res.data) ? res.data : [];
    } catch (error) {
        console.error('❌ 미체결 주문 조회 에러:', error.response?.data || error.message);
        return [];
    }
}

// 주문 취소 함수
async function cancelOrder(uuid) {
    try {
        const res = await requestUpbit('DELETE', '/v1/order', {
            params: { uuid }
        });
        return res.data;
    } catch (error) {
        console.error('❌ 주문 취소 에러:', error.response?.data || error.message);
        throw error;
    }
}

// 단일 주문 상태 조회 함수
async function getOrder(uuid) {
    try {
        const res = await requestUpbit('GET', '/v1/order', {
            params: { uuid }
        });
        return res.data;
    } catch (error) {
        console.error('❌ 주문 상태 조회 에러:', error.response?.data || error.message);
        return null;
    }
}

async function getAccounts() {
    try {
        const res = await requestUpbit('GET', '/v1/accounts');
        return res.data;
    } catch (error) {
        console.error('❌ 계좌 조회 에러:', error.response?.data || error.message);
        throw error;
    }
}

async function getMarketVolume(market) {
    const baseCurrency = market.split('-')[1];
    const accounts = await getAccounts();
    const target = accounts.find((a) => a.currency === baseCurrency);
    if (!target) return 0;

    return Number(target.balance || 0);
}

async function getLiveAccountSummary() {
    const accounts = await getAccounts();

    const krwAccount = accounts.find((a) => a.currency === 'KRW');
    const krwAvailable = Number(krwAccount?.balance || 0);
    const krwLocked = Number(krwAccount?.locked || 0);
    const krwTotal = krwAvailable + krwLocked;

    const holdings = accounts
        .map((a) => {
            const qty = Number(a.balance || 0) + Number(a.locked || 0);
            return {
                currency: a.currency,
                unitCurrency: a.unit_currency,
                qty,
                avgBuyPrice: Number(a.avg_buy_price || 0)
            };
        })
        .filter((h) => h.currency !== 'KRW' && h.unitCurrency === 'KRW' && h.qty > 0);

    const markets = holdings.map((h) => `KRW-${h.currency}`);
    const priceByMarket = new Map();

    if (markets.length > 0) {
        try {
            const tickerRes = await axios.get(`https://api.upbit.com/v1/ticker?markets=${markets.join(',')}`);
            for (const t of tickerRes.data || []) {
                priceByMarket.set(t.market, Number(t.trade_price || 0));
            }
        } catch (error) {
            console.error('⚠️ 평가가격 조회 실패(일부):', error.response?.data || error.message);
        }
    }

    let coinEvalTotal = 0;
    let coinCostTotal = 0;

    for (const h of holdings) {
        const market = `KRW-${h.currency}`;
        const currentPrice = priceByMarket.get(market) || h.avgBuyPrice;
        const evalValue = h.qty * currentPrice;
        const costValue = h.qty * h.avgBuyPrice;
        coinEvalTotal += evalValue;
        coinCostTotal += costValue;
    }

    const unrealizedPnl = coinEvalTotal - coinCostTotal;

    return {
        krwAvailable,
        krwLocked,
        krwTotal,
        coinEvalTotal,
        coinCostTotal,
        totalInvested: coinCostTotal,
        totalEarned: unrealizedPnl > 0 ? unrealizedPnl : 0,
        totalLost: unrealizedPnl < 0 ? Math.abs(unrealizedPnl) : 0,
        unrealizedPnl,
        totalAssetValue: krwTotal + coinEvalTotal
    };
}

module.exports = {
    buyMarket,
    sellMarket,
    sellLimit,
    getOpenOrders,
    cancelOrder,
    getOrder,
    getAccounts,
    getMarketVolume,
    getLiveAccountSummary
};