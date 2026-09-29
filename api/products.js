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
    // 1. Fetch all items and variations from Square
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

    // Collect all variation IDs across all product bundles
    items.forEach(item => {
      item.item_data?.variations?.forEach(v => {
        if (!v.is_deleted) variationIds.push(v.id);
      });
    });

    // 2. Fetch live inventory counts for every specific variation
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

    // 3. Unroll variations into individual product listings
    const individualProducts = [];

    items.forEach(item => {
      const parentData = item.item_data;
      const parentName = parentData.name || '';
      const parentDesc = parentData.description || '';
      const variations = parentData.variations || [];

      variations.forEach(v => {
        if (v.is_deleted) return;

        const vData = v.item_variation_data || {};
        const varName = vData.name || '';
        const priceCents = vData.price_money?.amount || 0;
        const stock = stockMap[v.id] !== undefined ? stockMap[v.id] : 0;

        // Build clean display name:
        // If variation is named "Regular", use parent name.
        // Otherwise, combine them cleanly (e.g. "Spiced Cranberry-Apple Jam (4 oz)")
        let displayName = '';
        if (!varName || varName.toLowerCase() === 'regular') {
          displayName = parentName;
        } else if (parentName.toLowerCase().includes('jam') || parentName.toLowerCase().includes('bundle') || parentName.toLowerCase().includes('provision')) {
          displayName = varName;
        } else {
          displayName = `${parentName} - ${varName}`;
        }

        // Determine if this item qualifies for the 3 for $18 trio (4oz or 2oz items)
        const isTrio = displayName.includes('4 oz') || displayName.includes('2 oz') || displayName.includes('4oz') || displayName.includes('2oz');

        // Extract pair-with notes if included in variation or item description
        const pairMatch = parentDesc.match(/Pair with:\s*(.*)/i);
        const pairWith = pairMatch ? pairMatch[1].trim() : '';
        const cleanDesc = parentDesc.replace(/Pair with:\s*.*$/i, '').trim();

        individualProducts.push({
          id: item.id,
          variationId: v.id,
          sku: vData.sku || '',
          name: displayName,
          price: priceCents / 100,
          stock: stock,
          isAvailable: stock > 0,
          description: cleanDesc,
          pairWith: pairWith,
          category: isTrio ? 'jar_trio' : 'standard'
        });
      });
    });

    // Sort alphabetically by name
    individualProducts.sort((a, b) => a.name.localeCompare(b.name));

    // Cache on Vercel for 60 seconds
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(individualProducts);

  } catch (err) {
    console.error('Square Sync Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
