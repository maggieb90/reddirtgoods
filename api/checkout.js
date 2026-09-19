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

    // 1. Build line items for Square (converted to cents)
    const lineItems = items.map((item) => ({
      name: item.name,
      quantity: String(item.qty),
      basePriceMoney: {
        amount: Math.round(Number(item.price) * 100),
        currency: 'USD',
      },
    }));

    // 2. Compute bundle discounts matching the printed flyer
    let shrubCount = 0;
    let relishCount = 0;
    const jarTrioPrices = [];

    items.forEach((item) => {
      if (item.category === 'shrub') shrubCount += item.qty;
      if (item.category === 'relish') relishCount += item.qty;
      if (item.category === 'jar_trio') {
        for (let i = 0; i < item.qty; i++) {
          jarTrioPrices.push(Number(item.price));
        }
      }
    });

    const discounts = [];

    // A. Shrub Special: 2 for $18 (Saves $2.00 per pair)
    const shrubPairs = Math.floor(shrubCount / 2);
    if (shrubPairs > 0) {
      discounts.push({
        name: `Fruit Shrub Bundle (2 for $18 x ${shrubPairs})`,
        amountMoney: {
          amount: shrubPairs * 200, // in cents
          currency: 'USD',
        },
        scope: 'ORDER',
      });
    }

    // B. Relish Special: 2 for $15 (Saves $1.00 per pair)
    const relishPairs = Math.floor(relishCount / 2);
    if (relishPairs > 0) {
      discounts.push({
        name: `Jalapeño Relish Bundle (2 for $15 x ${relishPairs})`,
        amountMoney: {
          amount: relishPairs * 100, // in cents
          currency: 'USD',
        },
        scope: 'ORDER',
      });
    }

    // C. 4oz/2oz Jar Trio Special: Any 3 for $18
    // Sort highest to lowest to calculate the exact discount to hit $18 per trio
    jarTrioPrices.sort((a, b) => b - a);
    const fullTrios = Math.floor(jarTrioPrices.length / 3);
    let totalJarSavingsCents = 0;

    for (let t = 0; t < fullTrios; t++) {
      const trioSum = jarTrioPrices[t * 3] + jarTrioPrices[t * 3 + 1] + jarTrioPrices[t * 3 + 2];
      const savings = trioSum - 18.00;
      if (savings > 0) {
        totalJarSavingsCents += Math.round(savings * 100);
      }
    }

    if (totalJarSavingsCents > 0) {
      discounts.push({
        name: `Market Jar Bundle (3 for $18 x ${fullTrios})`,
        amountMoney: {
          amount: totalJarSavingsCents,
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

    // 4. Clean and format phone number for Square (must be E.164 format: +1XXXXXXXXXX)
    let formattedPhone = undefined;
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 10) {
        formattedPhone = `+1${digits}`;
      } else if (digits.length === 11 && digits.startsWith('1')) {
        formattedPhone = `+${digits}`;
      }
    }

    // 5. Order details summary for merchant notification
    const noteDetails = [
      `Customer: ${name}`,
      phone ? `Phone: ${phone}` : null,
      `Fulfillment: ${fulfillment}`,
      notes ? `Customer Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    // 6. Create Square Payment Link
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

    if (error.errors && error.errors.length) {
      const detail = error.errors.map((e) => `${e.category}: ${e.detail}`).join('; ');
      return res.status(400).json({ error: detail });
    }

    return res.status(500).json({
      error: error.message || 'Unable to generate Square checkout link.',
    });
  }
}
