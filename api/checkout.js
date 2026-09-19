import { Client, Environment } from 'square';
import crypto from 'crypto';

const isProduction = process.env.SQUARE_ENVIRONMENT !== 'sandbox';

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: isProduction ? Environment.Production : Environment.Sandbox,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const {
      name,
      email,
      phone,
      fulfillment,
      items,
      deliveryFee,
      notes,
    } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    // 1. Build line items for Square (in cents)
    const lineItems = items.map((item) => ({
      name: item.name,
      quantity: String(item.qty),
      basePriceMoney: {
        amount: Math.round(item.price * 100),
        currency: 'USD',
      },
    }));

    // 2. Compute 3-for-$24 Bundle Discount ($3 off per 3-pack of eligible $9 items)
    let bundleItemCount = 0;
    items.forEach((item) => {
      if (item.isBundle) {
        bundleItemCount += item.qty;
      }
    });

    const bundleSets = Math.floor(bundleItemCount / 3);
    const discounts = [];

    if (bundleSets > 0) {
      discounts.push({
        name: `3-for-$24 Bundle Savings (${bundleSets} set${bundleSets > 1 ? 's' : ''})`,
        amountMoney: {
          amount: bundleSets * 300, // $3.00 in cents
          currency: 'USD',
        },
        scope: 'ORDER',
      });
    }

    // 3. Add Delivery Fee as a service charge if applicable
    const serviceCharges = [];
    if (deliveryFee && Number(deliveryFee) > 0) {
      serviceCharges.push({
        name: 'Local Hand-Delivery Fee',
        amountMoney: {
          amount: Math.round(Number(deliveryFee) * 100),
          currency: 'USD',
        },
        calculationPhase: 'SUBTOTAL_PHASE',
      });
    }

    // 4. Format phone number to E.164 (+1XXXXXXXXXX) for Square
    let formattedPhone = undefined;
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 10) {
        formattedPhone = `+1${digits}`;
      } else if (digits.length === 11 && digits.startsWith('1')) {
        formattedPhone = `+${digits}`;
      }
    }

    // 5. Order notes / summary for merchant dashboard
    const noteDetails = [
      `Customer: ${name}`,
      phone ? `Phone: ${phone}` : null,
      `Fulfillment: ${fulfillment}`,
      notes ? `Customer Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    // 6. Create Payment Link
    const idempotencyKey = crypto.randomUUID();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const siteUrl = `${protocol}://${host}`;

    const payload = {
      idempotencyKey,
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems,
        discounts: discounts.length ? discounts : undefined,
        serviceCharges: serviceCharges.length ? serviceCharges : undefined,
        pricingOptions: {
          autoApplyDiscounts: false,
        },
      },
      checkoutOptions: {
        askForShippingAddress: false,
        redirectUrl: `${siteUrl}/order-confirmation.html`,
      },
      prePopulatedData: {
        buyerEmail: email || undefined,
        buyerPhoneNumber: formattedPhone,
      },
      description: noteDetails.substring(0, 500),
    };

    const response = await client.checkoutApi.createPaymentLink(payload);
    const checkoutUrl = response.result.paymentLink.url;

    return res.status(200).json({ checkoutUrl });
  } catch (error) {
    console.error('Square Checkout Error:', error);

    // If Square provided structured API error details, pass back the exact reason
    if (error.errors && error.errors.length) {
      const detail = error.errors.map((e) => `${e.category}: ${e.detail}`).join('; ');
      return res.status(400).json({ error: detail });
    }

    return res.status(500).json({
      error: error.message || 'Unable to generate Square checkout link.',
    });
  }
}
