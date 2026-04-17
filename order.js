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
    const body = {
        market: market,
        side: 'bid', // 매수
        price: amount, // 시장가 매수 시에는 'price'가 주문 총액
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
    const body = {
        market: market,
        side: 'ask', // 매도
        volume: volume, // 매도 수량
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

module.exports = { buyMarket, sellMarket, getAccounts, getMarketVolume };