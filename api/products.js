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

    // Filter out deleted or inactive items
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

    // 3. Process and format products cleanly
    const products = [];

    rawItems.forEach(item => {
      const parentData = item.item_data;
      const parentName = (parentData.name || '').trim();
      const parentDesc = (parentData.description || '').trim();
      const variations = parentData.variations || [];

      // Extract "Pair with:" helper text if you added it to the item description
      const pairMatch = parentDesc.match(/Pair with:\s*(.*)/i);
      const pairWith = pairMatch ? pairMatch[1].trim() : '';
      const cleanDesc = parentDesc.replace(/Pair with:\s*.*$/i, '').trim();

      variations.forEach(v => {
        if (v.is_deleted) return;

        const vData = v.item_variation_data || {};
        const varName = (vData.name || '').trim();
        const priceCents = vData.price_money?.amount || 0;

        // Skip any ghost items with no price set
        if (priceCents <= 0) return;

        const stock = stockMap[v.id] !== undefined ? stockMap[v.id] : 0;

        // Construct a clean, human-readable display name
        let displayName = parentName;

        // If variation has a real name that isn't generic "Regular"
        if (varName && varName.toLowerCase() !== 'regular') {
          // If parent name is generic like "Jams & Compotes", use the flavor/variation name directly
          if (parentName.toLowerCase().includes('&') || parentName.toLowerCase() === 'provisions' || parentName.toLowerCase() === 'jams') {
            displayName = varName;
          } 
          // If parent name already includes the variation name, don't repeat it
          else if (parentName.toLowerCase().includes(varName.toLowerCase())) {
            displayName = parentName;
          } 
          // Otherwise, nicely format as "Item Name (Variation/Size)"
          else {
            displayName = `${parentName} (${varName})`;
          }
        }

        // Clean up any double-parentheses like "Item (4 oz) (4 oz)"
        displayName = displayName.replace(/\(([^)]+)\)\s*\(\1\)/gi, '($1)').trim();

        // 3 for $18 eligibility (any 4oz or 2oz items)
        const isTrio = /4\s*oz|2\s*oz/i.test(displayName);

        products.push({
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

    // Sort alphabetically
    products.sort((a, b) => a.name.localeCompare(b.name));

    // Cache on Vercel for 30 seconds
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
    return res.status(200).json(products);

  } catch (err) {
    console.error('Square Sync Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
