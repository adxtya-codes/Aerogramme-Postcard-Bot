const express = require('express');
const Stripe = require('stripe');
const axios = require('axios');
require('dotenv').config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware for Stripe webhook signature verification
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

// Stripe webhook endpoint
app.post('/webhook/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            await handlePaymentSuccess(session);
            break;
        case 'payment_intent.payment_failed':
            const paymentIntent = event.data.object;
            await handlePaymentFailed(paymentIntent);
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
});

async function handlePaymentSuccess(session) {
    try {
        const orderId = session.metadata.order_id;
        
        // First, save the order data to sheets (this should only happen after payment)
        const orderData = {
            order_id: orderId,
            name: session.metadata.recipient_name,
            address: session.metadata.address,
            message: session.metadata.message,
            image_status: 'Image uploaded', // Image data not stored due to size limits
            timestamp: new Date().toISOString(),
            payment_status: 'paid',
            payment_date: new Date().toISOString(),
            stripe_session_id: session.id
        };
        
        // Save complete order to sheets
        await axios.post(process.env.SHEETBEST_API_URL, orderData);
        
        console.log(`Payment confirmed and order saved for: ${orderId}`);
        
        // Note: To send WhatsApp message back to user, you would need to:
        // 1. Store user phone numbers with order IDs in your database
        // 2. Import the WhatsApp client here or use a message queue
        // 3. Send success message to the user
        
    } catch (error) {
        console.error('Error handling payment success:', error);
    }
}

async function handlePaymentFailed(paymentIntent) {
    try {
        const orderId = paymentIntent.metadata.order_id;
        
        // Update Google Sheets with payment failure
        await axios.put(`${process.env.SHEETBEST_API_URL}/order_id/${orderId}`, {
            payment_status: 'failed',
            payment_failed_date: new Date().toISOString()
        });
        
        console.log(`Payment failed for order: ${orderId}`);
        
    } catch (error) {
        console.error('Error handling payment failure:', error);
    }
}

const PORT = process.env.WEBHOOK_PORT || 3001;
app.listen(PORT, () => {
    console.log(`Stripe webhook server running on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook/stripe`);
});
