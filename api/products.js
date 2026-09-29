export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!token || !locationId) {
    return res.status(500).json({ error: 'Square environment variables missing.' });
  }

  try {
    // 1. Fetch catalog items from Square
    const catalogRes = await fetch('https://connect.squareup.com/v2/catalog/list?types=ITEM', {
      headers: {
        'Square-Version': '2024-09-19',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const catalogData = await catalogRes.json();
    if (!catalogRes.ok) throw new Error(catalogData.errors?.[0]?.detail || 'Failed to fetch catalog.');

    const items = (catalogData.objects || []).filter(obj => !obj.is_deleted);
    const variationIds = [];

    items.forEach(item => {
      item.item_data?.variations?.forEach(v => variationIds.push(v.id));
    });

    // 2. Fetch live inventory counts
    let stockMap = {};
    if (variationIds.length > 0) {
      const invRes = await fetch('https://connect.squareup.com/v2/inventory/counts/batch-retrieve', {
        method: 'POST',
        headers: {
          'Square-Version': '2024-09-19',
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          catalog_object_ids: variationIds,
          location_ids: [locationId]
        })
      });

      const invData = await invRes.json();
      if (invRes.ok && invData.counts) {
        invData.counts.forEach(c => {
          if (c.state === 'IN_STOCK') {
            stockMap[c.catalog_object_id] = parseInt(c.quantity, 10);
          }
        });
      }
    }

    // 3. Format into a clean response
    const products = items.map(item => {
      const d = item.item_data;
      const v = d.variations?.[0];
      const varId = v?.id;
      const priceCents = v?.item_variation_data?.price_money?.amount || 0;
      const stock = stockMap[varId] !== undefined ? stockMap[varId] : 0;
      const desc = d.description || '';

      const isTrio = d.name.includes('(4 oz)') || d.name.includes('(2 oz)');

      return {
        id: item.id,
        variationId: varId,
        name: d.name,
        price: priceCents / 100,
        stock: stock,
        isAvailable: stock > 0,
        description: desc,
        category: isTrio ? 'jar_trio' : 'standard'
      };
    });

    // Cache on Vercel for 60 seconds so it's super fast
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(products);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
