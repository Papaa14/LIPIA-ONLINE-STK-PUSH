const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

const transactions = {};
const idMap = {};

// 1. STK Push
app.post('/api/stk-push', async (req, res) => {
    const { phone, amount } = req.body;
    try {
        const response = await fetch('https://lipia-api.kreativelabske.com/api/v2/payments/stk-push', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.LIPIA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone_number: phone,
                amount: amount,
                // We send the reference as external_reference to help Lipia map it back
                external_reference: `REF_${Date.now()}`,
                callback_url: `${process.env.NGROK_URL}/api/payments/callback`
            })
        });

        const result = await response.json();
        console.log('--- INITIATION RESPONSE ---');
        console.log(JSON.stringify(result, null, 2));

        if (result.success) {
            const lipiaRef = result.data.TransactionReference;

            // Try to find the MerchantID in multiple possible locations
            const merchantId = result.data.MerchantRequestID ||
                (result.data.response && result.data.response.MerchantRequestID);

            transactions[lipiaRef] = { status: 'pending' };

            if (merchantId) {
                idMap[merchantId] = lipiaRef;
                console.log(`🔗 Linked MerchantID ${merchantId} to LipiaRef ${lipiaRef}`);
            }

            res.json({ success: true, transactionReference: lipiaRef });
        } else {
            res.status(400).json({ success: false, message: result.message });
        }
    } catch (error) {
        console.error('Push Error:', error);
        res.status(500).json({ success: false });
    }
});

// 2. Callback Listener
app.post('/api/payments/callback', (req, res) => {
    console.log('--- CALLBACK RECEIVED ---');
    const data = req.body.response || req.body;
    const status = (data.Status || '').toUpperCase();

    // Fallback: mark ANY pending transaction
    const pendingRef = Object.keys(transactions)
        .find(ref => transactions[ref].status === 'pending');

    if (pendingRef) {
        transactions[pendingRef].status =
            status === 'SUCCESS' ? 'completed' : 'failed';

        console.log(`✅ [Callback] Updated ${pendingRef} → ${transactions[pendingRef].status}`);
    } else {
        console.log('⚠️ [Callback] No pending transaction found');
    }


    res.status(200).send('OK');
});

// 3. Status Polling (The Hero)
app.get('/api/status/:ref', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ref = req.params.ref;

    // 1. Check local memory first
    if (transactions[ref] && transactions[ref].status !== 'pending') {
        return res.json({ status: transactions[ref].status });
    }

    // 2. If local is still 'pending', call Lipia Status API directly
    console.log(`🔍 Polling Lipia API for ${ref}...`);
    try {
        const response = await fetch(`https://lipia-api.kreativelabske.com/api/v2/payments/status?reference=${ref}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${process.env.LIPIA_API_KEY}` }
        });

        const result = await response.json();
        if (result.success && result.data && result.data.response) {
            const apiStatus = result.data.response.Status?.toUpperCase();
            console.log(`📡 Lipia API says status for ${ref} is: ${apiStatus}`);

            if (apiStatus === 'SUCCESS' || apiStatus === 'COMPLETED') {
                transactions[ref] = { status: 'completed' };
                return res.json({ status: 'completed' });
            }

            if (apiStatus === 'FAILED' || apiStatus === 'CANCELLED') {
                transactions[ref] = { status: 'failed' };
                return res.json({ status: 'failed' });
            }

        }
    } catch (err) {
        console.error("Poller API Error:", err.message);
    }

    res.json({ status: transactions[ref]?.status || 'pending' });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
