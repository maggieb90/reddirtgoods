// api/products.js
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

    const rawItems = (catalogData.objects || []).filter(obj => !obj.is_deleted && !obj.item_data?.is_archived);
    const variationIds = [];

    rawItems.forEach(item => {
      item.item_data?.variations?.forEach(v => {
        if (!v.is_deleted) variationIds.push(v.id);
      });
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

    // 3. Group by parent product
    const groupedProducts = [];

    rawItems.forEach(item => {
      const parentData = item.item_data;
      const parentName = (parentData.name || '').trim();
      const parentDesc = (parentData.description || '').trim();
      const variations = parentData.variations || [];

      const pairMatch = parentDesc.match(/Pair with:\s*(.*)/i);
      const pairWith = pairMatch ? pairMatch[1].trim() : '';
      const cleanDesc = parentDesc.replace(/Pair with:\s*.*$/i, '').trim();

      const validVariations = [];
      let totalStock = 0;

      variations.forEach(v => {
        if (v.is_deleted) return;

        const vData = v.item_variation_data || {};
        const priceCents = vData.price_money?.amount || 0;
        if (priceCents <= 0) return; // Skip dummy/unpriced variations

        const stock = stockMap[v.id] !== undefined ? stockMap[v.id] : 0;
        totalStock += stock;

        let varName = (vData.name || '').trim();
        if (!varName || varName.toLowerCase() === 'regular') {
          varName = 'Standard';
        }

        const isTrio = /4\s*oz|2\s*oz/i.test(varName) || /4\s*oz|2\s*oz/i.test(parentName);

        validVariations.push({
          variationId: v.id,
          name: varName,
          sku: vData.sku || '',
          price: priceCents / 100,
          stock: stock,
          isAvailable: stock > 0,
          category: isTrio ? 'jar_trio' : 'standard'
        });
      });

      if (validVariations.length === 0) return;

      // Sort variations lowest price to highest
      validVariations.sort((a, b) => a.price - b.price);

      groupedProducts.push({
        id: item.id,
        name: parentName,
        description: cleanDesc,
        pairWith: pairWith,
        totalStock: totalStock,
        isAvailable: totalStock > 0,
        variations: validVariations
      });
    });

    // In-stock items first, then alphabetically
    groupedProducts.sort((a, b) => {
      if (a.isAvailable === b.isAvailable) {
        return a.name.localeCompare(b.name);
      }
      return a.isAvailable ? -1 : 1;
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
    return res.status(200).json(groupedProducts);

  } catch (err) {
    console.error('Square Sync Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
